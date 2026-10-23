/*
 * Windows 11 Web Server & REST API Engine
 * Serves the full Windows 11 web desktop interface and manages REST endpoints
 */

#include "win11_server.h"
#include <stdio.h>
#include <string.h>
#include <dirent.h>
#include <errno.h>
#include <stdlib.h>
#include <strings.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <time.h>
#include "esp_log.h"
#include "esp_system.h"
#include "esp_chip_info.h"
#include "esp_http_server.h"
#include "esp_heap_caps.h"
#include "esp_psram.h"
#include "esp_flash.h"
#include "esp_app_desc.h"
#include "esp_littlefs.h"
#include "esp_private/esp_clk.h"
#include "esp_timer.h"
#include "esp_netif.h"
#include "esp_wifi.h"
#include "driver/gpio.h"
#include "mbedtls/base64.h"
#include "nvs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/idf_additions.h"
#include "freertos/task.h"
#include "cJSON.h"
#include "auth_uac.h"
#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "thermal_monitor.h"
#include "ota_manager.h"
#include "app_platform.h"
#include "dns_adblock.h"
#include "profile_manager.h"
#include "system_control.h"

#define WEB_ROOT "/usb/www"
#define WEB_FILE_BUFFER_SIZE 1024
#define MEDIA_ROOT "/usb/media"
#define MEDIA_BUFFER_SIZE 2048
#define MEDIA_GPIO_COUNT 4
#define STORAGE_LIST_LIMIT 128
#define STORAGE_PREVIEW_LIMIT 16384
#define STORAGE_DOWNLOAD_BUFFER_SIZE 8192
#define STORAGE_UPLOAD_BUFFER_SIZE 2048
#define ACCOUNT_STATE_SLOT_A "/storage/account_a.json"
#define ACCOUNT_STATE_SLOT_B "/storage/account_b.json"
#define ACCOUNT_STATE_INDEX "/storage/account_state.idx"
#define LEGACY_ACCOUNT_STATE_SLOT_A "/usb/system/account_a.json"
#define LEGACY_ACCOUNT_STATE_SLOT_B "/usb/system/account_b.json"
#define LEGACY_ACCOUNT_STATE_INDEX "/usb/system/account_state.idx"
#define ACCOUNT_STATE_PARTITION_LABEL "storage"
#define ACCOUNT_STATE_MAX_BYTES (2 * 1024 * 1024)
#define ACCOUNT_STATE_JSON_MAX_DEPTH 64
#define ACCOUNT_STATE_MEMORY_RESERVE_BYTES (96 * 1024)
#define ACCOUNT_STATE_INTERNAL_RESERVE_BYTES (8 * 1024)

static const char *TAG = "WIN11_HTTP";
static httpd_handle_t s_server = NULL;
static char s_web_file_buffer[WEB_FILE_BUFFER_SIZE];
static portMUX_TYPE s_dns_adlist_update_mux = portMUX_INITIALIZER_UNLOCKED;
static bool s_dns_adlist_update_running;
static esp_err_t s_dns_adlist_update_result = ESP_OK;
static const gpio_num_t s_media_gpios[MEDIA_GPIO_COUNT] = {
    GPIO_NUM_4, GPIO_NUM_5, GPIO_NUM_6, GPIO_NUM_7
};
static bool s_media_gpio_initialized[MEDIA_GPIO_COUNT];
static int s_media_gpio_levels[MEDIA_GPIO_COUNT];
static uint32_t s_previous_idle_runtime[2];
static int64_t s_previous_cpu_sample_us;
static bool s_cpu_sample_initialized;

static const char *task_state_name(eTaskState state) {
    switch (state) {
        case eRunning: return "running";
        case eReady: return "ready";
        case eBlocked: return "blocked";
        case eSuspended: return "suspended";
        case eDeleted: return "deleted";
        default: return "unknown";
    }
}

static void add_task_snapshot(cJSON *root) {
#if CONFIG_FREERTOS_GENERATE_RUN_TIME_STATS
    cJSON_AddBoolToObject(root, "taskTraceAvailable", true);
#else
    cJSON_AddBoolToObject(root, "taskTraceAvailable", false);
#endif
    UBaseType_t task_count = uxTaskGetNumberOfTasks();
    if (task_count == 0) {
        cJSON_AddArrayToObject(root, "tasks");
        cJSON_AddNumberToObject(root, "taskCount", 0);
        return;
    }

    if ((size_t)task_count > SIZE_MAX / sizeof(TaskStatus_t)) {
        cJSON_AddStringToObject(root, "taskListError", "Task snapshot size overflow");
        cJSON_AddArrayToObject(root, "tasks");
        cJSON_AddNumberToObject(root, "taskCount", 0);
        return;
    }
    TaskStatus_t *task_status = calloc((size_t)task_count, sizeof(*task_status));
    if (task_status == NULL) {
        cJSON_AddStringToObject(root, "taskListError", "Not enough heap for a task snapshot");
        cJSON_AddArrayToObject(root, "tasks");
        cJSON_AddNumberToObject(root, "taskCount", 0);
        return;
    }

    uint32_t total_runtime = 0;
    UBaseType_t captured_count = uxTaskGetSystemState(task_status, task_count, &total_runtime);
    if (captured_count == 0) {
        free(task_status);
        cJSON_AddStringToObject(root, "taskListError", "Task list changed during sampling; retrying");
        cJSON_AddArrayToObject(root, "tasks");
        cJSON_AddNumberToObject(root, "taskCount", 0);
        return;
    }

    cJSON *tasks = cJSON_AddArrayToObject(root, "tasks");
    for (UBaseType_t i = 0; i < captured_count; i++) {
        cJSON *task = cJSON_CreateObject();
        cJSON_AddStringToObject(task, "name", task_status[i].pcTaskName);
        cJSON_AddNumberToObject(task, "taskNumber", task_status[i].xTaskNumber);
        cJSON_AddStringToObject(task, "state", task_state_name(task_status[i].eCurrentState));
        cJSON_AddNumberToObject(task, "priority", task_status[i].uxCurrentPriority);
        cJSON_AddNumberToObject(task, "coreAffinity", xTaskGetCoreID(task_status[i].xHandle));
        cJSON_AddNumberToObject(task, "stackHighWaterBytes",
                                task_status[i].usStackHighWaterMark * sizeof(StackType_t));
        cJSON_AddItemToArray(tasks, task);
    }
    cJSON_AddNumberToObject(root, "taskCount", captured_count);

    cJSON *core_load = cJSON_AddArrayToObject(root, "coreUtilizationPercent");
    int64_t now_us = esp_timer_get_time();
    int64_t elapsed_us = s_cpu_sample_initialized ? now_us - s_previous_cpu_sample_us : 0;
    if (core_load == NULL) {
        free(task_status);
        cJSON_AddStringToObject(root, "taskListError", "Not enough heap for CPU utilization snapshot");
        return;
    }
    for (BaseType_t core = 0; core < portNUM_PROCESSORS; core++) {
        TaskHandle_t idle_handle = xTaskGetIdleTaskHandleForCore(core);
        uint32_t idle_runtime = 0;
        bool idle_task_found = false;
        for (UBaseType_t i = 0; i < captured_count; i++) {
            if (task_status[i].xHandle == idle_handle) {
                idle_runtime = (uint32_t)task_status[i].ulRunTimeCounter;
                idle_task_found = true;
                break;
            }
        }
        if (idle_task_found && s_cpu_sample_initialized && elapsed_us > 0 && elapsed_us < 4290000000LL) {
            uint32_t idle_delta = idle_runtime - s_previous_idle_runtime[core];
            double utilization = 100.0 - (100.0 * idle_delta / (double)elapsed_us);
            if (utilization < 0.0) utilization = 0.0;
            if (utilization > 100.0) utilization = 100.0;
            cJSON_AddItemToArray(core_load, cJSON_CreateNumber(utilization));
        } else {
            cJSON_AddItemToArray(core_load, cJSON_CreateNull());
        }
        s_previous_idle_runtime[core] = idle_runtime;
    }
    s_previous_cpu_sample_us = now_us;
    s_cpu_sample_initialized = true;
    cJSON_AddNumberToObject(root, "runtimeStatsTotalUs", total_runtime);
    free(task_status);
}

static void add_gpio_snapshot(cJSON *root) {
    cJSON *gpios = cJSON_AddArrayToObject(root, "gpioOutputs");
    for (int i = 0; i < MEDIA_GPIO_COUNT; i++) {
        cJSON *gpio = cJSON_CreateObject();
        cJSON_AddNumberToObject(gpio, "pin", s_media_gpios[i]);
        cJSON_AddBoolToObject(gpio, "configured", s_media_gpio_initialized[i]);
        if (s_media_gpio_initialized[i]) {
            cJSON_AddNumberToObject(gpio, "level", gpio_get_level(s_media_gpios[i]));
        } else {
            cJSON_AddNullToObject(gpio, "level");
        }
        cJSON_AddItemToArray(gpios, gpio);
    }
}

static int media_gpio_index(int pin) {
    for (int i = 0; i < MEDIA_GPIO_COUNT; i++) {
        if ((int)s_media_gpios[i] == pin) {
            return i;
        }
    }
    return -1;
}

/* Handler: /api/system/stats */
static esp_err_t stats_handler(httpd_req_t *req) {
    httpd_resp_set_type(req, "application/json");

    usb_host_msc_info_t usb_info = {0};
    uint64_t usb_total_bytes = 0;
    uint64_t usb_filesystem_total_bytes = 0;
    uint64_t usb_filesystem_free_bytes = 0;
    bool usb_mounted = usb_host_msc_is_mounted();
    bool usb_filesystem_space_known = false;
    if (usb_host_msc_get_info(&usb_info) != ESP_OK) {
        memset(&usb_info, 0, sizeof(usb_info));
    }
    if (usb_mounted) {
        esp_err_t capacity_err = usb_host_msc_get_capacity(
            &usb_total_bytes, &usb_filesystem_total_bytes, &usb_filesystem_free_bytes);
        if (capacity_err == ESP_OK) {
            usb_filesystem_space_known = true;
        } else {
            ESP_LOGW(TAG, "Unable to read filesystem space for mounted USB drive: %s", esp_err_to_name(capacity_err));
        }
    }
    if (usb_total_bytes == 0) {
        usb_total_bytes = usb_info.capacity_bytes;
    }
    if (usb_filesystem_free_bytes > usb_filesystem_total_bytes) {
        usb_filesystem_free_bytes = 0;
        usb_filesystem_space_known = false;
    }

    cJSON *root = cJSON_CreateObject();
    if (root == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to allocate system snapshot");
    }
    esp_chip_info_t chip_info;
    esp_chip_info(&chip_info);
    const esp_app_desc_t *app_desc = esp_app_get_description();
    size_t psram_total = esp_psram_get_size();
    size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t internal_heap_total = heap_caps_get_total_size(MALLOC_CAP_INTERNAL);
    size_t internal_heap_free = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
    uint32_t flash_size = 0;
    esp_err_t flash_err = esp_flash_get_size(esp_flash_default_chip, &flash_size);

    cJSON_AddStringToObject(root, "chipModel", "ESP32-S3");
    cJSON_AddStringToObject(root, "firmwareVersion",
                            app_desc && app_desc->version[0] ? app_desc->version : "unknown");
    cJSON_AddStringToObject(root, "idfVersion",
                            app_desc && app_desc->idf_ver[0] ? app_desc->idf_ver : "unknown");
    cJSON_AddNumberToObject(root, "chipRevision", chip_info.revision);
    cJSON_AddNumberToObject(root, "cpuCores", chip_info.cores);
    cJSON_AddNumberToObject(root, "cpuFrequencyHz", esp_clk_cpu_freq());
    cJSON_AddNumberToObject(root, "uptimeSeconds", (double)esp_timer_get_time() / 1000000.0);
    cJSON_AddNumberToObject(root, "psramTotalBytes", psram_total);
    cJSON_AddNumberToObject(root, "psramFreeBytes", psram_free);
    cJSON_AddNumberToObject(root, "psramMinimumFreeBytes", heap_caps_get_minimum_free_size(MALLOC_CAP_SPIRAM));
    // cJSON_AddNumberToObject(root, "psramLargestBlockBytes", heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM));  // Disabled - can crash on heap corruption
    cJSON_AddNumberToObject(root, "internalHeapTotalBytes", internal_heap_total);
    cJSON_AddNumberToObject(root, "internalHeapFreeBytes", internal_heap_free);
    cJSON_AddNumberToObject(root, "internalHeapMinimumFreeBytes", heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL));
    // cJSON_AddNumberToObject(root, "internalHeapLargestBlockBytes", heap_caps_get_largest_block(MALLOC_CAP_INTERNAL));  // Disabled - can crash on heap corruption
    cJSON_AddBoolToObject(root, "flashSizeValid", flash_err == ESP_OK);
    if (flash_err == ESP_OK) {
        cJSON_AddNumberToObject(root, "flashSizeBytes", flash_size);
    } else {
        cJSON_AddNullToObject(root, "flashSizeBytes");
    }
    cJSON_AddNumberToObject(root, "usbTotalGb", (double)usb_total_bytes / (1024.0 * 1024.0 * 1024.0));
    if (usb_filesystem_space_known) {
        cJSON_AddNumberToObject(root, "usbFilesystemTotalBytes", (double)usb_filesystem_total_bytes);
        cJSON_AddNumberToObject(root, "usbFilesystemFreeBytes", (double)usb_filesystem_free_bytes);
        cJSON_AddNumberToObject(root, "usbUsedGb", (double)(usb_filesystem_total_bytes - usb_filesystem_free_bytes) / (1024.0 * 1024.0 * 1024.0));
        cJSON_AddNumberToObject(root, "usbUsedBytes", (double)(usb_filesystem_total_bytes - usb_filesystem_free_bytes));
    } else {
        cJSON_AddNullToObject(root, "usbFilesystemTotalBytes");
        cJSON_AddNullToObject(root, "usbFilesystemFreeBytes");
        cJSON_AddNullToObject(root, "usbUsedGb");
        cJSON_AddNullToObject(root, "usbUsedBytes");
    }
    cJSON_AddBoolToObject(root, "usbMounted", usb_mounted);
    cJSON_AddNumberToObject(root, "usbVid", usb_info.vendor_id);
    cJSON_AddNumberToObject(root, "usbPid", usb_info.product_id);
    cJSON_AddNumberToObject(root, "usbSectorSize", usb_info.sector_size);
    cJSON_AddNumberToObject(root, "usbTotalSectors", usb_info.sector_count);
    cJSON_AddNumberToObject(root, "usbCapacityBytes", (double)usb_info.capacity_bytes);
    cJSON_AddStringToObject(root, "usbManufacturer", usb_info.manufacturer);
    cJSON_AddStringToObject(root, "usbProduct", usb_info.product);
    cJSON_AddStringToObject(root, "usbSerialNumber", usb_info.serial_number);
    float temperature_celsius = 0;
    if (thermal_monitor_get_celsius(&temperature_celsius)) {
        cJSON_AddBoolToObject(root, "temperatureValid", true);
        cJSON_AddNumberToObject(root, "temperatureCelsius", temperature_celsius);
    } else {
        cJSON_AddBoolToObject(root, "temperatureValid", false);
        cJSON_AddNullToObject(root, "temperatureCelsius");
    }
    cJSON_AddBoolToObject(root, "stressTestRunning", thermal_monitor_is_load_test_running());
    cJSON_AddBoolToObject(root, "usbMounted", usb_mounted);
    cJSON_AddBoolToObject(root, "httpServerRunning", s_server != NULL);
    add_gpio_snapshot(root);
    add_task_snapshot(root);

    wifi_mode_t wifi_mode = WIFI_MODE_NULL;
    esp_err_t wifi_err = esp_wifi_get_mode(&wifi_mode);
    cJSON_AddBoolToObject(root, "wifiDriverStarted", wifi_err == ESP_OK);
    const char *wifi_mode_name = "unavailable";
    if (wifi_err == ESP_OK) {
        if (wifi_mode == WIFI_MODE_APSTA) wifi_mode_name = "AP + Station";
        else if (wifi_mode == WIFI_MODE_AP) wifi_mode_name = "Access Point";
        else if (wifi_mode == WIFI_MODE_STA) wifi_mode_name = "Station";
        else if (wifi_mode == WIFI_MODE_NULL) wifi_mode_name = "Off";
    }
    cJSON_AddStringToObject(root, "wifiMode", wifi_mode_name);
    wifi_ap_record_t connected_ap = {0};
    bool station_connected = wifi_err == ESP_OK &&
        (wifi_mode & WIFI_MODE_STA) != 0 &&
        esp_wifi_sta_get_ap_info(&connected_ap) == ESP_OK;
    cJSON_AddBoolToObject(root, "wifiStationConnected", station_connected);
    if (station_connected) {
        char ssid[sizeof(connected_ap.ssid) + 1] = {0};
        memcpy(ssid, connected_ap.ssid, sizeof(connected_ap.ssid));
        cJSON_AddStringToObject(root, "wifiStationSsid", ssid);
    } else {
        cJSON_AddNullToObject(root, "wifiStationSsid");
    }
    esp_netif_ip_info_t ip_info = {0};
    esp_netif_t *sta_netif = esp_netif_get_handle_from_ifkey("WIFI_STA_DEF");
    if (station_connected && sta_netif != NULL && esp_netif_get_ip_info(sta_netif, &ip_info) == ESP_OK) {
        char ip[16];
        snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ip_info.ip));
        cJSON_AddStringToObject(root, "wifiStationIp", ip);
    } else {
        cJSON_AddNullToObject(root, "wifiStationIp");
    }
    wifi_sta_list_t ap_stations = {0};
    if (wifi_err == ESP_OK && (wifi_mode & WIFI_MODE_AP) != 0 &&
        esp_wifi_ap_get_sta_list(&ap_stations) == ESP_OK) {
        cJSON_AddNumberToObject(root, "wifiApClientCount", ap_stations.num);
    } else {
        cJSON_AddNullToObject(root, "wifiApClientCount");
    }
    wifi_config_t ap_config = {0};
    if (wifi_err == ESP_OK && (wifi_mode & WIFI_MODE_AP) != 0 &&
        esp_wifi_get_config(WIFI_IF_AP, &ap_config) == ESP_OK) {
        char ap_ssid[sizeof(ap_config.ap.ssid) + 1] = {0};
        memcpy(ap_ssid, ap_config.ap.ssid, ap_config.ap.ssid_len);
        cJSON_AddStringToObject(root, "wifiApSsid", ap_ssid);
    } else {
        cJSON_AddNullToObject(root, "wifiApSsid");
    }
    esp_netif_t *ap_netif = esp_netif_get_handle_from_ifkey("WIFI_AP_DEF");
    if ((wifi_mode & WIFI_MODE_AP) != 0 && ap_netif != NULL &&
        esp_netif_get_ip_info(ap_netif, &ip_info) == ESP_OK) {
        char ip[16];
        snprintf(ip, sizeof(ip), IPSTR, IP2STR(&ip_info.ip));
        cJSON_AddStringToObject(root, "wifiApIp", ip);
    } else {
        cJSON_AddNullToObject(root, "wifiApIp");
    }

    cJSON *drivers = cJSON_AddArrayToObject(root, "drivers");
    cJSON *driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF Wi-Fi driver");
    cJSON_AddStringToObject(driver, "state", wifi_err == ESP_OK ? "started" : "unavailable");
    cJSON_AddStringToObject(driver, "details", wifi_mode_name);
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "USB Host MSC / FAT filesystem");
    cJSON_AddStringToObject(driver, "state", usb_mounted ? "mounted" : "not mounted");
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF HTTP server");
    cJSON_AddStringToObject(driver, "state", s_server != NULL ? "running" : "stopped");
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF temperature sensor driver");
    cJSON_AddStringToObject(driver, "state", thermal_monitor_get_celsius(&temperature_celsius) ? "available" : "unavailable");
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF GPIO driver (allowlisted outputs)");
    int configured_gpio_count = 0;
    for (int i = 0; i < MEDIA_GPIO_COUNT; i++) {
        configured_gpio_count += s_media_gpio_initialized[i] ? 1 : 0;
    }
    char gpio_details[40];
    snprintf(gpio_details, sizeof(gpio_details), "%d of %d pins configured", configured_gpio_count, MEDIA_GPIO_COUNT);
    cJSON_AddStringToObject(driver, "state", configured_gpio_count > 0 ? "active" : "available");
    cJSON_AddStringToObject(driver, "details", gpio_details);
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF FreeRTOS scheduler");
    cJSON_AddStringToObject(driver, "state", "running");
    cJSON_AddStringToObject(driver, "details", "Task and runtime snapshots enabled");
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF SPI flash driver");
    cJSON_AddStringToObject(driver, "state", flash_err == ESP_OK ? "available" : "unavailable");
    if (flash_err == ESP_OK) {
        cJSON_AddNumberToObject(driver, "detectedBytes", flash_size);
    }
    cJSON_AddItemToArray(drivers, driver);

    driver = cJSON_CreateObject();
    cJSON_AddStringToObject(driver, "name", "ESP-IDF PSRAM heap allocator");
    cJSON_AddStringToObject(driver, "state", psram_total > 0 ? "available" : "unavailable");
    cJSON_AddNumberToObject(driver, "totalBytes", psram_total);
    cJSON_AddNumberToObject(driver, "freeBytes", psram_free);
    cJSON_AddItemToArray(drivers, driver);

    const char *json_str = cJSON_PrintUnformatted(root);
    if (json_str == NULL) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode system snapshot");
    }
    esp_err_t send_err = httpd_resp_send(req, json_str, HTTPD_RESP_USE_STRLEN);
    cJSON_Delete(root);
    cJSON_free((void *)json_str);
    return send_err;
}

static esp_err_t thermal_stress_handler(httpd_req_t *req) {
    esp_err_t err = thermal_monitor_start_load_test();
    if (err == ESP_ERR_INVALID_STATE) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "A 10-second CPU load test is already running");
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Unable to start CPU load test: %s", esp_err_to_name(err));
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "Unable to start CPU load test");
    }
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, "{\"started\":true,\"durationSeconds\":10}");
}

static int hex_digit(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

static bool get_query_parameter(httpd_req_t *req, const char *key, char *value, size_t value_size) {
    size_t query_len = httpd_req_get_url_query_len(req);
    if (query_len == 0 || query_len >= 512) {
        return false;
    }
    char query[512];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK) {
        return false;
    }
    char encoded[256];
    if (httpd_query_key_value(query, key, encoded, sizeof(encoded)) != ESP_OK) {
        return false;
    }

    size_t out = 0;
    for (size_t i = 0; encoded[i] != '\0'; i++) {
        char decoded = encoded[i];
        if (decoded == '%') {
            int high = hex_digit(encoded[i + 1]);
            int low = encoded[i + 1] ? hex_digit(encoded[i + 2]) : -1;
            if (high < 0 || low < 0) return false;
            decoded = (char)((high << 4) | low);
            i += 2;
        } else if (decoded == '+') {
            decoded = ' ';
        }
        if (decoded == '\0' || out + 1 >= value_size) return false;
        value[out++] = decoded;
    }
    value[out] = '\0';
    return true;
}

static bool parse_decimal_u64(const char *text, uint64_t *value) {
    if (text == NULL || value == NULL || *text == '\0') {
        return false;
    }
    uint64_t parsed = 0;
    for (const unsigned char *p = (const unsigned char *)text; *p; p++) {
        if (*p < '0' || *p > '9') {
            return false;
        }
        uint32_t digit = *p - '0';
        if (parsed > (UINT64_MAX - digit) / 10) {
            return false;
        }
        parsed = parsed * 10 + digit;
    }
    *value = parsed;
    return true;
}

static bool is_safe_media_path(const char *path, bool allow_media_root) {
    static const char prefix[] = "/media";
    if (strncmp(path, prefix, sizeof(prefix) - 1) != 0 ||
        (path[sizeof(prefix) - 1] != '\0' && path[sizeof(prefix) - 1] != '/')) {
        return false;
    }
    if (!allow_media_root && path[sizeof(prefix) - 1] == '\0') return false;
    const char *segment = path + 1;
    for (const char *p = segment;; p++) {
        if (*p == '%' || *p == '\\' || *p == ':' || (*p != '\0' && (unsigned char)*p < 0x20)) return false;
        if (*p == '/' || *p == '\0') {
            size_t len = (size_t)(p - segment);
            if ((len == 1 && segment[0] == '.') ||
                (len == 2 && segment[0] == '.' && segment[1] == '.')) return false;
            if (*p == '\0') break;
            segment = p + 1;
        }
    }
    return true;
}

static bool is_safe_usb_path(const char *path) {
    if (path == NULL || path[0] != '/') return false;
    const char *segment = path + 1;
    for (const char *p = segment;; p++) {
        if (*p == '%' || *p == '\\' || *p == ':' || (*p != '\0' && (unsigned char)*p < 0x20)) return false;
        if (*p == '/' || *p == '\0') {
            size_t length = (size_t)(p - segment);
            if ((length == 1 && segment[0] == '.') ||
                (length == 2 && segment[0] == '.' && segment[1] == '.')) return false;
            if (*p == '\0') break;
            segment = p + 1;
        }
    }
    return true;
}

static bool get_base64_header(httpd_req_t *req, const char *header_name, char *value, size_t value_size);

static bool get_media_fs_path(httpd_req_t *req, char *fs_path, size_t fs_path_size, bool allow_root) {
    char relative[256];
    char logical[288];
    if ((!get_base64_header(req, "X-USB-Path", relative, sizeof(relative)) &&
         !get_query_parameter(req, "path", relative, sizeof(relative))) ||
        !is_safe_media_path(relative, allow_root)) {
        return false;
    }
    int len = snprintf(logical, sizeof(logical), "/usb%s", relative);
    return len > 0 && (size_t)len < sizeof(logical) &&
        usb_storage_map_resolve(logical, fs_path, fs_path_size) == ESP_OK;
}

static esp_err_t media_list_handler(httpd_req_t *req) {
    if (!usb_host_msc_is_mounted()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB storage is not mounted");
    }

    char dir_path[288];
    if (!get_media_fs_path(req, dir_path, sizeof(dir_path), true)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid media folder");
        return ESP_OK;
    }

    DIR *directory = opendir(dir_path);
    if (!directory) {
        httpd_resp_send_err(req, errno == ENOENT ? HTTPD_404_NOT_FOUND : HTTPD_500_INTERNAL_SERVER_ERROR,
                            "Unable to open media folder");
        return ESP_OK;
    }

    cJSON *items = cJSON_CreateArray();
    if (!items) {
        closedir(directory);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
    }
    struct dirent *entry;
    size_t entry_count = 0;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (entry_count++ >= 128) break;
        char entry_path[384];
        int path_len = snprintf(entry_path, sizeof(entry_path), "%s/%s", dir_path, entry->d_name);
        if (path_len <= 0 || (size_t)path_len >= sizeof(entry_path)) continue;
        struct stat st;
        if (stat(entry_path, &st) != 0) continue;

        char logical_path[MAP_PATH_MAX];
        bool is_directory;
        if (usb_storage_map_get_logical(entry_path, logical_path, sizeof(logical_path), &is_directory) != ESP_OK) {
            continue;
        }
        const char *relative = logical_path + strlen("/usb");
        const char *logical_name = strrchr(logical_path, '/');
        logical_name = logical_name ? logical_name + 1 : logical_path;
        cJSON *item = cJSON_CreateObject();
        if (!item) {
            cJSON_Delete(items);
            closedir(directory);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        }
        cJSON_AddStringToObject(item, "name", logical_name);
        cJSON_AddStringToObject(item, "path", relative);
        if (!is_directory) {
            cJSON_AddStringToObject(item, "sourcePath", entry_path + strlen("/usb"));
        }
        cJSON_AddBoolToObject(item, "isFolder", is_directory);
        cJSON_AddNumberToObject(item, "size", S_ISREG(st.st_mode) ? (double)st.st_size : 0);
        cJSON_AddItemToArray(items, item);
    }
    closedir(directory);
    const char *json = cJSON_PrintUnformatted(items);
    if (json == NULL) {
        cJSON_Delete(items);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode media listing");
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
    cJSON_free((void *)json);
    cJSON_Delete(items);
    return err;
}

static esp_err_t storage_list_handler(httpd_req_t *req) {
        if (!usb_host_msc_is_mounted()) {
            httpd_resp_set_status(req, "503 Service Unavailable");
            return httpd_resp_sendstr(req, "USB storage is not mounted");
        }
        char logical[MAP_PATH_MAX];
        if (!get_base64_header(req, "X-USB-Path", logical, sizeof(logical)) ||
            !is_safe_usb_path(logical)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid USB folder path");
            return ESP_OK;
        }
        char directory_path[MAP_PATH_MAX + 8];
        if (strcmp(logical, "/") == 0) {
            strlcpy(logical, "/usb", sizeof(logical));
        } else {
            int path_length = snprintf(directory_path, sizeof(directory_path), "/usb%s", logical);
            if (path_length <= 0 || (size_t)path_length >= sizeof(directory_path)) {
                httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB folder path exceeds the mapping limit");
                return ESP_OK;
            }
            if (strlcpy(logical, directory_path, sizeof(logical)) >= sizeof(logical)) {
                httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB folder path exceeds the mapping limit");
                return ESP_OK;
            }
        }
        if (usb_storage_map_resolve(logical, directory_path, sizeof(directory_path)) != ESP_OK) {
            httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "USB folder not found");
            return ESP_OK;
        }
        DIR *directory = opendir(directory_path);
        if (directory == NULL) {
            httpd_resp_send_err(req, errno == ENOENT ? HTTPD_404_NOT_FOUND : HTTPD_500_INTERNAL_SERVER_ERROR,
                                "Unable to open USB folder");
            return ESP_OK;
        }

        cJSON *root = cJSON_CreateObject();
        cJSON *items = cJSON_CreateArray();
        if (root == NULL || items == NULL) {
            cJSON_Delete(root);
            cJSON_Delete(items);
            closedir(directory);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        }
        size_t count = 0;
        bool truncated = false;
        struct dirent *entry;
        while ((entry = readdir(directory)) != NULL) {
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
            if (count >= STORAGE_LIST_LIMIT) {
                truncated = true;
                break;
            }
            char physical_entry[MAP_PATH_MAX + 8];
            int length = snprintf(physical_entry, sizeof(physical_entry), "%s/%s", directory_path, entry->d_name);
            if (length <= 0 || (size_t)length >= sizeof(physical_entry)) continue;
            struct stat status;
            if (stat(physical_entry, &status) != 0) continue;
            char logical_entry[MAP_PATH_MAX];
            bool is_directory;
            if (usb_storage_map_get_logical(physical_entry, logical_entry, sizeof(logical_entry),
                                            &is_directory) != ESP_OK) {
                continue;
            }
            const char *name = strrchr(logical_entry, '/');
            cJSON *item = cJSON_CreateObject();
            if (item == NULL) {
                cJSON_Delete(root);
                cJSON_Delete(items);
                closedir(directory);
                return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
            }
            cJSON_AddStringToObject(item, "name", name ? name + 1 : logical_entry);
            cJSON_AddStringToObject(item, "path", logical_entry);
            cJSON_AddBoolToObject(item, "isFolder", is_directory);
            cJSON_AddNumberToObject(item, "size", S_ISREG(status.st_mode) && status.st_size > 0
                                                       ? (double)status.st_size : 0);
            cJSON_AddItemToArray(items, item);
            count++;
        }
        closedir(directory);
        cJSON_AddStringToObject(root, "path", logical);
        cJSON_AddBoolToObject(root, "truncated", truncated);
        cJSON_AddItemToObject(root, "entries", items);
        const char *json = cJSON_PrintUnformatted(root);
        if (json == NULL) {
            cJSON_Delete(root);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode USB listing");
        }
        httpd_resp_set_type(req, "application/json");
        esp_err_t err = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
        cJSON_free((void *)json);
        cJSON_Delete(root);
        return err;
    }

static bool is_text_preview_path(const char *path) {
        const char *extension = strrchr(path, '.');
        if (extension == NULL) return false;
        static const char *const allowed[] = {
            ".txt", ".md", ".json", ".csv", ".log", ".ini", ".cfg",
            ".html", ".htm", ".app", ".webapp", ".css", ".js", ".ts", ".py", ".pyw", ".c", ".h",
            ".bat", ".ps1", ".xml", ".srt", ".vtt"
        };
        for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
            if (strcasecmp(extension, allowed[i]) == 0) return true;
        }
        return false;
    }

    static bool get_base64_header(httpd_req_t *req, const char *header_name, char *value, size_t value_size) {
        char encoded[512];
        if (value == NULL || value_size == 0 ||
            httpd_req_get_hdr_value_str(req, header_name, encoded, sizeof(encoded)) != ESP_OK) {
            return false;
        }
        size_t decoded_size = 0;
        int result = mbedtls_base64_decode((unsigned char *)value, value_size - 1, &decoded_size,
                                           (const unsigned char *)encoded, strlen(encoded));
        if (result != 0 || decoded_size == 0 || decoded_size >= value_size) {
            return false;
        }
        value[decoded_size] = '\0';
        return memchr(value, '\0', decoded_size) == NULL;
    }

    static esp_err_t storage_mutation_handler(httpd_req_t *req) {
        if (!usb_host_msc_is_mounted()) {
            httpd_resp_set_status(req, "503 Service Unavailable");
            return httpd_resp_sendstr(req, "USB storage is not mounted");
        }
        if (req->content_len <= 0 || req->content_len >= 1024) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid USB operation request");
        }
        char body[1024];
        size_t received_total = 0;
        while (received_total < (size_t)req->content_len) {
            int received = httpd_req_recv(req, body + received_total,
                                          (size_t)req->content_len - received_total);
            if (received <= 0) {
                return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete USB operation request");
            }
            received_total += (size_t)received;
        }
        body[received_total] = '\0';
        cJSON *request = cJSON_Parse(body);
        cJSON *action = cJSON_GetObjectItemCaseSensitive(request, "action");
        cJSON *path = cJSON_GetObjectItemCaseSensitive(request, "path");
        cJSON *name = cJSON_GetObjectItemCaseSensitive(request, "name");
        cJSON *password = cJSON_GetObjectItemCaseSensitive(request, "password");
        if (!cJSON_IsObject(request) || !cJSON_IsString(action) || !cJSON_IsString(path) ||
            !cJSON_IsString(password) || !is_safe_usb_path(path->valuestring)) {
            cJSON_Delete(request);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Malformed USB operation request");
        }
        if (!auth_verify_admin_password(password->valuestring)) {
            cJSON_Delete(request);
            httpd_resp_set_status(req, "403 Forbidden");
            return httpd_resp_sendstr(req, "Administrator authorization required");
        }
        char logical[MAP_PATH_MAX];
        int path_length = strcmp(path->valuestring, "/") == 0
            ? snprintf(logical, sizeof(logical), "/usb")
            : snprintf(logical, sizeof(logical), "/usb%s", path->valuestring);
        if (path_length <= 0 || (size_t)path_length >= sizeof(logical)) {
            cJSON_Delete(request);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB path exceeds the mapping limit");
        }

        esp_err_t err;
        if (strcmp(action->valuestring, "mkdir") == 0 && cJSON_IsString(name)) {
            char child[MAP_PATH_MAX];
            path_length = snprintf(child, sizeof(child), "%s/%s", logical, name->valuestring);
            err = path_length > 0 && (size_t)path_length < sizeof(child)
                ? usb_storage_map_mkdir(child) : ESP_ERR_INVALID_SIZE;
        } else if (strcmp(action->valuestring, "delete") == 0) {
            err = usb_storage_map_delete(logical);
        } else {
            cJSON_Delete(request);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Unsupported USB operation");
        }
        char action_name[16];
        strlcpy(action_name, action->valuestring, sizeof(action_name));
        cJSON_Delete(request);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "USB storage operation '%s' failed: %s", action_name, esp_err_to_name(err));
            httpd_resp_set_status(req, err == ESP_ERR_NOT_FOUND ? "404 Not Found" : "409 Conflict");
            return httpd_resp_sendstr(req, "USB storage operation failed");
        }
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "{\"success\":true}");
}

static esp_err_t storage_upload_handler(httpd_req_t *req) {
        if (!usb_host_msc_is_mounted()) {
            httpd_resp_set_status(req, "503 Service Unavailable");
            return httpd_resp_sendstr(req, "USB storage is not mounted");
        }
        char password[128];
        char path[MAP_PATH_MAX];
        char name[MAP_PATH_MAX];
        if (httpd_req_get_hdr_value_str(req, "X-Admin-Password", password, sizeof(password)) != ESP_OK ||
            !get_base64_header(req, "X-Upload-Path", path, sizeof(path)) ||
            !get_base64_header(req, "X-Upload-Name", name, sizeof(name)) ||
            !is_safe_usb_path(path)) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing or invalid upload metadata");
        }
        if (!auth_verify_admin_password(password)) {
            httpd_resp_set_status(req, "403 Forbidden");
            return httpd_resp_sendstr(req, "Administrator authorization required");
        }
        char logical_parent[MAP_PATH_MAX];
        int path_length = strcmp(path, "/") == 0
            ? snprintf(logical_parent, sizeof(logical_parent), "/usb")
            : snprintf(logical_parent, sizeof(logical_parent), "/usb%s", path);
        if (path_length <= 0 || (size_t)path_length >= sizeof(logical_parent)) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB folder path exceeds the mapping limit");
        }
        char logical_file[MAP_PATH_MAX];
        path_length = snprintf(logical_file, sizeof(logical_file), "%s/%s", logical_parent, name);
        if (path_length <= 0 || (size_t)path_length >= sizeof(logical_file)) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB file path exceeds the mapping limit");
        }
        char *buffer = malloc(STORAGE_UPLOAD_BUFFER_SIZE);
        if (buffer == NULL) {
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                       "Not enough memory to receive upload");
        }
        char physical_path[MAP_PATH_MAX + 8];
        esp_err_t err = usb_storage_map_create_file(logical_parent, name, physical_path, sizeof(physical_path));
        if (err != ESP_OK) {
            free(buffer);
            httpd_resp_set_status(req, "409 Conflict");
            return httpd_resp_sendstr(req, "Unable to create mapped USB file");
        }
        FILE *file = fopen(physical_path, "wb");
        if (file == NULL) {
            free(buffer);
            esp_err_t delete_err = usb_storage_map_delete(logical_file);
            if (delete_err != ESP_OK) {
                ESP_LOGE(TAG, "Failed to remove USB upload entry after open failure: %s", esp_err_to_name(delete_err));
            }
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to open USB upload destination");
        }
        size_t remaining = req->content_len;
        bool write_failed = false;
        while (remaining > 0) {
            size_t chunk_size = remaining < STORAGE_UPLOAD_BUFFER_SIZE
                ? remaining : STORAGE_UPLOAD_BUFFER_SIZE;
            int received = httpd_req_recv(req, buffer, chunk_size);
            if (received <= 0 || (size_t)received > chunk_size ||
                fwrite(buffer, 1, (size_t)received, file) != (size_t)received) {
                write_failed = true;
                break;
            }
            remaining -= (size_t)received;
        }
        free(buffer);
        if (fclose(file) != 0) write_failed = true;
        if (write_failed || remaining != 0) {
            ESP_LOGE(TAG, "USB upload failed before all file data was written");
            esp_err_t delete_err = usb_storage_map_delete(logical_file);
            if (delete_err != ESP_OK) {
                ESP_LOGE(TAG, "Failed to clean up incomplete USB upload: %s", esp_err_to_name(delete_err));
            }
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "USB upload failed");
        }
        httpd_resp_set_type(req, "application/json");
        return httpd_resp_sendstr(req, "{\"success\":true}");
}

static esp_err_t storage_read_handler(httpd_req_t *req) {
    if (!usb_host_msc_is_mounted()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB storage is not mounted");
    }
        char logical[MAP_PATH_MAX];
        char physical[MAP_PATH_MAX + 8];
        if (!get_base64_header(req, "X-USB-Path", logical, sizeof(logical)) ||
            !is_safe_usb_path(logical) || !is_text_preview_path(logical)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid or unsupported text file path");
            return ESP_OK;
        }
        if (strncmp(logical, "/usb", 4) == 0 &&
            (logical[4] == '\0' || logical[4] == '/')) {
            if (strlcpy(physical, logical, sizeof(physical)) >= sizeof(physical)) {
                httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB file path exceeds the mapping limit");
                return ESP_OK;
            }
        } else {
            int path_length = snprintf(physical, sizeof(physical), "/usb%s", logical);
            if (path_length <= 0 || (size_t)path_length >= sizeof(physical)) {
                httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB file path exceeds the mapping limit");
                return ESP_OK;
            }
        }
        if (usb_storage_map_resolve(physical, physical, sizeof(physical)) != ESP_OK) {
            httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "USB file not found");
            return ESP_OK;
        }
        FILE *file = fopen(physical, "rb");
        if (file == NULL) {
            httpd_resp_send_err(req, errno == ENOENT ? HTTPD_404_NOT_FOUND : HTTPD_500_INTERNAL_SERVER_ERROR,
                                "Unable to open USB file");
            return ESP_OK;
        }
        struct stat status;
        if (fstat(fileno(file), &status) != 0 || !S_ISREG(status.st_mode) || status.st_size < 0) {
            fclose(file);
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Path is not a regular file");
            return ESP_OK;
        }
        size_t amount = (uint64_t)status.st_size > STORAGE_PREVIEW_LIMIT
            ? STORAGE_PREVIEW_LIMIT : (size_t)status.st_size;
        char *buffer = malloc(amount + 1);
        if (buffer == NULL) {
            fclose(file);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        }
        size_t read_count = fread(buffer, 1, amount, file);
        bool failed = ferror(file) != 0;
        fclose(file);
        if (failed) {
            free(buffer);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to read USB file");
        }
        buffer[read_count] = '\0';
        httpd_resp_set_type(req, "text/plain; charset=utf-8");
        if ((uint64_t)status.st_size > STORAGE_PREVIEW_LIMIT) {
            httpd_resp_set_hdr(req, "X-Preview-Truncated", "true");
        }
        esp_err_t err = httpd_resp_send(req, buffer, read_count);
        free(buffer);
        return err;
    }

static esp_err_t storage_download_handler(httpd_req_t *req) {
    if (!usb_host_msc_is_mounted()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB storage is not mounted");
    }
    char logical[MAP_PATH_MAX];
    char physical[MAP_PATH_MAX + 8];
    if (!get_base64_header(req, "X-USB-Path", logical, sizeof(logical)) ||
        !is_safe_usb_path(logical)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid USB file path");
        return ESP_OK;
    }
    if (strncmp(logical, "/usb", 4) == 0 &&
        (logical[4] == '\0' || logical[4] == '/')) {
        if (strlcpy(physical, logical, sizeof(physical)) >= sizeof(physical)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB file path exceeds the mapping limit");
            return ESP_OK;
        }
    } else {
        int path_length = snprintf(physical, sizeof(physical), "/usb%s", logical);
        if (path_length <= 0 || (size_t)path_length >= sizeof(physical)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "USB file path exceeds the mapping limit");
            return ESP_OK;
        }
    }
    if (usb_storage_map_resolve(physical, physical, sizeof(physical)) != ESP_OK) {
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "USB file not found");
        return ESP_OK;
    }
    FILE *file = fopen(physical, "rb");
    if (file == NULL) {
        httpd_resp_send_err(req, errno == ENOENT ? HTTPD_404_NOT_FOUND : HTTPD_500_INTERNAL_SERVER_ERROR,
                            "Unable to open USB file");
        return ESP_OK;
    }
    struct stat status;
    if (fstat(fileno(file), &status) != 0 || !S_ISREG(status.st_mode) || status.st_size < 0) {
        fclose(file);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Path is not a regular file");
        return ESP_OK;
    }

    const char *filename = strrchr(logical, '/');
    filename = filename ? filename + 1 : logical;

    httpd_resp_set_type(req, "application/octet-stream");
    char content_disp[256];
    size_t filename_len = strlen(filename);
    if (filename_len > sizeof(content_disp) - 24) {
        filename_len = sizeof(content_disp) - 24;
    }
    snprintf(content_disp, sizeof(content_disp), "attachment; filename=\"%.*s\"", (int)filename_len, filename);
    httpd_resp_set_hdr(req, "Content-Disposition", content_disp);
    char content_len[32];
    snprintf(content_len, sizeof(content_len), "%lld", (long long)status.st_size);
    httpd_resp_set_hdr(req, "Content-Length", content_len);

    char *buffer = malloc(STORAGE_DOWNLOAD_BUFFER_SIZE);
    if (buffer == NULL) {
        fclose(file);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
    }

    size_t bytes_read;
    esp_err_t send_err = ESP_OK;
    while ((bytes_read = fread(buffer, 1, STORAGE_DOWNLOAD_BUFFER_SIZE, file)) > 0) {
        send_err = httpd_resp_send_chunk(req, buffer, bytes_read);
        if (send_err != ESP_OK) break;
    }
    bool read_failed = ferror(file) != 0;
    fclose(file);
    free(buffer);
    if (read_failed || send_err != ESP_OK) {
        return ESP_FAIL;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}

static bool is_image_preview_path(const char *path) {
    const char *extension = strrchr(path, '.');
    if (extension == NULL) return false;
    static const char *const allowed[] = {
        ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".webp", ".avif", ".svg", ".ico"
    };
    for (size_t i = 0; i < sizeof(allowed) / sizeof(allowed[0]); i++) {
        if (strcasecmp(extension, allowed[i]) == 0) return true;
    }
    return false;
}

static const char *image_content_type(const char *path) {
    const char *extension = strrchr(path, '.');
    if (extension == NULL) return "application/octet-stream";
    if (strcasecmp(extension, ".png") == 0) return "image/png";
    if (strcasecmp(extension, ".jpg") == 0 || strcasecmp(extension, ".jpeg") == 0) return "image/jpeg";
    if (strcasecmp(extension, ".gif") == 0) return "image/gif";
    if (strcasecmp(extension, ".bmp") == 0) return "image/bmp";
    if (strcasecmp(extension, ".webp") == 0) return "image/webp";
    if (strcasecmp(extension, ".avif") == 0) return "image/avif";
    if (strcasecmp(extension, ".svg") == 0) return "image/svg+xml";
    if (strcasecmp(extension, ".ico") == 0) return "image/x-icon";
    return "application/octet-stream";
}

static esp_err_t storage_image_handler(httpd_req_t *req) {
    if (!usb_host_msc_is_mounted()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB storage is not mounted");
    }
    char requested_path[MAP_PATH_MAX];
    char logical_path[MAP_PATH_MAX];
    char physical_path[MAP_PATH_MAX + 8];
    if (!get_base64_header(req, "X-USB-Path", requested_path, sizeof(requested_path)) ||
        !is_safe_usb_path(requested_path) || !is_image_preview_path(requested_path)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid or unsupported image path");
    }
    if (strncmp(requested_path, "/usb", 4) == 0 &&
        (requested_path[4] == '\0' || requested_path[4] == '/')) {
        if (strlcpy(logical_path, requested_path, sizeof(logical_path)) >= sizeof(logical_path)) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Image path exceeds the mapping limit");
        }
    } else {
        int path_length = snprintf(logical_path, sizeof(logical_path), "/usb%s", requested_path);
        if (path_length <= 0 || (size_t)path_length >= sizeof(logical_path)) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Image path exceeds the mapping limit");
        }
    }
    esp_err_t err = usb_storage_map_resolve(logical_path, physical_path, sizeof(physical_path));
    if (err != ESP_OK) {
        httpd_err_code_t status = err == ESP_ERR_NOT_FOUND
            ? HTTPD_404_NOT_FOUND : HTTPD_400_BAD_REQUEST;
        return httpd_resp_send_err(req, status, "Image file not found");
    }

    FILE *file = fopen(physical_path, "rb");
    if (file == NULL) {
        return httpd_resp_send_err(req, errno == ENOENT
                                   ? HTTPD_404_NOT_FOUND : HTTPD_500_INTERNAL_SERVER_ERROR,
                                   "Unable to open image file");
    }
    struct stat status;
    if (fstat(fileno(file), &status) != 0 || !S_ISREG(status.st_mode) || status.st_size < 0) {
        fclose(file);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Path is not a regular image file");
    }

    httpd_resp_set_type(req, image_content_type(logical_path));
    httpd_resp_set_hdr(req, "X-Content-Type-Options", "nosniff");
    char buffer[MEDIA_BUFFER_SIZE];
    size_t bytes_read;
    while ((bytes_read = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        err = httpd_resp_send_chunk(req, buffer, bytes_read);
        if (err != ESP_OK) {
            fclose(file);
            return err;
        }
    }
    bool read_failed = ferror(file) != 0;
    fclose(file);
    if (read_failed) {
        ESP_LOGE(TAG, "Failed reading USB image: %s", physical_path);
        return ESP_FAIL;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}

static const char *media_content_type(const char *path) {
    const char *extension = strrchr(path, '.');
    if (!extension) return "application/octet-stream";
    if (strcasecmp(extension, ".mp3") == 0) return "audio/mpeg";
    if (strcasecmp(extension, ".m4a") == 0 || strcasecmp(extension, ".aac") == 0) return "audio/mp4";
    if (strcasecmp(extension, ".wav") == 0) return "audio/wav";
    if (strcasecmp(extension, ".ogg") == 0 || strcasecmp(extension, ".oga") == 0) return "audio/ogg";
    if (strcasecmp(extension, ".opus") == 0) return "audio/ogg";
    if (strcasecmp(extension, ".flac") == 0) return "audio/flac";
    if (strcasecmp(extension, ".mp4") == 0 || strcasecmp(extension, ".m4v") == 0) return "video/mp4";
    if (strcasecmp(extension, ".webm") == 0 || strcasecmp(extension, ".ogv") == 0) return "video/webm";
    if (strcasecmp(extension, ".mov") == 0) return "video/quicktime";
    if (strcasecmp(extension, ".mkv") == 0) return "video/x-matroska";
    if (strcasecmp(extension, ".avi") == 0) return "video/x-msvideo";
    if (strcasecmp(extension, ".mpeg") == 0 || strcasecmp(extension, ".mpg") == 0) return "video/mpeg";
    if (strcasecmp(extension, ".3gp") == 0) return "video/3gpp";
    if (strcasecmp(extension, ".ts") == 0 || strcasecmp(extension, ".m2ts") == 0) return "video/mp2t";
    if (strcasecmp(extension, ".srt") == 0 || strcasecmp(extension, ".vtt") == 0) return "text/plain; charset=utf-8";
    return "application/octet-stream";
}

static esp_err_t media_file_handler(httpd_req_t *req) {
    if (!usb_host_msc_is_mounted()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB storage is not mounted");
    }
    char path[288];
    char physical_relative[256];
    char media_logical_path[MAP_PATH_MAX];
    if (get_query_parameter(req, "physical", physical_relative, sizeof(physical_relative))) {
        bool is_directory = false;
        int path_length = snprintf(path, sizeof(path), "/usb%s", physical_relative);
        if (!is_safe_usb_path(physical_relative) || path_length <= 0 ||
            (size_t)path_length >= sizeof(path) ||
            usb_storage_map_get_logical(path, media_logical_path, sizeof(media_logical_path),
                                        &is_directory) != ESP_OK ||
            is_directory || strncmp(media_logical_path, "/usb", strlen("/usb")) != 0 ||
            !is_safe_media_path(media_logical_path + strlen("/usb"), false)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid media file path");
            return ESP_OK;
        }
    } else {
        char media_relative_path[256];
        if (!get_media_fs_path(req, path, sizeof(path), false) ||
            !get_query_parameter(req, "path", media_relative_path, sizeof(media_relative_path)) ||
            !is_safe_media_path(media_relative_path, false)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid media file path");
            return ESP_OK;
        }
        int logical_length = snprintf(media_logical_path, sizeof(media_logical_path),
                                      "/usb%s", media_relative_path);
        if (logical_length <= 0 || (size_t)logical_length >= sizeof(media_logical_path)) {
            httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Media path exceeds the mapping limit");
            return ESP_OK;
        }
    }
    FILE *file = fopen(path, "rb");
    if (!file) {
        httpd_resp_send_err(req, errno == ENOENT ? HTTPD_404_NOT_FOUND : HTTPD_500_INTERNAL_SERVER_ERROR,
                            "Unable to open media file");
        return ESP_OK;
    }
    struct stat st;
    if (fstat(fileno(file), &st) != 0 || !S_ISREG(st.st_mode) || st.st_size < 0) {
        fclose(file);
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Path is not a regular file");
        return ESP_OK;
    }

    uint64_t file_size = (uint64_t)st.st_size;
    uint64_t start = 0;
    uint64_t end = file_size ? file_size - 1 : 0;
    char range[64];
    if (httpd_req_get_hdr_value_str(req, "Range", range, sizeof(range)) == ESP_OK) {
        bool invalid_range = strncmp(range, "bytes=", 6) != 0 || file_size == 0 ||
            strchr(range + 6, ',') != NULL;
        uint64_t requested_start = 0;
        uint64_t requested_end = file_size ? file_size - 1 : 0;
        if (!invalid_range && range[6] == '-') {
            uint64_t suffix_length = 0;
            if (!parse_decimal_u64(range + 7, &suffix_length) || suffix_length == 0) {
                invalid_range = true;
            } else {
                requested_start = suffix_length >= file_size ? 0 : file_size - suffix_length;
            }
        } else if (!invalid_range) {
            const char *separator = strchr(range + 6, '-');
            if (separator == NULL) {
                invalid_range = true;
            } else {
                char start_text[sizeof(range)];
                size_t start_length = (size_t)(separator - (range + 6));
                if (start_length == 0 || start_length >= sizeof(start_text)) {
                    invalid_range = true;
                } else {
                    memcpy(start_text, range + 6, start_length);
                    start_text[start_length] = '\0';
                    if (!parse_decimal_u64(start_text, &requested_start)) {
                        invalid_range = true;
                    } else {
                        const char *end_text = separator + 1;
                        if (*end_text != '\0' && !parse_decimal_u64(end_text, &requested_end)) {
                            invalid_range = true;
                        }
                    }
                }
            }
        }
        if (invalid_range || requested_start >= file_size || requested_end < requested_start) {
            fclose(file);
            httpd_resp_set_status(req, "416 Range Not Satisfiable");
            char content_range[64];
            snprintf(content_range, sizeof(content_range), "bytes */%llu", (unsigned long long)file_size);
            httpd_resp_set_hdr(req, "Content-Range", content_range);
            return httpd_resp_send(req, NULL, 0);
        }
        start = requested_start;
        end = requested_end < file_size ? requested_end : file_size - 1;
        httpd_resp_set_status(req, "206 Partial Content");
        char content_range[96];
        snprintf(content_range, sizeof(content_range), "bytes %llu-%llu/%llu",
                 (unsigned long long)start, (unsigned long long)end, (unsigned long long)file_size);
        httpd_resp_set_hdr(req, "Content-Range", content_range);
    } else {
        httpd_resp_set_status(req, "200 OK");
    }
    httpd_resp_set_type(req, media_content_type(media_logical_path));
    httpd_resp_set_hdr(req, "Accept-Ranges", "bytes");

    if (fseeko(file, (off_t)start, SEEK_SET) != 0) {
        fclose(file);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to seek media file");
    }
    uint64_t remaining = file_size == 0 ? 0 : end - start + 1;
    char buffer[MEDIA_BUFFER_SIZE];
    while (remaining > 0) {
        size_t read_size = remaining < sizeof(buffer) ? (size_t)remaining : sizeof(buffer);
        size_t bytes_read = fread(buffer, 1, read_size, file);
        if (bytes_read == 0) {
            fclose(file);
            return ESP_FAIL;
        }
        esp_err_t err = httpd_resp_send_chunk(req, buffer, bytes_read);
        if (err != ESP_OK) {
            fclose(file);
            return err;
        }
        remaining -= bytes_read;
    }
    fclose(file);
    return httpd_resp_send_chunk(req, NULL, 0);
}

static esp_err_t hardware_gpio_list_handler(httpd_req_t *req) {
    cJSON *root = cJSON_CreateArray();
    if (!root) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
    for (int i = 0; i < MEDIA_GPIO_COUNT; i++) {
        cJSON *pin = cJSON_CreateObject();
        if (!pin) {
            cJSON_Delete(root);
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
        }
        cJSON_AddNumberToObject(pin, "pin", s_media_gpios[i]);
        cJSON_AddBoolToObject(pin, "configured", s_media_gpio_initialized[i]);
        if (s_media_gpio_initialized[i]) {
            cJSON_AddNumberToObject(pin, "level", s_media_gpio_levels[i]);
        } else {
            cJSON_AddNullToObject(pin, "level");
        }
        cJSON_AddItemToArray(root, pin);
    }
    const char *json = cJSON_PrintUnformatted(root);
    if (!json) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode GPIO states");
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t err = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
    cJSON_free((void *)json);
    cJSON_Delete(root);
    return err;
}

static esp_err_t hardware_gpio_set_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 128) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid GPIO command");
    }
    char body[128];
    int total_received = 0;
    while (total_received < req->content_len) {
        int received = httpd_req_recv(req, body + total_received, req->content_len - total_received);
        if (received <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete GPIO command");
        total_received += received;
    }
    body[total_received] = '\0';
    cJSON *command = cJSON_Parse(body);
    if (!command) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
    cJSON *pin_json = cJSON_GetObjectItemCaseSensitive(command, "pin");
    cJSON *level_json = cJSON_GetObjectItemCaseSensitive(command, "level");
    int pin_number = cJSON_IsNumber(pin_json) && pin_json->valuedouble >= 0 &&
                     pin_json->valuedouble <= 255 &&
                     pin_json->valuedouble == (double)pin_json->valueint
        ? pin_json->valueint : -1;
    int level = cJSON_IsNumber(level_json) && level_json->valuedouble >= 0 &&
                level_json->valuedouble <= 1 &&
                level_json->valuedouble == (double)level_json->valueint
        ? level_json->valueint : -1;
    int index = media_gpio_index(pin_number);
    cJSON_Delete(command);
    if (index < 0 || (level != 0 && level != 1)) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Only GPIO 4-7 and output levels 0/1 are allowed");
    }
    gpio_num_t pin = s_media_gpios[index];
    if (!s_media_gpio_initialized[index]) {
        gpio_config_t config = {
            .pin_bit_mask = 1ULL << pin,
            .mode = GPIO_MODE_OUTPUT,
            .pull_up_en = GPIO_PULLUP_DISABLE,
            .pull_down_en = GPIO_PULLDOWN_DISABLE,
            .intr_type = GPIO_INTR_DISABLE,
        };
        esp_err_t err = gpio_config(&config);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to configure GPIO %d: %s", pin_number, esp_err_to_name(err));
            return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to configure GPIO");
        }
        gpio_set_level(pin, 0);
        s_media_gpio_initialized[index] = true;
    }
    esp_err_t err = gpio_set_level(pin, level);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to set GPIO %d: %s", pin_number, esp_err_to_name(err));
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to set GPIO");
    }
    s_media_gpio_levels[index] = level;
    cJSON *response = cJSON_CreateObject();
    if (!response) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
    cJSON_AddNumberToObject(response, "pin", pin_number);
    cJSON_AddNumberToObject(response, "level", level);
    const char *json = cJSON_PrintUnformatted(response);
    if (!json) {
        cJSON_Delete(response);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode GPIO state");
    }
    httpd_resp_set_type(req, "application/json");
    err = httpd_resp_send(req, json, HTTPD_RESP_USE_STRLEN);
    cJSON_free((void *)json);
    cJSON_Delete(response);
    return err;
}

/* Handler: /api/auth/verify_uac */
static esp_err_t uac_verify_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 256) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid elevation request size");
    }
    char buf[256];
    size_t received_total = 0;
    while (received_total < (size_t)req->content_len) {
        int received = httpd_req_recv(req, buf + received_total, (size_t)req->content_len - received_total);
        if (received <= 0) {
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete elevation request");
        }
        received_total += (size_t)received;
    }
    buf[received_total] = '\0';

    cJSON *json = cJSON_Parse(buf);
    if (json == NULL || !cJSON_IsObject(json)) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid elevation JSON");
    }
    cJSON *user_json = cJSON_GetObjectItemCaseSensitive(json, "username");
    cJSON *pass_json = cJSON_GetObjectItemCaseSensitive(json, "password");
    cJSON *exe_json = cJSON_GetObjectItemCaseSensitive(json, "exePath");
    if (!cJSON_IsString(user_json) || !cJSON_IsString(pass_json) || !cJSON_IsString(exe_json)) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Elevation request requires username, password, and exePath strings");
    }

    bool granted = uac_verify_elevation(user_json->valuestring, pass_json->valuestring, exe_json->valuestring);
    cJSON_Delete(json);

    cJSON *resp = cJSON_CreateObject();
    if (resp == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
    }
    cJSON_AddBoolToObject(resp, "success", granted);
    const char *resp_str = cJSON_PrintUnformatted(resp);
    if (resp_str == NULL) {
        cJSON_Delete(resp);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode elevation response");
    }

    httpd_resp_set_type(req, "application/json");
    esp_err_t send_err = httpd_resp_send(req, resp_str, HTTPD_RESP_USE_STRLEN);
    cJSON_Delete(resp);
    cJSON_free((void *)resp_str);
    return send_err;
}

/* Handler: /api/account/state */
static bool account_state_storage_ready(void) {
    return esp_littlefs_mounted(ACCOUNT_STATE_PARTITION_LABEL);
}

static esp_err_t resolve_account_state_file(const char *path, char *resolved_path,
                                           size_t path_size) {
    if (!account_state_storage_ready()) return ESP_ERR_INVALID_STATE;
    size_t path_length = strnlen(path, path_size);
    if (path_length == 0 || path_length >= path_size) return ESP_ERR_INVALID_SIZE;
    memcpy(resolved_path, path, path_length + 1);
    return ESP_OK;
}

static esp_err_t copy_legacy_account_file(const char *legacy_path, const char *new_path) {
    char source_path[MAP_PATH_MAX + 8];
    esp_err_t err = usb_storage_map_resolve(legacy_path, source_path, sizeof(source_path));
    if (err != ESP_OK) return err;

    FILE *source = fopen(source_path, "rb");
    if (!source) return ESP_FAIL;
    if (fseek(source, 0, SEEK_END) != 0) {
        fclose(source);
        return ESP_FAIL;
    }
    long source_size = ftell(source);
    if (source_size < 0 || (unsigned long)source_size > ACCOUNT_STATE_MAX_BYTES ||
        fseek(source, 0, SEEK_SET) != 0) {
        fclose(source);
        return ESP_ERR_INVALID_SIZE;
    }

    char temporary_path[sizeof(ACCOUNT_STATE_SLOT_A) + 8];
    int path_len = snprintf(temporary_path, sizeof(temporary_path), "%s.tmp", new_path);
    if (path_len <= 0 || (size_t)path_len >= sizeof(temporary_path)) {
        fclose(source);
        return ESP_ERR_INVALID_SIZE;
    }
    FILE *destination = fopen(temporary_path, "wb");
    if (!destination) {
        fclose(source);
        return ESP_FAIL;
    }

    char buffer[2048];
    bool copy_ok = true;
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), source)) > 0) {
        if (fwrite(buffer, 1, count, destination) != count) {
            copy_ok = false;
            break;
        }
    }
    copy_ok = copy_ok && ferror(source) == 0 && fflush(destination) == 0;
    bool source_closed = fclose(source) == 0;
    bool destination_closed = fclose(destination) == 0;
    if (!copy_ok || !source_closed || !destination_closed) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    remove(new_path);
    if (rename(temporary_path, new_path) != 0) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static esp_err_t migrate_legacy_account_state(void) {
    if (!usb_host_msc_is_mounted() || !account_state_storage_ready()) {
        return ESP_ERR_NOT_FOUND;
    }
    char legacy_index_path[MAP_PATH_MAX + 8];
    esp_err_t err = usb_storage_map_resolve(LEGACY_ACCOUNT_STATE_INDEX,
                                            legacy_index_path, sizeof(legacy_index_path));
    if (err != ESP_OK) return err;
    FILE *legacy_index = fopen(legacy_index_path, "rb");
    if (!legacy_index) return ESP_ERR_NOT_FOUND;
    int active_slot = fgetc(legacy_index);
    int trailing = fgetc(legacy_index);
    bool index_read_ok = !ferror(legacy_index);
    bool index_closed = fclose(legacy_index) == 0;
    if (!index_read_ok || !index_closed) return ESP_FAIL;
    if ((active_slot != '0' && active_slot != '1') || trailing != EOF) {
        return ESP_ERR_INVALID_STATE;
    }

    const char *legacy_slots[] = {
        LEGACY_ACCOUNT_STATE_SLOT_A, LEGACY_ACCOUNT_STATE_SLOT_B,
    };
    const char *new_slots[] = {ACCOUNT_STATE_SLOT_A, ACCOUNT_STATE_SLOT_B};
    for (size_t i = 0; i < sizeof(legacy_slots) / sizeof(legacy_slots[0]); i++) {
        err = copy_legacy_account_file(legacy_slots[i], new_slots[i]);
        if (err != ESP_OK && err != ESP_ERR_NOT_FOUND) return err;
    }

    char index_path[sizeof(ACCOUNT_STATE_INDEX)];
    err = resolve_account_state_file(ACCOUNT_STATE_INDEX, index_path, sizeof(index_path));
    if (err != ESP_OK) return err;
    FILE *index_file = fopen(index_path, "wb");
    if (!index_file) return ESP_FAIL;
    char index_value = (char)active_slot;
    bool write_ok = fwrite(&index_value, 1, 1, index_file) == 1 &&
                    fflush(index_file) == 0;
    bool close_ok = fclose(index_file) == 0;
    if (!write_ok || !close_ok) return ESP_FAIL;
    ESP_LOGI(TAG, "Migrated shared account state from USB to internal LittleFS");
    return ESP_OK;
}

static esp_err_t read_account_state_index(uint8_t *active_slot) {
    char index_path[sizeof(ACCOUNT_STATE_INDEX)];
    esp_err_t err = resolve_account_state_file(ACCOUNT_STATE_INDEX, index_path,
                                               sizeof(index_path));
    if (err != ESP_OK) return err;

    FILE *file = fopen(index_path, "rb");
    if (file == NULL && errno == ENOENT) {
        err = migrate_legacy_account_state();
        if (err != ESP_OK) return err == ESP_ERR_NOT_FOUND ? err : ESP_FAIL;
        file = fopen(index_path, "rb");
    }
    if (file == NULL) return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    int value = fgetc(file);
    int trailing = fgetc(file);
    bool read_ok = !ferror(file);
    bool close_ok = fclose(file) == 0;
    if (!read_ok || !close_ok) return ESP_FAIL;
    if ((value != '0' && value != '1') || trailing != EOF) return ESP_ERR_INVALID_STATE;
    *active_slot = (uint8_t)(value - '0');
    return ESP_OK;
}

static esp_err_t write_account_state_index(uint8_t active_slot) {
    char index_path[sizeof(ACCOUNT_STATE_INDEX)];
    esp_err_t err = resolve_account_state_file(ACCOUNT_STATE_INDEX, index_path,
                                               sizeof(index_path));
    if (err != ESP_OK) return err;

    char temporary_path[sizeof(ACCOUNT_STATE_INDEX) + 8];
    int path_len = snprintf(temporary_path, sizeof(temporary_path), "%s.tmp", index_path);
    if (path_len <= 0 || (size_t)path_len >= sizeof(temporary_path)) {
        return ESP_ERR_INVALID_SIZE;
    }
    FILE *file = fopen(temporary_path, "wb");
    if (file == NULL) return ESP_FAIL;
    char value = (char)('0' + active_slot);
    bool write_ok = fwrite(&value, 1, 1, file) == 1 && fflush(file) == 0;
    bool close_ok = fclose(file) == 0;
    if (!write_ok || !close_ok) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    if (rename(temporary_path, index_path) != 0) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

static bool account_state_request_fits_memory(size_t body_size) {
    if (body_size == SIZE_MAX) {
        return false;
    }

    size_t allocation_size = body_size + 1;
    size_t free_internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    size_t free_psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    size_t largest_psram = heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (free_internal < ACCOUNT_STATE_INTERNAL_RESERVE_BYTES ||
        free_psram <= ACCOUNT_STATE_MEMORY_RESERVE_BYTES ||
        allocation_size > largest_psram ||
        allocation_size > free_psram - ACCOUNT_STATE_MEMORY_RESERVE_BYTES) {
        return false;
    }

    return true;
}

typedef enum {
    ACCOUNT_JSON_OBJECT,
    ACCOUNT_JSON_ARRAY,
    ACCOUNT_JSON_STRING,
    ACCOUNT_JSON_NUMBER,
    ACCOUNT_JSON_OTHER,
} account_json_kind_t;

typedef struct {
    const char *cursor;
    const char *end;
} account_json_parser_t;

typedef struct {
    account_json_kind_t kind;
    double number;
    bool nonempty;
} account_json_value_t;

static void account_json_skip_whitespace(account_json_parser_t *parser) {
    while (parser->cursor < parser->end &&
           (*parser->cursor == ' ' || *parser->cursor == '\t' ||
            *parser->cursor == '\n' || *parser->cursor == '\r')) {
        parser->cursor++;
    }
}

static bool account_json_parse_string(account_json_parser_t *parser,
                                      char *decoded_key, size_t key_size,
                                      bool *first_character_nonzero) {
    if (parser->cursor >= parser->end || *parser->cursor != '"') return false;
    parser->cursor++;

    size_t key_length = 0;
    bool key_overflow = false;
    bool first_character_seen = false;
    *first_character_nonzero = false;
    for (;;) {
        if (parser->cursor >= parser->end) return false;
        unsigned char ch = (unsigned char)*parser->cursor++;
        if (ch == '"') {
            if (decoded_key != NULL && key_size > 0) {
                decoded_key[key_overflow ? 0 : key_length] = '\0';
            }
            return true;
        }

        uint32_t codepoint;
        if (ch == '\\') {
            if (parser->cursor >= parser->end) return false;
            char escape = *parser->cursor++;
            switch (escape) {
                case '"': codepoint = '"'; break;
                case '\\': codepoint = '\\'; break;
                case '/': codepoint = '/'; break;
                case 'b': codepoint = '\b'; break;
                case 'f': codepoint = '\f'; break;
                case 'n': codepoint = '\n'; break;
                case 'r': codepoint = '\r'; break;
                case 't': codepoint = '\t'; break;
                case 'u': {
                    if ((size_t)(parser->end - parser->cursor) < 4) return false;
                    codepoint = 0;
                    for (size_t i = 0; i < 4; i++) {
                        char digit = *parser->cursor++;
                        uint8_t value;
                        if (digit >= '0' && digit <= '9') value = (uint8_t)(digit - '0');
                        else if (digit >= 'a' && digit <= 'f') value = (uint8_t)(digit - 'a' + 10);
                        else if (digit >= 'A' && digit <= 'F') value = (uint8_t)(digit - 'A' + 10);
                        else return false;
                        codepoint = (codepoint << 4) | value;
                    }
                    break;
                }
                default: return false;
            }
        } else {
            if (ch < 0x20) return false;
            codepoint = ch;
        }

        if (!first_character_seen) {
            *first_character_nonzero = codepoint != 0;
            first_character_seen = true;
        }
        if (decoded_key != NULL) {
            if (codepoint == 0 || codepoint > 0x7f ||
                key_length + 1 >= key_size) {
                key_overflow = true;
            } else if (!key_overflow) {
                decoded_key[key_length++] = (char)codepoint;
            }
        }
    }
}

static bool account_json_parse_value(account_json_parser_t *parser,
                                     size_t parent_depth,
                                     account_json_value_t *value);

static bool account_json_parse_object_contents(account_json_parser_t *parser,
                                               size_t object_depth) {
    account_json_skip_whitespace(parser);
    if (parser->cursor < parser->end && *parser->cursor == '}') {
        parser->cursor++;
        return true;
    }

    for (;;) {
        bool ignored_nonempty;
        if (!account_json_parse_string(parser, NULL, 0, &ignored_nonempty)) return false;
        account_json_skip_whitespace(parser);
        if (parser->cursor >= parser->end || *parser->cursor++ != ':') return false;

        account_json_value_t child;
        if (!account_json_parse_value(parser, object_depth, &child)) return false;
        account_json_skip_whitespace(parser);
        if (parser->cursor >= parser->end) return false;
        char delimiter = *parser->cursor++;
        if (delimiter == '}') return true;
        if (delimiter != ',') return false;
        account_json_skip_whitespace(parser);
    }
}

static bool account_json_parse_array_contents(account_json_parser_t *parser,
                                              size_t array_depth,
                                              bool *nonempty) {
    account_json_skip_whitespace(parser);
    if (parser->cursor < parser->end && *parser->cursor == ']') {
        parser->cursor++;
        *nonempty = false;
        return true;
    }

    *nonempty = true;
    for (;;) {
        account_json_value_t child;
        if (!account_json_parse_value(parser, array_depth, &child)) return false;
        account_json_skip_whitespace(parser);
        if (parser->cursor >= parser->end) return false;
        char delimiter = *parser->cursor++;
        if (delimiter == ']') return true;
        if (delimiter != ',') return false;
        account_json_skip_whitespace(parser);
    }
}

static bool account_json_parse_number(account_json_parser_t *parser,
                                      double *number) {
    const char *start = parser->cursor;
    if (parser->cursor < parser->end && *parser->cursor == '-') parser->cursor++;
    if (parser->cursor >= parser->end) return false;

    if (*parser->cursor == '0') {
        parser->cursor++;
    } else if (*parser->cursor >= '1' && *parser->cursor <= '9') {
        do {
            parser->cursor++;
        } while (parser->cursor < parser->end &&
                 *parser->cursor >= '0' && *parser->cursor <= '9');
    } else {
        return false;
    }

    if (parser->cursor < parser->end && *parser->cursor == '.') {
        parser->cursor++;
        if (parser->cursor >= parser->end ||
            *parser->cursor < '0' || *parser->cursor > '9') return false;
        do {
            parser->cursor++;
        } while (parser->cursor < parser->end &&
                 *parser->cursor >= '0' && *parser->cursor <= '9');
    }
    if (parser->cursor < parser->end &&
        (*parser->cursor == 'e' || *parser->cursor == 'E')) {
        parser->cursor++;
        if (parser->cursor < parser->end &&
            (*parser->cursor == '+' || *parser->cursor == '-')) parser->cursor++;
        if (parser->cursor >= parser->end ||
            *parser->cursor < '0' || *parser->cursor > '9') return false;
        do {
            parser->cursor++;
        } while (parser->cursor < parser->end &&
                 *parser->cursor >= '0' && *parser->cursor <= '9');
    }

    char *end;
    *number = strtod(start, &end);
    return end == parser->cursor;
}

static bool account_json_parse_value(account_json_parser_t *parser,
                                     size_t parent_depth,
                                     account_json_value_t *value) {
    account_json_skip_whitespace(parser);
    if (parser->cursor >= parser->end) return false;
    memset(value, 0, sizeof(*value));

    char ch = *parser->cursor;
    if (ch == '{') {
        if (parent_depth >= ACCOUNT_STATE_JSON_MAX_DEPTH) return false;
        parser->cursor++;
        value->kind = ACCOUNT_JSON_OBJECT;
        return account_json_parse_object_contents(parser, parent_depth + 1);
    }
    if (ch == '[') {
        if (parent_depth >= ACCOUNT_STATE_JSON_MAX_DEPTH) return false;
        parser->cursor++;
        value->kind = ACCOUNT_JSON_ARRAY;
        return account_json_parse_array_contents(parser, parent_depth + 1,
                                                 &value->nonempty);
    }
    if (ch == '"') {
        value->kind = ACCOUNT_JSON_STRING;
        return account_json_parse_string(parser, NULL, 0, &value->nonempty);
    }
    if (ch == '-' || (ch >= '0' && ch <= '9')) {
        value->kind = ACCOUNT_JSON_NUMBER;
        return account_json_parse_number(parser, &value->number);
    }
    static const char *const literals[] = {"true", "false", "null"};
    for (size_t i = 0; i < sizeof(literals) / sizeof(literals[0]); i++) {
        size_t length = strlen(literals[i]);
        if ((size_t)(parser->end - parser->cursor) >= length &&
            memcmp(parser->cursor, literals[i], length) == 0) {
            parser->cursor += length;
            value->kind = ACCOUNT_JSON_OTHER;
            return true;
        }
    }
    return false;
}

static bool account_state_json_is_valid(const char *body, size_t body_size) {
    account_json_parser_t parser = {
        .cursor = body,
        .end = body + body_size,
    };
    account_json_skip_whitespace(&parser);
    if (parser.cursor >= parser.end || *parser.cursor++ != '{') return false;

    bool version_seen = false;
    bool version_valid = false;
    bool users_seen = false;
    bool users_valid = false;
    bool current_user_seen = false;
    bool current_user_valid = false;
    bool desktop_seen = false;
    bool desktop_valid = false;
    account_json_skip_whitespace(&parser);
    if (parser.cursor < parser.end && *parser.cursor == '}') {
        parser.cursor++;
        return false;
    }

    for (;;) {
        char key[24];
        bool ignored_nonempty;
        if (!account_json_parse_string(&parser, key, sizeof(key), &ignored_nonempty)) return false;
        account_json_skip_whitespace(&parser);
        if (parser.cursor >= parser.end || *parser.cursor++ != ':') return false;

        account_json_value_t value;
        if (!account_json_parse_value(&parser, 1, &value)) return false;
        if (strcmp(key, "schemaVersion") == 0 && !version_seen) {
            version_seen = true;
            version_valid = value.kind == ACCOUNT_JSON_NUMBER && value.number == 1.0;
        } else if (strcmp(key, "users") == 0 && !users_seen) {
            users_seen = true;
            users_valid = value.kind == ACCOUNT_JSON_ARRAY && value.nonempty;
        } else if (strcmp(key, "currentUserId") == 0 && !current_user_seen) {
            current_user_seen = true;
            current_user_valid = value.kind == ACCOUNT_JSON_STRING && value.nonempty;
        } else if (strcmp(key, "desktop") == 0 && !desktop_seen) {
            desktop_seen = true;
            desktop_valid = value.kind == ACCOUNT_JSON_OBJECT;
        }

        account_json_skip_whitespace(&parser);
        if (parser.cursor >= parser.end) return false;
        char delimiter = *parser.cursor++;
        if (delimiter == '}') break;
        if (delimiter != ',') return false;
        account_json_skip_whitespace(&parser);
    }

    account_json_skip_whitespace(&parser);
    return parser.cursor == parser.end && version_valid && users_valid &&
        current_user_valid && desktop_valid;
}

static esp_err_t account_state_get_handler(httpd_req_t *req) {
    if (!account_state_storage_ready()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_send(req, "Internal LittleFS account storage is unavailable",
                               HTTPD_RESP_USE_STRLEN);
    }

    uint8_t active_slot = 0;
    esp_err_t err = read_account_state_index(&active_slot);
    if (err == ESP_ERR_NOT_FOUND) {
        if (!usb_host_msc_is_mounted()) {
            httpd_resp_set_status(req, "503 Service Unavailable");
            return httpd_resp_sendstr(req, "USB storage must be available for first-time account migration");
        }
        return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No saved account state");
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Unable to read LittleFS account-state index: %s", esp_err_to_name(err));
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to read account-state index");
    }

    const char *active_logical_path = active_slot == 0 ? ACCOUNT_STATE_SLOT_A : ACCOUNT_STATE_SLOT_B;
    const char *backup_logical_path = active_slot == 0 ? ACCOUNT_STATE_SLOT_B : ACCOUNT_STATE_SLOT_A;
    char active_path[sizeof(ACCOUNT_STATE_SLOT_A)];
    char backup_path[sizeof(ACCOUNT_STATE_SLOT_A)];
    err = resolve_account_state_file(active_logical_path, active_path, sizeof(active_path));
    if (err != ESP_OK && err != ESP_ERR_NOT_FOUND) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to locate account state");
    }
    bool active_path_found = err == ESP_OK;
    err = resolve_account_state_file(backup_logical_path, backup_path, sizeof(backup_path));
    if (err != ESP_OK && err != ESP_ERR_NOT_FOUND) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to locate backup account state");
    }
    bool backup_path_found = err == ESP_OK;
    FILE *file = active_path_found ? fopen(active_path, "rb") : NULL;
    if (file == NULL) {
        ESP_LOGW(TAG, "Active account-state slot is unavailable; trying the previous saved slot");
        file = backup_path_found ? fopen(backup_path, "rb") : NULL;
    }
    if (file == NULL) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No saved account state");
    if (fseek(file, 0, SEEK_END) != 0) {
        fclose(file);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to read account state");
    }
    long file_size = ftell(file);
    if (file_size <= 0 || fseek(file, 0, SEEK_SET) != 0) {
        fclose(file);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Saved account state has an invalid size");
    }
    if ((unsigned long)file_size > ACCOUNT_STATE_MAX_BYTES) {
        fclose(file);
        ESP_LOGE(TAG, "Saved account state exceeds the %u-byte limit",
                 (unsigned)ACCOUNT_STATE_MAX_BYTES);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR,
                                   "Saved account state exceeds the supported size limit");
    }
    httpd_resp_set_type(req, "application/json");
    char buffer[2048];
    size_t bytes_read;
    while ((bytes_read = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        err = httpd_resp_send_chunk(req, buffer, bytes_read);
        if (err != ESP_OK) {
            fclose(file);
            return err;
        }
    }
    bool read_ok = ferror(file) == 0;
    bool close_ok = fclose(file) == 0;
    if (!read_ok || !close_ok) {
        ESP_LOGE(TAG, "Unable to stream saved account state");
        return ESP_FAIL;
    }
    return httpd_resp_send_chunk(req, NULL, 0);
}

static esp_err_t account_state_save_handler(httpd_req_t *req) {
    if (!account_state_storage_ready()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_send(req, "Internal LittleFS account storage is unavailable",
                               HTTPD_RESP_USE_STRLEN);
    }
    if (req->content_len <= 0) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Account state request is empty");
    }
    size_t body_size = (size_t)req->content_len;
    if (body_size > ACCOUNT_STATE_MAX_BYTES) {
        httpd_resp_set_status(req, "413 Payload Too Large");
        return httpd_resp_sendstr(req, "Account state exceeds the 2 MiB size limit");
    }
    if (!account_state_request_fits_memory(body_size)) {
        ESP_LOGW(TAG, "Rejecting account state of %zu bytes: internal free=%zu, PSRAM free=%zu, largest PSRAM block=%zu",
                 body_size,
                 heap_caps_get_free_size(MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT),
                 heap_caps_get_free_size(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT),
                 heap_caps_get_largest_free_block(MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT));
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_send(req, "Account state exceeds currently available memory",
                               HTTPD_RESP_USE_STRLEN);
    }
    char *body = heap_caps_malloc(body_size + 1,
                                  MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (body == NULL) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Not enough memory to save account state");
    }
    size_t received_total = 0;
    while (received_total < body_size) {
        int received = httpd_req_recv(req, body + received_total, body_size - received_total);
        if (received <= 0) {
            heap_caps_free(body);
            return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete account state request");
        }
        received_total += (size_t)received;
    }
    body[body_size] = '\0';

    if (!account_state_json_is_valid(body, body_size)) {
        heap_caps_free(body);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Account state JSON does not match the supported schema");
    }

    uint8_t active_slot = 1;
    esp_err_t index_err = read_account_state_index(&active_slot);
    if (index_err != ESP_OK && index_err != ESP_ERR_NOT_FOUND) {
        heap_caps_free(body);
        ESP_LOGE(TAG, "Unable to read USB account-state index: %s", esp_err_to_name(index_err));
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Account-state index is invalid");
    }
    uint8_t next_slot = active_slot ^ 1U;
    const char *next_logical_path = next_slot == 0 ? ACCOUNT_STATE_SLOT_A : ACCOUNT_STATE_SLOT_B;
    char next_path[sizeof(ACCOUNT_STATE_SLOT_A)];
    esp_err_t path_err = resolve_account_state_file(next_logical_path, next_path,
                                                    sizeof(next_path));
    if (path_err != ESP_OK) {
        heap_caps_free(body);
        ESP_LOGE(TAG, "Cannot resolve LittleFS account-state slot %s: %s",
                 next_logical_path, esp_err_to_name(path_err));
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to persist account state");
    }
    FILE *file = fopen(next_path, "wb");
    if (file == NULL) {
        heap_caps_free(body);
        ESP_LOGE(TAG, "Cannot open LittleFS account-state slot %s", next_path);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to persist account state");
    }
    bool write_ok = fwrite(body, 1, body_size, file) == body_size && fflush(file) == 0;
    bool close_ok = fclose(file) == 0;
    heap_caps_free(body);
    if (!write_ok || !close_ok) {
        ESP_LOGE(TAG, "Unable to finish writing LittleFS account-state slot %s", next_path);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to persist account state");
    }
    esp_err_t err = write_account_state_index(next_slot);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Unable to select the newly saved USB account-state slot: %s",
                 esp_err_to_name(err));
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to persist account state");
    }

    httpd_resp_set_status(req, "204 No Content");
    return httpd_resp_send(req, "", 0);
}

static bool is_safe_web_path(const char *path) {
    if (path[0] != '/') {
        return false;
    }

    const char *segment = path + 1;
    for (const char *p = segment;; p++) {
        if (*p == '%' || *p == '\\' || (*p != '\0' && (unsigned char)*p < 0x20)) {
            return false;
        }
        if (*p == '/' || *p == '\0') {
            size_t segment_len = (size_t)(p - segment);
            if ((segment_len == 1 && segment[0] == '.') ||
                (segment_len == 2 && segment[0] == '.' && segment[1] == '.')) {
                return false;
            }
            if (*p == '\0') {
                break;
            }
            segment = p + 1;
        }
    }

    return true;
}

static const char *web_content_type(const char *path) {
    const char *extension = strrchr(path, '.');
    if (!extension) {
        return "application/octet-stream";
    }
    if (strcmp(extension, ".html") == 0) return "text/html; charset=utf-8";
    if (strcmp(extension, ".css") == 0) return "text/css; charset=utf-8";
    if (strcmp(extension, ".js") == 0) return "application/javascript";
    if (strcmp(extension, ".json") == 0) return "application/json";
    if (strcmp(extension, ".svg") == 0) return "image/svg+xml";
    if (strcmp(extension, ".png") == 0) return "image/png";
    if (strcmp(extension, ".jpg") == 0 || strcmp(extension, ".jpeg") == 0) return "image/jpeg";
    if (strcmp(extension, ".ico") == 0) return "image/x-icon";
    if (strcmp(extension, ".woff") == 0) return "font/woff";
    if (strcmp(extension, ".woff2") == 0) return "font/woff2";
    if (strcmp(extension, ".wasm") == 0) return "application/wasm";
    return "application/octet-stream";
}

static esp_err_t web_file_handler(httpd_req_t *req) {
    if (!usb_host_msc_is_mounted()) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB web storage is not mounted");
    }

    size_t uri_len = strcspn(req->uri, "?");
    char uri_path[MAP_PATH_MAX];
    if (uri_len >= sizeof(uri_path)) {
        httpd_resp_send_err(req, HTTPD_414_URI_TOO_LONG, "URI too long");
        return ESP_OK;
    }
    memcpy(uri_path, req->uri, uri_len);
    uri_path[uri_len] = '\0';

    if (!is_safe_web_path(uri_path)) {
        httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid web path");
        return ESP_OK;
    }

    if (strcmp(uri_path, "/favicon.ico") == 0) {
        httpd_resp_set_status(req, "204 No Content");
        return httpd_resp_send(req, NULL, 0);
    }

    const char *relative_path = strcmp(uri_path, "/") == 0 ? "/index.html" : uri_path;
    char logical_path[MAP_PATH_MAX];
    int path_len = snprintf(logical_path, sizeof(logical_path), "%s%s", WEB_ROOT, relative_path);
    if (path_len < 0 || (size_t)path_len >= sizeof(logical_path)) {
        httpd_resp_send_err(req, HTTPD_414_URI_TOO_LONG, "Web path too long");
        return ESP_OK;
    }

    esp_err_t resolve_err = usb_storage_map_resolve(logical_path, logical_path, sizeof(logical_path));
    if (resolve_err == ESP_ERR_NOT_FOUND) {
        path_len = snprintf(logical_path, sizeof(logical_path), "/usb%s", relative_path);
        if (path_len < 0 || (size_t)path_len >= sizeof(logical_path)) {
            httpd_resp_send_err(req, HTTPD_414_URI_TOO_LONG, "Web path too long");
            return ESP_OK;
        }
        resolve_err = usb_storage_map_resolve(logical_path, logical_path, sizeof(logical_path));
    }
    if (resolve_err != ESP_OK) {
        ESP_LOGW(TAG, "Unable to resolve web path '%s': %s", logical_path, esp_err_to_name(resolve_err));
        httpd_err_code_t status = HTTPD_500_INTERNAL_SERVER_ERROR;
        const char *message = "Unable to resolve web path";
        if (resolve_err == ESP_ERR_NOT_FOUND) {
            status = HTTPD_404_NOT_FOUND;
            message = "Web file not found";
        } else if (resolve_err == ESP_ERR_INVALID_ARG) {
            status = HTTPD_400_BAD_REQUEST;
            message = "Invalid web path";
        } else if (resolve_err == ESP_ERR_INVALID_SIZE) {
            status = HTTPD_414_URI_TOO_LONG;
            message = "Web path too long";
        }
        httpd_resp_send_err(req, status, message);
        return ESP_OK;
    }

    FILE *file = fopen(logical_path, "rb");
    if (!file) {
        ESP_LOGW(TAG, "Web file not found: %s", logical_path);
        httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "Web file not found on USB drive");
        return ESP_OK;
    }

    httpd_resp_set_type(req, web_content_type(relative_path));

    size_t bytes_read;
    while ((bytes_read = fread(s_web_file_buffer, 1, sizeof(s_web_file_buffer), file)) > 0) {
        esp_err_t err = httpd_resp_send_chunk(req, s_web_file_buffer, bytes_read);
        if (err != ESP_OK) {
            fclose(file);
            return err;
        }
    }

    bool read_failed = ferror(file) != 0;
    fclose(file);
    if (read_failed) {
        ESP_LOGE(TAG, "Failed reading web file: %s", logical_path);
        return ESP_FAIL;
    }

    return httpd_resp_send_chunk(req, NULL, 0);
}

/* --------------------------------------------------------------------------
 * Handler: POST /api/system/ota  — initiate USB OTA update
 * Body (JSON): { "password": "<admin-password>" }
 * -------------------------------------------------------------------------- */
static esp_err_t ota_start_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 256) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid OTA request size");
    }
    char buf[256];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int got = httpd_req_recv(req, buf + received, (size_t)req->content_len - received);
        if (got <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete OTA request");
        received += (size_t)got;
    }
    buf[received] = '\0';

    cJSON *json = cJSON_Parse(buf);
    cJSON *pw   = json ? cJSON_GetObjectItemCaseSensitive(json, "password") : NULL;
    if (!cJSON_IsString(pw)) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "OTA request requires admin password");
    }
    bool ok = auth_verify_admin_password(pw->valuestring);
    cJSON_Delete(json);
    if (!ok) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required for OTA");
    }

    esp_err_t err = ota_manager_start_usb_update();
    httpd_resp_set_type(req, "application/json");
    if (err == ESP_ERR_INVALID_STATE) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "{\"error\":\"OTA update already in progress\"}");
    }
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "{\"error\":\"Failed to start OTA task\"}");
    }
    return httpd_resp_sendstr(req, "{\"started\":true}");
}

/* Handler: GET /api/system/ota/status — poll OTA progress */
static esp_err_t ota_status_handler(httpd_req_t *req) {
    static const char *const state_names[] = {
        "idle", "reading", "writing", "verifying", "done", "error"
    };
    ota_status_t status;
    ota_manager_get_status(&status);
    unsigned int state_idx = (unsigned int)status.state;
    if (state_idx >= sizeof(state_names) / sizeof(state_names[0])) {
        state_idx = 5;  /* error */
    }

    cJSON *root = cJSON_CreateObject();
    if (!root) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory");
    cJSON_AddStringToObject(root, "state", state_names[state_idx]);
    cJSON_AddNumberToObject(root, "progressPercent", status.progress_percent);
    cJSON_AddNumberToObject(root, "bytesWritten",    status.bytes_written);
    cJSON_AddNumberToObject(root, "totalBytes",      status.total_bytes);
    if (status.error_message[0] != '\0') {
        cJSON_AddStringToObject(root, "errorMessage", status.error_message);
    } else {
        cJSON_AddNullToObject(root, "errorMessage");
    }
    const char *json_str = cJSON_PrintUnformatted(root);
    if (!json_str) {
        cJSON_Delete(root);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to encode OTA status");
    }
    httpd_resp_set_type(req, "application/json");
    esp_err_t send_err = httpd_resp_send(req, json_str, HTTPD_RESP_USE_STRLEN);
    cJSON_free((void *)json_str);
    cJSON_Delete(root);
    return send_err;
}

/* Handler: POST /api/system/ota/abort — cancel in-progress OTA */
static esp_err_t ota_abort_handler(httpd_req_t *req) {
    ota_manager_abort();
    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, "{\"aborted\":true}");
}

/* Handler: POST /api/system/ota/upload — direct streaming OTA firmware upload */
static esp_err_t ota_upload_handler(httpd_req_t *req) {
    if (req->content_len <= 0) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Missing firmware binary payload");
    }

    esp_err_t err = ota_manager_begin_stream((size_t)req->content_len);
    if (err != ESP_OK) {
        httpd_resp_set_status(req, err == ESP_ERR_INVALID_STATE ? "409 Conflict" : "500 Internal Server Error");
        return httpd_resp_sendstr(req, "{\"error\":\"Unable to begin OTA stream\"}");
    }

    char *buf = malloc(STORAGE_UPLOAD_BUFFER_SIZE);
    if (!buf) {
        ota_manager_abort_stream();
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Out of memory for OTA stream buffer");
    }

    size_t remaining = (size_t)req->content_len;
    bool failed = false;

    while (remaining > 0) {
        size_t to_recv = remaining < STORAGE_UPLOAD_BUFFER_SIZE ? remaining : STORAGE_UPLOAD_BUFFER_SIZE;
        int received = httpd_req_recv(req, buf, to_recv);
        if (received <= 0) {
            failed = true;
            break;
        }
        err = ota_manager_write_stream_chunk(buf, (size_t)received);
        if (err != ESP_OK) {
            failed = true;
            break;
        }
        remaining -= (size_t)received;
    }
    free(buf);

    if (failed || remaining != 0) {
        ota_manager_abort_stream();
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OTA stream upload failed");
    }

    err = ota_manager_end_stream();
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "OTA stream finalization failed");
    }

    httpd_resp_set_type(req, "application/json");
    return httpd_resp_sendstr(req, "{\"success\":true,\"flashed\":true}");
}

static esp_err_t authorize_power_request(httpd_req_t *req, bool *authorized) {
    *authorized = false;
    if (req->content_len <= 0 || req->content_len >= 256) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid power request");
    }
    char buf[256];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int got = httpd_req_recv(req, buf + received, (size_t)req->content_len - received);
        if (got <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete power request");
        received += (size_t)got;
    }
    buf[received] = '\0';
    cJSON *json = cJSON_Parse(buf);
    cJSON *pw   = json ? cJSON_GetObjectItemCaseSensitive(json, "password") : NULL;
    bool ok = cJSON_IsString(pw) && auth_verify_admin_password(pw->valuestring);
    cJSON_Delete(json);
    if (!ok) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    *authorized = true;
    return ESP_OK;
}

/* Handler: POST /api/system/reboot — stage orderly ESP32 restart (admin required) */
static esp_err_t reboot_handler(httpd_req_t *req) {
    bool authorized;
    esp_err_t err = authorize_power_request(req, &authorized);
    if (err != ESP_OK || !authorized) return err;
    httpd_resp_set_type(req, "application/json");
    err = system_control_request_restart();
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "{\"error\":\"Power operation is busy or OTA is active\"}");
    }
    return httpd_resp_sendstr(req, "{\"rebooting\":true}");
}

/* Start the HTTP server */
static bool register_uri_handler(httpd_handle_t server, const httpd_uri_t *uri) {
    esp_err_t err = httpd_register_uri_handler(server, uri);
    if (err == ESP_OK) {
        return true;
    }
    ESP_LOGE(TAG, "Failed to register HTTP route %s: %s", uri->uri, esp_err_to_name(err));
    esp_err_t stop_err = httpd_stop(server);
    if (stop_err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to stop partially configured HTTP server: %s", esp_err_to_name(stop_err));
    }
    s_server = NULL;
    return false;
}

static esp_err_t platform_resources_handler(httpd_req_t *req)
{
    platform_resource_snapshot_t snap = app_platform_get_pressure();

    static const char *pressure_names[] = { "none", "low", "critical", "emergency" };
    const char *level_str = pressure_names[
        snap.level < 4 ? (int)snap.level : 0
    ];

    cJSON *root = cJSON_CreateObject();
    if (!root) {
        httpd_resp_send_500(req);
        return ESP_OK;
    }
    cJSON_AddStringToObject(root, "pressureLevel", level_str);
    cJSON_AddNumberToObject(root, "internalFreeBytes",    (double)snap.internal_free_bytes);
    cJSON_AddNumberToObject(root, "internalMinFreeBytes", (double)snap.internal_min_free_bytes);
    cJSON_AddNumberToObject(root, "psramFreeBytes",       (double)snap.psram_free_bytes);
    cJSON_AddBoolToObject  (root, "httpSuspended",        snap.http_suspended);
    cJSON_AddNumberToObject(root, "emergencyCount",       (double)snap.emergency_count);

    char *json_str = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json_str) {
        httpd_resp_send_500(req);
        return ESP_OK;
    }
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Access-Control-Allow-Origin", "*");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

/* Handler: GET /api/dns/stats - Get DNS ad-blocker statistics */
static esp_err_t dns_stats_handler(httpd_req_t *req) {
    dns_adblock_stats_t stats;
    esp_err_t err = dns_adblock_get_stats(&stats);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to get DNS stats");
    }
    cJSON *root = cJSON_CreateObject();
    if (!root) return httpd_resp_send_500(req);
    cJSON_AddNumberToObject(root, "total_queries", stats.total_queries);
    cJSON_AddNumberToObject(root, "blocked_queries", stats.blocked_queries);
    cJSON_AddNumberToObject(root, "allowed_queries", stats.allowed_queries);
    cJSON_AddNumberToObject(root, "failed_queries", stats.failed_queries);
    cJSON_AddNumberToObject(root, "cached_entries", stats.cached_entries);
    cJSON_AddNumberToObject(root, "psram_used_bytes", stats.psram_used_bytes);
    cJSON_AddNumberToObject(root, "psram_free_bytes", stats.psram_free_bytes);
    cJSON_AddNumberToObject(root, "uptime_ms", (double)esp_timer_get_time() / 1000.0);
    cJSON_AddBoolToObject(root, "running", stats.running);
    dns_adblock_config_t config;
    if (dns_adblock_get_config(&config) == ESP_OK) {
        cJSON_AddBoolToObject(root, "enabled", config.enabled);
        cJSON_AddBoolToObject(root, "log_queries", config.log_queries);
        cJSON_AddNumberToObject(root, "port", config.port);
        cJSON_AddStringToObject(root, "upstream_dns", config.upstream_dns);
    }
    if (stats.last_error[0]) {
        cJSON_AddStringToObject(root, "last_error", stats.last_error);
    }
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    free(json);
    return ESP_OK;
}

/* Handler: POST /api/dns/config - Update DNS ad-blocker config */
static esp_err_t dns_config_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 512) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid config size");
    }
    char admin_password[128];
    if (httpd_req_get_hdr_value_str(req, "X-Admin-Password", admin_password, sizeof(admin_password)) != ESP_OK ||
        !auth_verify_admin_password(admin_password)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    char buf[512];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int got = httpd_req_recv(req, buf + received, (size_t)req->content_len - received);
        if (got <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete config request");
        received += got;
    }
    buf[received] = '\0';
    cJSON *json = cJSON_Parse(buf);
    if (!json) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
    cJSON *enabled = cJSON_GetObjectItemCaseSensitive(json, "enabled");
    cJSON *upstream = cJSON_GetObjectItemCaseSensitive(json, "upstream_dns");
    cJSON *port = cJSON_GetObjectItemCaseSensitive(json, "port");
    cJSON *log_queries = cJSON_GetObjectItemCaseSensitive(json, "log_queries");
    dns_adblock_config_t config;
    dns_adblock_get_config(&config);
    if (cJSON_IsBool(enabled)) config.enabled = cJSON_IsTrue(enabled);
    if (cJSON_IsString(upstream)) strlcpy(config.upstream_dns, upstream->valuestring, sizeof(config.upstream_dns));
    if (cJSON_IsNumber(port)) config.port = (uint16_t)port->valueint;
    if (cJSON_IsBool(log_queries)) config.log_queries = cJSON_IsTrue(log_queries);
    cJSON_Delete(json);
    esp_err_t err = dns_adblock_set_config(&config);
    if (err == ESP_OK) err = dns_adblock_save_config_to_usb();
    if (err != ESP_OK) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to persist DNS configuration to internal LittleFS");
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

static esp_err_t dns_domains_get_handler(httpd_req_t *req) {
    char query[64];
    size_t offset = 0;
    int blocked_filter = -1;
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        char value[24];
        if (httpd_query_key_value(query, "offset", value, sizeof(value)) == ESP_OK) {
            char *end = NULL;
            unsigned long parsed = strtoul(value, &end, 10);
            if (end == value || *end != '\0' || parsed > SIZE_MAX) {
                return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid DNS rule offset");
            }
            offset = (size_t)parsed;
        }
        if (httpd_query_key_value(query, "blocked", value, sizeof(value)) == ESP_OK) {
            if (strcmp(value, "true") == 0) blocked_filter = 1;
            else if (strcmp(value, "false") == 0) blocked_filter = 0;
            else return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid DNS rule filter");
        }
    }
    enum { DNS_RULE_PAGE_SIZE = 40 };
    dns_adblock_domain_rule_t *rules = heap_caps_malloc(
        sizeof(*rules) * DNS_RULE_PAGE_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!rules) rules = malloc(sizeof(*rules) * DNS_RULE_PAGE_SIZE);
    if (!rules) return httpd_resp_send_500(req);
    size_t count = 0;
    size_t total = 0;
    esp_err_t err = dns_adblock_list_domains_page(
        rules, DNS_RULE_PAGE_SIZE, offset, blocked_filter, &count, &total);
    if (err != ESP_OK) {
        free(rules);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to list DNS rules");
    }
    cJSON *root = cJSON_CreateObject();
    if (!root) {
        free(rules);
        return httpd_resp_send_500(req);
    }
    cJSON *items = cJSON_AddArrayToObject(root, "rules");
    if (!items) {
        free(rules);
        cJSON_Delete(root);
        return httpd_resp_send_500(req);
    }
    for (size_t i = 0; i < count; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddStringToObject(item, "domain", rules[i].domain);
        cJSON_AddBoolToObject(item, "blocked", rules[i].blocked);
        cJSON_AddBoolToObject(item, "regex", rules[i].regex);
        cJSON_AddNumberToObject(item, "hit_count", rules[i].hit_count);
        cJSON_AddItemToArray(items, item);
    }
    cJSON_AddNumberToObject(root, "total", total);
    cJSON_AddNumberToObject(root, "offset", offset);
    char *json = cJSON_PrintUnformatted(root);
    free(rules);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    cJSON_free(json);
    return ESP_OK;
}

static bool get_dns_history_date(httpd_req_t *req, char *date, size_t date_size) {
    char query[32];
    if (httpd_req_get_url_query_str(req, query, sizeof(query)) == ESP_OK) {
        if (httpd_query_key_value(query, "date", date, date_size) != ESP_OK) return false;
    } else {
        time_t now = time(NULL) + 8 * 3600;
        struct tm utc_time;
        if (now < 1704067200 || !gmtime_r(&now, &utc_time) ||
            strftime(date, date_size, "%Y-%m-%d", &utc_time) != 10) return false;
    }
    if (strlen(date) != 10 || date[4] != '-' || date[7] != '-') return false;
    for (size_t i = 0; i < 10; i++) {
        if (i == 4 || i == 7) continue;
        if (date[i] < '0' || date[i] > '9') return false;
    }
    return true;
}

static esp_err_t dns_log_get_handler(httpd_req_t *req) {
    enum { DNS_LOG_RESPONSE_SIZE = 32 };
    char date[11];
    if (!get_dns_history_date(req, date, sizeof(date))) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid or unavailable DNS history date");
    }
    dns_adblock_log_entry_t *entries = heap_caps_malloc(
        sizeof(*entries) * DNS_LOG_RESPONSE_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!entries) entries = malloc(sizeof(*entries) * DNS_LOG_RESPONSE_SIZE);
    if (!entries) return httpd_resp_send_500(req);

    size_t count = 0;
    esp_err_t err = dns_adblock_get_log_for_date(date, entries, DNS_LOG_RESPONSE_SIZE, &count);
    if (err != ESP_OK) {
        free(entries);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to read DNS request log");
    }
    cJSON *root = cJSON_CreateObject();
    cJSON *items = root ? cJSON_AddArrayToObject(root, "entries") : NULL;
    if (!root || !items) {
        free(entries);
        cJSON_Delete(root);
        return httpd_resp_send_500(req);
    }
    for (size_t i = 0; i < count; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddNumberToObject(item, "timestamp_ms", (double)entries[i].timestamp_ms);
        cJSON_AddStringToObject(item, "domain", entries[i].domain);
        cJSON_AddStringToObject(item, "client_ip", entries[i].client_ip);
        cJSON_AddStringToObject(item, "status",
            entries[i].status == DNS_ADBLOCK_LOG_BLOCKED ? "blocked" :
                entries[i].status == DNS_ADBLOCK_LOG_FAILED ? "failed" : "allowed");
        cJSON_AddItemToArray(items, item);
    }
    char *json = cJSON_PrintUnformatted(root);
    free(entries);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, json);
    cJSON_free(json);
    return ESP_OK;
}

static esp_err_t dns_analytics_get_handler(httpd_req_t *req) {
    enum { DNS_ANALYTICS_BUCKETS = 24, DNS_ANALYTICS_TOP_COUNT = 5, DNS_ANALYTICS_SAMPLE_SIZE = 512 };
    typedef struct {
        const char *domain;
        uint32_t count;
    } dns_top_query_t;
    typedef struct {
        const char *client_ip;
        uint32_t count;
    } dns_top_client_t;

    char date[11];
    if (!get_dns_history_date(req, date, sizeof(date))) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid or unavailable DNS history date");
    }
    dns_adblock_log_entry_t *entries = heap_caps_malloc(
        sizeof(*entries) * DNS_ANALYTICS_SAMPLE_SIZE, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!entries) entries = malloc(sizeof(*entries) * DNS_ANALYTICS_SAMPLE_SIZE);
    if (!entries) return httpd_resp_send_500(req);

    size_t count = 0;
    esp_err_t err = dns_adblock_get_log_for_date(date, entries, DNS_ANALYTICS_SAMPLE_SIZE, &count);
    if (err != ESP_OK) {
        free(entries);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to read DNS analytics");
    }
    dns_adblock_daily_summary_t summary;
    err = dns_adblock_get_daily_summary(date, &summary);
    if (err != ESP_OK) {
        free(entries);
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to summarize DNS history");
    }
    dns_top_query_t top[DNS_ANALYTICS_TOP_COUNT] = {0};
    dns_top_client_t top_clients[DNS_ANALYTICS_TOP_COUNT] = {0};
    for (size_t i = 0; i < count; i++) {
        bool seen_before = false;
        for (size_t j = 0; j < i; j++) {
            if (strcmp(entries[j].domain, entries[i].domain) == 0) {
                seen_before = true;
                break;
            }
        }
        if (seen_before) continue;
        uint32_t query_count = 0;
        for (size_t j = i; j < count; j++) {
            if (strcmp(entries[i].domain, entries[j].domain) == 0) query_count++;
        }
        size_t position = DNS_ANALYTICS_TOP_COUNT;
        for (size_t j = 0; j < DNS_ANALYTICS_TOP_COUNT; j++) {
            if (top[j].domain == NULL || query_count > top[j].count) {
                position = j;
                break;
            }
        }
        if (position < DNS_ANALYTICS_TOP_COUNT) {
            for (size_t j = DNS_ANALYTICS_TOP_COUNT - 1; j > position; j--) top[j] = top[j - 1];
            top[position].domain = entries[i].domain;
            top[position].count = query_count;
        }

    }

    for (size_t i = 0; i < count; i++) {
        bool seen_before = false;
        for (size_t j = 0; j < i; j++) {
            if (strcmp(entries[j].client_ip, entries[i].client_ip) == 0) {
                seen_before = true;
                break;
            }
        }
        if (seen_before) continue;
        uint32_t client_count = 0;
        for (size_t j = i; j < count; j++) {
            if (strcmp(entries[i].client_ip, entries[j].client_ip) == 0) client_count++;
        }
        size_t position = DNS_ANALYTICS_TOP_COUNT;
        for (size_t j = 0; j < DNS_ANALYTICS_TOP_COUNT; j++) {
            if (top_clients[j].client_ip == NULL || client_count > top_clients[j].count) {
                position = j;
                break;
            }
        }
        if (position < DNS_ANALYTICS_TOP_COUNT) {
            for (size_t j = DNS_ANALYTICS_TOP_COUNT - 1; j > position; j--) {
                top_clients[j] = top_clients[j - 1];
            }
            top_clients[position].client_ip = entries[i].client_ip;
            top_clients[position].count = client_count;
        }
    }

    cJSON *root = cJSON_CreateObject();
    cJSON *timeline = root ? cJSON_AddArrayToObject(root, "timeline") : NULL;
    cJSON *top_queries = root ? cJSON_AddArrayToObject(root, "top_queries") : NULL;
    cJSON *clients = root ? cJSON_AddArrayToObject(root, "top_clients") : NULL;
    if (!root || !timeline || !top_queries || !clients) {
        free(entries);
        cJSON_Delete(root);
        return httpd_resp_send_500(req);
    }
    for (size_t i = 0; i < DNS_ANALYTICS_BUCKETS; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddNumberToObject(item, "hour", i);
        cJSON_AddNumberToObject(item, "allowed", summary.hourly_allowed[i]);
        cJSON_AddNumberToObject(item, "blocked", summary.hourly_blocked[i]);
        cJSON_AddNumberToObject(item, "failed", summary.hourly_failed[i]);
        cJSON_AddItemToArray(timeline, item);
    }
    for (size_t i = 0; i < DNS_ANALYTICS_TOP_COUNT && top[i].domain; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddStringToObject(item, "domain", top[i].domain);
        cJSON_AddNumberToObject(item, "count", top[i].count);
        cJSON_AddItemToArray(top_queries, item);
    }
    for (size_t i = 0; i < DNS_ANALYTICS_TOP_COUNT && top_clients[i].client_ip; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddStringToObject(item, "client_ip", top_clients[i].client_ip);
        cJSON_AddNumberToObject(item, "count", top_clients[i].count);
        cJSON_AddItemToArray(clients, item);
    }
    cJSON_AddNumberToObject(root, "allowed", summary.allowed);
    cJSON_AddNumberToObject(root, "blocked", summary.blocked);
    cJSON_AddNumberToObject(root, "failed", summary.failed);
    cJSON_AddNumberToObject(root, "sample_size", (double)summary.total_queries);
    cJSON_AddNumberToObject(root, "top_query_sample_size", count);
    cJSON_AddStringToObject(root, "date", date);
    cJSON_AddStringToObject(root, "history_source",
        "UTC+8 daily history is appended to internal LittleFS and survives reboot");
    char *json = cJSON_PrintUnformatted(root);
    free(entries);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, json);
    cJSON_free(json);
    return ESP_OK;
}

static const char *dns_adlist_type_name(dns_adblock_list_type_t type) {
    switch (type) {
        case DNS_ADBLOCK_LIST_TYPE_ADS: return "ads";
        case DNS_ADBLOCK_LIST_TYPE_TRACKING: return "tracking";
        case DNS_ADBLOCK_LIST_TYPE_MALWARE: return "malware";
        case DNS_ADBLOCK_LIST_TYPE_CUSTOM: return "custom";
        default: return "custom";
    }
}

static esp_err_t dns_adlists_get_handler(httpd_req_t *req) {
    dns_adblock_list_info_t lists[DNS_ADBLOCK_MAX_LIST_URLS];
    size_t count = 0;
    esp_err_t err = dns_adblock_get_blocklists(lists, DNS_ADBLOCK_MAX_LIST_URLS, &count);
    if (err != ESP_OK) return httpd_resp_send_500(req);
    cJSON *root = cJSON_CreateObject();
    cJSON *items = root ? cJSON_AddArrayToObject(root, "lists") : NULL;
    if (!root || !items) {
        cJSON_Delete(root);
        return httpd_resp_send_500(req);
    }
    for (size_t i = 0; i < count; i++) {
        cJSON *item = cJSON_CreateObject();
        if (!item) continue;
        cJSON_AddNumberToObject(item, "index", i);
        cJSON_AddStringToObject(item, "url", lists[i].url);
        cJSON_AddStringToObject(item, "type", dns_adlist_type_name(lists[i].type));
        cJSON_AddBoolToObject(item, "enabled", lists[i].enabled);
        cJSON_AddStringToObject(item, "last_updated", lists[i].last_updated);
        cJSON_AddNumberToObject(item, "entry_count", lists[i].entry_count);
        cJSON_AddItemToArray(items, item);
    }
    portENTER_CRITICAL(&s_dns_adlist_update_mux);
    bool update_running = s_dns_adlist_update_running;
    esp_err_t update_result = s_dns_adlist_update_result;
    portEXIT_CRITICAL(&s_dns_adlist_update_mux);
    cJSON_AddBoolToObject(root, "update_running", update_running);
    cJSON_AddStringToObject(root, "update_status", update_running
        ? "Updating enabled adlists" : update_result == ESP_OK ? "Ready" : esp_err_to_name(update_result));
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    httpd_resp_sendstr(req, json);
    cJSON_free(json);
    return ESP_OK;
}

static bool dns_adlist_admin_authorized(httpd_req_t *req) {
    char password[128];
    return httpd_req_get_hdr_value_str(req, "X-Admin-Password", password, sizeof(password)) == ESP_OK &&
        auth_verify_admin_password(password);
}

static esp_err_t dns_adlists_post_handler(httpd_req_t *req) {
    if (!dns_adlist_admin_authorized(req)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    portENTER_CRITICAL(&s_dns_adlist_update_mux);
    bool update_running = s_dns_adlist_update_running;
    portEXIT_CRITICAL(&s_dns_adlist_update_mux);
    if (update_running) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "Wait for the current adlist update to finish");
    }
    if (req->content_len <= 0 || req->content_len >= 512) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid adlist request size");
    }
    char body[512];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int count = httpd_req_recv(req, body + received, (size_t)req->content_len - received);
        if (count <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete adlist request");
        received += (size_t)count;
    }
    body[received] = '\0';
    cJSON *json = cJSON_Parse(body);
    cJSON *action = json ? cJSON_GetObjectItemCaseSensitive(json, "action") : NULL;
    cJSON *index = json ? cJSON_GetObjectItemCaseSensitive(json, "index") : NULL;
    esp_err_t err = ESP_ERR_INVALID_ARG;
    if (cJSON_IsString(action) && strcmp(action->valuestring, "add") == 0) {
        cJSON *url = cJSON_GetObjectItemCaseSensitive(json, "url");
        cJSON *type = cJSON_GetObjectItemCaseSensitive(json, "type");
        if (cJSON_IsString(url) && cJSON_IsNumber(type) &&
            type->valueint >= DNS_ADBLOCK_LIST_TYPE_ADS && type->valueint <= DNS_ADBLOCK_LIST_TYPE_CUSTOM) {
            err = dns_adblock_add_blocklist(url->valuestring, (dns_adblock_list_type_t)type->valueint);
        }
    } else if (cJSON_IsString(action) && cJSON_IsNumber(index) && index->valueint >= 0 &&
               index->valueint < DNS_ADBLOCK_MAX_LIST_URLS) {
        size_t list_index = (size_t)index->valueint;
        if (strcmp(action->valuestring, "remove") == 0) {
            err = dns_adblock_remove_blocklist(list_index);
            if (err == ESP_OK) err = dns_adblock_save_rules_to_usb();
        } else if (strcmp(action->valuestring, "enable") == 0 ||
                   strcmp(action->valuestring, "disable") == 0) {
            err = dns_adblock_enable_blocklist(list_index, strcmp(action->valuestring, "enable") == 0);
            if (err == ESP_OK) err = dns_adblock_save_rules_to_usb();
        }
    }
    cJSON_Delete(json);
    if (err == ESP_OK) err = dns_adblock_save_blocklists_to_usb();
    if (err != ESP_OK) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, esp_err_to_name(err));
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

static void dns_adlist_update_task(void *arg) {
    (void)arg;
    esp_err_t result = dns_adblock_update_blocklists();
    portENTER_CRITICAL(&s_dns_adlist_update_mux);
    s_dns_adlist_update_result = result;
    s_dns_adlist_update_running = false;
    portEXIT_CRITICAL(&s_dns_adlist_update_mux);
    vTaskDelete(NULL);
}

static esp_err_t dns_adlists_update_handler(httpd_req_t *req) {
    if (!dns_adlist_admin_authorized(req)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    portENTER_CRITICAL(&s_dns_adlist_update_mux);
    if (s_dns_adlist_update_running) {
        portEXIT_CRITICAL(&s_dns_adlist_update_mux);
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "An adlist update is already running");
    }
    s_dns_adlist_update_running = true;
    s_dns_adlist_update_result = ESP_OK;
    portEXIT_CRITICAL(&s_dns_adlist_update_mux);
    if (xTaskCreate(dns_adlist_update_task, "dns_adlists", 12288, NULL, 4, NULL) != pdPASS) {
        portENTER_CRITICAL(&s_dns_adlist_update_mux);
        s_dns_adlist_update_running = false;
        s_dns_adlist_update_result = ESP_ERR_NO_MEM;
        portEXIT_CRITICAL(&s_dns_adlist_update_mux);
        return httpd_resp_send_500(req);
    }
    return httpd_resp_sendstr(req, "{\"success\":true,\"started\":true}");
}

static esp_err_t dns_domain_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 640) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid rule size");
    char password[128];
    if (httpd_req_get_hdr_value_str(req, "X-Admin-Password", password, sizeof(password)) != ESP_OK ||
        !auth_verify_admin_password(password)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    char body[640];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int count = httpd_req_recv(req, body + received, (size_t)req->content_len - received);
        if (count <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete rule request");
        received += (size_t)count;
    }
    body[received] = '\0';
    cJSON *json = cJSON_Parse(body);
    cJSON *domain = json ? cJSON_GetObjectItemCaseSensitive(json, "domain") : NULL;
    cJSON *blocked = json ? cJSON_GetObjectItemCaseSensitive(json, "blocked") : NULL;
    cJSON *remove = json ? cJSON_GetObjectItemCaseSensitive(json, "remove") : NULL;
    cJSON *regex = json ? cJSON_GetObjectItemCaseSensitive(json, "regex") : NULL;
    if (!cJSON_IsString(domain) ||
        (regex && !cJSON_IsBool(regex)) ||
        (remove && !cJSON_IsBool(remove)) ||
        (!cJSON_IsTrue(remove) && !cJSON_IsBool(blocked))) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Rule pattern and action are required");
    }
    bool is_regex = cJSON_IsTrue(regex);
    esp_err_t err = cJSON_IsTrue(remove)
        ? (is_regex ? dns_adblock_remove_regex(domain->valuestring) :
            dns_adblock_remove_domain(domain->valuestring))
        : (is_regex ? dns_adblock_add_regex(domain->valuestring, cJSON_IsTrue(blocked)) :
            dns_adblock_add_domain(domain->valuestring, cJSON_IsTrue(blocked)));
    cJSON_Delete(json);
    if (err == ESP_ERR_INVALID_ARG) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid domain or regular expression");
    }
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to apply DNS rule");
    }
    err = dns_adblock_save_rules_to_usb();
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to persist DNS rules to internal LittleFS");
    }
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

static esp_err_t profile_create_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 384) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid profile request size");
    char password[128];
    if (httpd_req_get_hdr_value_str(req, "X-Admin-Password", password, sizeof(password)) != ESP_OK ||
        !auth_verify_admin_password(password)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    char body[384];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int count = httpd_req_recv(req, body + received, (size_t)req->content_len - received);
        if (count <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete profile request");
        received += (size_t)count;
    }
    body[received] = '\0';
    cJSON *json = cJSON_Parse(body);
    cJSON *name = json ? cJSON_GetObjectItemCaseSensitive(json, "name") : NULL;
    cJSON *display = json ? cJSON_GetObjectItemCaseSensitive(json, "display_name") : NULL;
    cJSON *admin = json ? cJSON_GetObjectItemCaseSensitive(json, "is_admin") : NULL;
    if (!cJSON_IsString(name) || !cJSON_IsString(display)) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Profile name and display name are required");
    }
    esp_err_t err = profile_manager_create_profile(name->valuestring, display->valuestring, cJSON_IsTrue(admin));
    cJSON_Delete(json);
    if (err != ESP_OK) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Unable to create USB profile");
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

static bool request_profile_name(httpd_req_t *req, char *name, size_t name_size, bool create_if_missing) {
    bool explicit_name = httpd_req_get_hdr_value_str(req, "X-Profile-Name", name, name_size) == ESP_OK;
    if (!explicit_name) {
        size_t query_length = httpd_req_get_url_query_len(req);
        if (query_length == 0) return profile_manager_get_active_profile(name, name_size) == ESP_OK;
        char query[128];
        if (query_length >= sizeof(query) ||
            httpd_req_get_url_query_str(req, query, sizeof(query)) != ESP_OK ||
            httpd_query_key_value(query, "profile", name, name_size) != ESP_OK) {
            return false;
        }
        explicit_name = true;
    }
    if (explicit_name && !profile_manager_profile_exists(name) && create_if_missing) {
        if (profile_manager_create_profile(name, name, false) != ESP_OK) return false;
    }
    return profile_manager_profile_exists(name);
}

static esp_err_t auth_password_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 384) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid password request size");
    char body[384];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int count = httpd_req_recv(req, body + received, (size_t)req->content_len - received);
        if (count <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete password request");
        received += (size_t)count;
    }
    body[received] = '\0';
    cJSON *json = cJSON_Parse(body);
    cJSON *username = json ? cJSON_GetObjectItemCaseSensitive(json, "username") : NULL;
    cJSON *current = json ? cJSON_GetObjectItemCaseSensitive(json, "current_password") : NULL;
    cJSON *next = json ? cJSON_GetObjectItemCaseSensitive(json, "new_password") : NULL;
    user_account_t account;
    bool authorized = cJSON_IsString(username) && cJSON_IsString(current) && cJSON_IsString(next) &&
        strlen(next->valuestring) >= 8 && auth_verify_login(username->valuestring, current->valuestring, &account) && account.is_admin;
    bool saved = authorized && auth_set_admin_password(username->valuestring, next->valuestring);
    cJSON_Delete(json);
    if (!saved) {
        httpd_resp_set_status(req, authorized ? "500 Internal Server Error" : "403 Forbidden");
        return httpd_resp_sendstr(req, authorized ? "Unable to persist administrator password" : "Administrator credentials are invalid");
    }
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

/* Handler: GET /api/profiles/list - List all profiles */
static esp_err_t profiles_list_handler(httpd_req_t *req) {
    profile_info_t profiles[MAX_PROFILES];
    size_t count = 0;
    esp_err_t err = profile_manager_list_profiles(profiles, MAX_PROFILES, &count);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Failed to list profiles");
    }
    cJSON *root = cJSON_CreateArray();
    if (!root) return httpd_resp_send_500(req);
    for (size_t i = 0; i < count; i++) {
        cJSON *p = cJSON_CreateObject();
        cJSON_AddStringToObject(p, "name", profiles[i].name);
        cJSON_AddStringToObject(p, "display_name", profiles[i].display_name);
        cJSON_AddBoolToObject(p, "is_admin", profiles[i].is_admin);
        cJSON_AddBoolToObject(p, "is_default", profiles[i].is_default);
        cJSON_AddItemToArray(root, p);
    }
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    free(json);
    return ESP_OK;
}

/* Handler: POST /api/profiles/switch - Switch active profile */
static esp_err_t profiles_switch_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 128) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid profile name size");
    }
    char buf[128];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int got = httpd_req_recv(req, buf + received, (size_t)req->content_len - received);
        if (got <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete request");
        received += got;
    }
    buf[received] = '\0';
    cJSON *json = cJSON_Parse(buf);
    if (!json) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
    cJSON *name = cJSON_GetObjectItemCaseSensitive(json, "name");
    if (!cJSON_IsString(name)) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Profile name required");
    }
    esp_err_t err = profile_manager_switch_profile(name->valuestring);
    cJSON_Delete(json);
    if (err != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Failed to switch profile");
    }
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

/* Handler: GET /api/profiles/current - Get current profile info */
static esp_err_t profiles_current_handler(httpd_req_t *req) {
    char name[MAX_PROFILE_NAME_LEN];
    profile_manager_get_active_profile(name, sizeof(name));
    profile_info_t info = {0};
    profile_manager_get_profile_info(name, &info);
    cJSON *root = cJSON_CreateObject();
    if (!root) return httpd_resp_send_500(req);
    cJSON_AddStringToObject(root, "name", name);
    cJSON_AddStringToObject(root, "display_name", info.display_name);
    cJSON_AddBoolToObject(root, "is_admin", info.is_admin);
    cJSON_AddBoolToObject(root, "is_default", info.is_default);
    cJSON_AddBoolToObject(root, "storage_isolated", profile_manager_is_storage_compartmentalized(name));
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    free(json);
    return ESP_OK;
}

/* Handler: GET /api/auth/current-user - Get current authenticated user */
static esp_err_t auth_current_user_handler(httpd_req_t *req) {
    char name[MAX_PROFILE_NAME_LEN];
    profile_manager_get_active_profile(name, sizeof(name));
    cJSON *root = cJSON_CreateObject();
    if (!root) return httpd_resp_send_500(req);
    cJSON_AddStringToObject(root, "username", name);
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    free(json);
    return ESP_OK;
}

static esp_err_t profile_settings_get_handler(httpd_req_t *req) {
    char name[MAX_PROFILE_NAME_LEN];
    profile_settings_t settings;
    if (!request_profile_name(req, name, sizeof(name), false) ||
        profile_manager_load_settings(name, &settings) != ESP_OK) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB profile settings are unavailable");
    }
    cJSON *root = cJSON_CreateObject();
    if (!root) return httpd_resp_send_500(req);
    cJSON_AddStringToObject(root, "profile_name", settings.profile_name);
    cJSON_AddStringToObject(root, "theme", settings.theme);
    cJSON_AddBoolToObject(root, "dark_mode", settings.dark_mode);
    cJSON_AddNumberToObject(root, "wallpaper_mode", settings.wallpaper_mode);
    cJSON_AddNumberToObject(root, "screen_resolution", settings.screen_resolution);
    cJSON_AddBoolToObject(root, "taskbar_locked", settings.taskbar_locked);
    cJSON_AddBoolToObject(root, "show_desktop_icons", settings.show_desktop_icons);
    cJSON_AddBoolToObject(root, "transparency_enabled", settings.transparency_enabled);
    cJSON_AddNumberToObject(root, "sound_volume", settings.sound_volume);
    cJSON_AddBoolToObject(root, "notifications_enabled", settings.notifications_enabled);
    char *json = cJSON_PrintUnformatted(root);
    cJSON_Delete(root);
    if (!json) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json);
    cJSON_free(json);
    return ESP_OK;
}

static esp_err_t profile_settings_save_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 768) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid settings size");
    char body[768];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int count = httpd_req_recv(req, body + received, (size_t)req->content_len - received);
        if (count <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete settings request");
        received += (size_t)count;
    }
    body[received] = '\0';
    cJSON *root = cJSON_Parse(body);
    if (!root) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid settings JSON");
    char name[MAX_PROFILE_NAME_LEN];
    profile_settings_t settings;
    if (!request_profile_name(req, name, sizeof(name), false) ||
        profile_manager_load_settings(name, &settings) != ESP_OK) {
        cJSON_Delete(root);
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "USB profile settings are unavailable");
    }
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, "theme");
    if (cJSON_IsString(item)) strlcpy(settings.theme, item->valuestring, sizeof(settings.theme));
    item = cJSON_GetObjectItemCaseSensitive(root, "dark_mode");
    if (cJSON_IsBool(item)) settings.dark_mode = cJSON_IsTrue(item);
    item = cJSON_GetObjectItemCaseSensitive(root, "sound_volume");
    if (cJSON_IsNumber(item)) settings.sound_volume = item->valueint < 0 ? 0 : item->valueint > 100 ? 100 : item->valueint;
    item = cJSON_GetObjectItemCaseSensitive(root, "notifications_enabled");
    if (cJSON_IsBool(item)) settings.notifications_enabled = cJSON_IsTrue(item);
    cJSON_Delete(root);
    esp_err_t err = profile_manager_save_settings(name, &settings);
    if (err != ESP_OK) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to save settings to USB");
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

static esp_err_t wallpaper_get_handler(httpd_req_t *req) {
    static const char *extensions[] = {"jpg", "png", "webp"};
    char profile[MAX_PROFILE_NAME_LEN];
    if (!request_profile_name(req, profile, sizeof(profile), false)) {
        httpd_resp_set_status(req, "503 Service Unavailable");
        return httpd_resp_sendstr(req, "No active profile");
    }
    char logical[192], physical[256];
    FILE *file = NULL;
    const char *selected_extension = NULL;
    for (size_t i = 0; i < sizeof(extensions) / sizeof(extensions[0]); i++) {
        snprintf(logical, sizeof(logical), "/usb/profiles/%s/wallpaper/wallpaper.%s", profile, extensions[i]);
        if (usb_storage_map_resolve(logical, physical, sizeof(physical)) == ESP_OK) {
            file = fopen(physical, "rb");
            if (file) { selected_extension = extensions[i]; break; }
        }
    }
    if (!file) return httpd_resp_send_err(req, HTTPD_404_NOT_FOUND, "No profile wallpaper is saved");
    httpd_resp_set_type(req, strcmp(selected_extension, "png") == 0 ? "image/png" :
                        strcmp(selected_extension, "webp") == 0 ? "image/webp" : "image/jpeg");
    httpd_resp_set_hdr(req, "Cache-Control", "no-store");
    char buffer[1024];
    size_t count;
    while ((count = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        if (httpd_resp_send_chunk(req, buffer, count) != ESP_OK) { fclose(file); return ESP_FAIL; }
    }
    fclose(file);
    return httpd_resp_send_chunk(req, NULL, 0);
}

static esp_err_t wallpaper_upload_handler(httpd_req_t *req) {
    if (req->content_len == 0) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Wallpaper upload is empty");
    }
    char password[128], content_type[64];
    if (httpd_req_get_hdr_value_str(req, "X-Admin-Password", password, sizeof(password)) != ESP_OK ||
        !auth_verify_admin_password(password)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    if (httpd_req_get_hdr_value_str(req, "Content-Type", content_type, sizeof(content_type)) != ESP_OK) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Wallpaper content type is required");
    }
    const char *format = strcmp(content_type, "image/png") == 0 ? "png" :
                         strcmp(content_type, "image/webp") == 0 ? "webp" :
                         strcmp(content_type, "image/jpeg") == 0 ? "jpg" : NULL;
    if (!format) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Use JPEG, PNG, or WebP wallpaper");
    uint8_t *data = heap_caps_malloc(req->content_len, MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!data) data = malloc(req->content_len);
    if (!data) return httpd_resp_send_500(req);
    size_t received = 0;
    while (received < req->content_len) {
        int count = httpd_req_recv(req, (char *)data + received, req->content_len - received);
        if (count <= 0) { free(data); return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete wallpaper upload"); }
        received += (size_t)count;
    }
    char profile[MAX_PROFILE_NAME_LEN];
    esp_err_t err = request_profile_name(req, profile, sizeof(profile), true) ? ESP_OK : ESP_ERR_INVALID_ARG;
    if (err == ESP_OK) err = profile_manager_save_wallpaper(profile, data, received, format);
    free(data);
    if (err != ESP_OK) return httpd_resp_send_err(req, HTTPD_500_INTERNAL_SERVER_ERROR, "Unable to save wallpaper to USB");
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

static esp_err_t profile_isolation_handler(httpd_req_t *req) {
    char password[128];
    if (httpd_req_get_hdr_value_str(req, "X-Admin-Password", password, sizeof(password)) != ESP_OK ||
        !auth_verify_admin_password(password)) {
        httpd_resp_set_status(req, "403 Forbidden");
        return httpd_resp_sendstr(req, "Administrator authorization required");
    }
    if (req->content_len <= 0 || req->content_len >= 128) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid isolation request");
    char body[128];
    int count = httpd_req_recv(req, body, sizeof(body) - 1);
    if (count <= 0 || (size_t)count != req->content_len) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete isolation request");
    body[count] = '\0';
    cJSON *root = cJSON_Parse(body);
    cJSON *enabled = root ? cJSON_GetObjectItemCaseSensitive(root, "enabled") : NULL;
    char profile[MAX_PROFILE_NAME_LEN];
    esp_err_t err = cJSON_IsBool(enabled) && request_profile_name(req, profile, sizeof(profile), false)
        ? profile_manager_compartmentalize_storage(profile, cJSON_IsTrue(enabled)) : ESP_ERR_INVALID_ARG;
    cJSON_Delete(root);
    if (err != ESP_OK) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Unable to update profile isolation on USB");
    return httpd_resp_sendstr(req, "{\"success\":true}");
}

/* Handler: POST /api/terminal/exec - Execute terminal command */
static esp_err_t terminal_exec_handler(httpd_req_t *req) {
    if (req->content_len <= 0 || req->content_len >= 256) {
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid command size");
    }
    char buf[256];
    size_t received = 0;
    while (received < (size_t)req->content_len) {
        int got = httpd_req_recv(req, buf + received, (size_t)req->content_len - received);
        if (got <= 0) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Incomplete command");
        received += got;
    }
    buf[received] = '\0';
    cJSON *json = cJSON_Parse(buf);
    if (!json) return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Invalid JSON");
    cJSON *cmd = cJSON_GetObjectItemCaseSensitive(json, "command");
    char command[128];
    if (!cJSON_IsString(cmd) || strlcpy(command, cmd->valuestring, sizeof(command)) >= sizeof(command)) {
        cJSON_Delete(json);
        return httpd_resp_send_err(req, HTTPD_400_BAD_REQUEST, "Command required");
    }
    cJSON_Delete(json);
    
    cJSON *resp = cJSON_CreateObject();
    if (!resp) return httpd_resp_send_500(req);
    
    if (strcmp(command, "dns stats") == 0) {
        dns_adblock_stats_t stats;
        dns_adblock_get_stats(&stats);
        char output[512];
        snprintf(output, sizeof(output), "Total Queries: %lu\nBlocked: %lu\nCached: %lu\nRunning: %s",
                 stats.total_queries, stats.blocked_queries, stats.cached_entries,
                 stats.running ? "Yes" : "No");
        cJSON_AddStringToObject(resp, "output", output);
    } else if (strcmp(command, "dns start") == 0) {
        dns_adblock_start();
        cJSON_AddStringToObject(resp, "output", "DNS Ad-blocker started");
    } else if (strcmp(command, "dns stop") == 0) {
        dns_adblock_stop();
        cJSON_AddStringToObject(resp, "output", "DNS Ad-blocker stopped");
    } else if (strcmp(command, "profiles") == 0) {
        profile_info_t profiles[MAX_PROFILES];
        size_t count = 0;
        profile_manager_list_profiles(profiles, MAX_PROFILES, &count);
        char output[512] = {0};
        for (size_t i = 0; i < count; i++) {
            strncat(output, profiles[i].name, sizeof(output) - strlen(output) - 1);
            strncat(output, " ", sizeof(output) - strlen(output) - 1);
        }
        cJSON_AddStringToObject(resp, "output", output);
    } else {
        cJSON_AddStringToObject(resp, "output", "Unknown command. Try: dns stats, dns start, dns stop, profiles");
    }
    
    char *json_str = cJSON_PrintUnformatted(resp);
    cJSON_Delete(resp);
    if (!json_str) return httpd_resp_send_500(req);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, json_str);
    free(json_str);
    return ESP_OK;
}

/* Handler: POST /api/system/shutdown - prepare for external power cutoff */
static esp_err_t shutdown_handler(httpd_req_t *req) {
    bool authorized;
    esp_err_t err = authorize_power_request(req, &authorized);
    if (err != ESP_OK || !authorized) return err;
    httpd_resp_set_type(req, "application/json");
    err = system_control_request_shutdown_preparation();
    if (err != ESP_OK) {
        httpd_resp_set_status(req, "409 Conflict");
        return httpd_resp_sendstr(req, "{\"error\":\"Power operation is busy or OTA is active\"}");
    }
    return httpd_resp_sendstr(req, "{\"preparing_shutdown\":true,\"power_cut_required\":true}");
}

void win11_server_start(void) {
    if (s_server != NULL) {
        ESP_LOGW(TAG, "HTTP server is already running");
        return;
    }
    httpd_config_t config = HTTPD_DEFAULT_CONFIG();
    config.max_uri_handlers = 80;
    config.stack_size = 30720;
    config.task_caps = MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT;
    config.uri_match_fn = httpd_uri_match_wildcard;

    esp_err_t start_err = httpd_start(&s_server, &config);
    if (start_err == ESP_OK) {
        httpd_uri_t account_state_get_uri = {
            .uri = "/api/account/state",
            .method = HTTP_GET,
            .handler = account_state_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &account_state_get_uri)) return;

        httpd_uri_t account_state_save_uri = {
            .uri = "/api/account/state",
            .method = HTTP_POST,
            .handler = account_state_save_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &account_state_save_uri)) return;

        httpd_uri_t stats_uri = {
            .uri = "/api/system/stats",
            .method = HTTP_GET,
            .handler = stats_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &stats_uri)) return;

        httpd_uri_t thermal_stress_uri = {
            .uri = "/api/system/stress",
            .method = HTTP_POST,
            .handler = thermal_stress_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &thermal_stress_uri)) return;

        httpd_uri_t ota_start_uri = {
            .uri = "/api/system/ota",
            .method = HTTP_POST,
            .handler = ota_start_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &ota_start_uri)) return;

        httpd_uri_t ota_status_uri = {
            .uri = "/api/system/ota/status",
            .method = HTTP_GET,
            .handler = ota_status_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &ota_status_uri)) return;

        httpd_uri_t ota_abort_uri = {
            .uri = "/api/system/ota/abort",
            .method = HTTP_POST,
            .handler = ota_abort_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &ota_abort_uri)) return;

        httpd_uri_t ota_upload_uri = {
            .uri = "/api/system/ota/upload",
            .method = HTTP_POST,
            .handler = ota_upload_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &ota_upload_uri)) return;

        httpd_uri_t reboot_uri = {
            .uri = "/api/system/reboot",
            .method = HTTP_POST,
            .handler = reboot_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &reboot_uri)) return;

        httpd_uri_t media_list_uri = {
            .uri = "/api/media/list",
            .method = HTTP_GET,
            .handler = media_list_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &media_list_uri)) return;

        httpd_uri_t media_file_uri = {
            .uri = "/api/media/file",
            .method = HTTP_GET,
            .handler = media_file_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &media_file_uri)) return;

        httpd_uri_t storage_list_uri = {
            .uri = "/api/storage/list",
            .method = HTTP_GET,
            .handler = storage_list_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &storage_list_uri)) return;

        httpd_uri_t storage_read_uri = {
            .uri = "/api/storage/read",
            .method = HTTP_GET,
            .handler = storage_read_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &storage_read_uri)) return;

        httpd_uri_t storage_image_uri = {
            .uri = "/api/storage/image",
            .method = HTTP_GET,
            .handler = storage_image_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &storage_image_uri)) return;

        httpd_uri_t storage_download_uri = {
            .uri = "/api/storage/download",
            .method = HTTP_GET,
            .handler = storage_download_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &storage_download_uri)) return;

        httpd_uri_t storage_action_uri = {
            .uri = "/api/storage/action",
            .method = HTTP_POST,
            .handler = storage_mutation_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &storage_action_uri)) return;

        httpd_uri_t storage_upload_uri = {
            .uri = "/api/storage/upload",
            .method = HTTP_POST,
            .handler = storage_upload_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &storage_upload_uri)) return;

        httpd_uri_t gpio_list_uri = {
            .uri = "/api/hardware/gpios",
            .method = HTTP_GET,
            .handler = hardware_gpio_list_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &gpio_list_uri)) return;

        httpd_uri_t gpio_set_uri = {
            .uri = "/api/hardware/gpios",
            .method = HTTP_POST,
            .handler = hardware_gpio_set_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &gpio_set_uri)) return;

        httpd_uri_t uac_uri = {
            .uri = "/api/auth/verify_uac",
            .method = HTTP_POST,
            .handler = uac_verify_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &uac_uri)) return;

        httpd_uri_t platform_resources_uri = {
            .uri     = "/api/platform/resources",
            .method  = HTTP_GET,
            .handler = platform_resources_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &platform_resources_uri)) return;

        httpd_uri_t dns_stats_uri = {
            .uri = "/api/dns/stats",
            .method = HTTP_GET,
            .handler = dns_stats_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_stats_uri)) return;

        httpd_uri_t dns_config_uri = {
            .uri = "/api/dns/config",
            .method = HTTP_POST,
            .handler = dns_config_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_config_uri)) return;

        httpd_uri_t dns_domain_uri = {
            .uri = "/api/dns/domains",
            .method = HTTP_POST,
            .handler = dns_domain_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_domain_uri)) return;

        httpd_uri_t dns_domains_get_uri = {
            .uri = "/api/dns/domains",
            .method = HTTP_GET,
            .handler = dns_domains_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_domains_get_uri)) return;

        httpd_uri_t dns_log_get_uri = {
            .uri = "/api/dns/log",
            .method = HTTP_GET,
            .handler = dns_log_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_log_get_uri)) return;

        httpd_uri_t dns_analytics_get_uri = {
            .uri = "/api/dns/analytics",
            .method = HTTP_GET,
            .handler = dns_analytics_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_analytics_get_uri)) return;

        httpd_uri_t dns_adlists_get_uri = {
            .uri = "/api/dns/adlists",
            .method = HTTP_GET,
            .handler = dns_adlists_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_adlists_get_uri)) return;

        httpd_uri_t dns_adlists_post_uri = {
            .uri = "/api/dns/adlists",
            .method = HTTP_POST,
            .handler = dns_adlists_post_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_adlists_post_uri)) return;

        httpd_uri_t dns_adlists_update_uri = {
            .uri = "/api/dns/adlists/update",
            .method = HTTP_POST,
            .handler = dns_adlists_update_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &dns_adlists_update_uri)) return;

        httpd_uri_t profile_create_uri = {
            .uri = "/api/profiles/create",
            .method = HTTP_POST,
            .handler = profile_create_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profile_create_uri)) return;

        httpd_uri_t profiles_list_uri = {
            .uri = "/api/profiles/list",
            .method = HTTP_GET,
            .handler = profiles_list_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profiles_list_uri)) return;

        httpd_uri_t profiles_switch_uri = {
            .uri = "/api/profiles/switch",
            .method = HTTP_POST,
            .handler = profiles_switch_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profiles_switch_uri)) return;

        httpd_uri_t profiles_current_uri = {
            .uri = "/api/profiles/current",
            .method = HTTP_GET,
            .handler = profiles_current_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profiles_current_uri)) return;

        httpd_uri_t profile_settings_get_uri = {
            .uri = "/api/profiles/current/settings",
            .method = HTTP_GET,
            .handler = profile_settings_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profile_settings_get_uri)) return;

        httpd_uri_t profile_settings_save_uri = {
            .uri = "/api/profiles/current/settings",
            .method = HTTP_POST,
            .handler = profile_settings_save_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profile_settings_save_uri)) return;

        httpd_uri_t wallpaper_get_uri = {
            .uri = "/api/profiles/current/wallpaper",
            .method = HTTP_GET,
            .handler = wallpaper_get_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &wallpaper_get_uri)) return;

        httpd_uri_t wallpaper_upload_uri = {
            .uri = "/api/profiles/current/wallpaper",
            .method = HTTP_POST,
            .handler = wallpaper_upload_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &wallpaper_upload_uri)) return;

        httpd_uri_t profile_isolation_uri = {
            .uri = "/api/profiles/current/isolation",
            .method = HTTP_POST,
            .handler = profile_isolation_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &profile_isolation_uri)) return;

        httpd_uri_t auth_current_user_uri = {
            .uri = "/api/auth/current-user",
            .method = HTTP_GET,
            .handler = auth_current_user_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &auth_current_user_uri)) return;

        httpd_uri_t auth_password_uri = {
            .uri = "/api/auth/password",
            .method = HTTP_POST,
            .handler = auth_password_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &auth_password_uri)) return;

        httpd_uri_t terminal_exec_uri = {
            .uri = "/api/terminal/exec",
            .method = HTTP_POST,
            .handler = terminal_exec_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &terminal_exec_uri)) return;

        httpd_uri_t shutdown_uri = {
            .uri = "/api/system/shutdown",
            .method = HTTP_POST,
            .handler = shutdown_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &shutdown_uri)) return;

        httpd_uri_t index_uri = {
            .uri = "/",
            .method = HTTP_GET,
            .handler = web_file_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &index_uri)) return;

        httpd_uri_t web_files_uri = {
            .uri = "/*",
            .method = HTTP_GET,
            .handler = web_file_handler,
            .user_ctx = NULL
        };
        if (!register_uri_handler(s_server, &web_files_uri)) return;

        ESP_LOGI(TAG, "Web API, DNS ad-blocker, profiles, logs, terminal, abstracted USB browser, media streaming, GPIO outputs and web files registered on port 80");
    } else {
        s_server = NULL;
        ESP_LOGE(TAG, "Failed to start HTTP server: %s (0x%x)",
                 esp_err_to_name(start_err), (unsigned int)start_err);
    }
}

bool win11_server_is_running(void) {
    return s_server != NULL;
}

esp_err_t win11_server_stop(void) {
    if (s_server == NULL) return ESP_OK;
    esp_err_t err = httpd_stop(s_server);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to stop HTTP server for power operation: %s", esp_err_to_name(err));
        return err;
    }
    s_server = NULL;
    return ESP_OK;
}
