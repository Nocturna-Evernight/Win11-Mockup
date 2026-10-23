/*
 * ESP32-S3 N16R8 Windows 11 WebOS Firmware
 * Target: ESP32-S3-WROOM-1-N16R8 (16MB Flash, 8MB Octal PSRAM)
 * Framework: ESP-IDF v5.1+
 * Features:
 *   - Native USB-OTG MSC Host for 32GB Flash Drive
 *   - Octal 8MB PSRAM dynamic allocator
 *   - HTTP Web Server hosting Win11 Web Desktop
 *   - UAC & User Profile Management with SHA-256
 */

#include <stdio.h>
#include <inttypes.h>
#include <string.h>
#include "esp_system.h"
#include "esp_log.h"
#include "esp_pm.h"
#include "esp_heap_caps.h"
#include "esp_psram.h"
#include "nvs_flash.h"
#include "esp_wifi.h"
#include "esp_event.h"
#include "esp_netif.h"
#include "esp_sntp.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/event_groups.h"

#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "win11_server.h"
#include "auth_uac.h"
#include "thermal_monitor.h"
#include "ota_manager.h"
#include "system_control.h"
#include "app_platform.h"
#include "dns_adblock.h"
#include "profile_manager.h"
#include "status_indicator.h"

static const char *TAG = "WIN11_MAIN";


/* Home Wi-Fi Network Credentials (Can also be read from /usb/system/wifi_config.json) */
#define HOME_WIFI_SSID    "[SSID]"
#define HOME_WIFI_PASS    "[PASSWORD]"
#define HOME_WIFI_STATIC_IP "192.168.1.20"
#define HOME_WIFI_GATEWAY   "192.168.1.1"
#define HOME_WIFI_NETMASK   "255.255.255.0"
  
static esp_netif_t *s_sta_netif = NULL;
static EventGroupHandle_t s_wifi_event_group;
static uint8_t s_wifi_retry_count;
static bool s_sntp_started;

#define WIFI_RECONNECT_BIT BIT0
#define WIFI_RETRY_RESET_BIT BIT1
#define WIFI_MAX_RETRY_DELAY_SECONDS 30
#define AUTH_RELOAD_TASK_STACK_SIZE 16384
static void log_startup_resources(const char *stage) {
    ESP_LOGI(TAG, "Startup stage: %s; internal heap free=%zu, largest=%zu, minimum=%zu, PSRAM free=%zu",
             stage,
             heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

static void wifi_reconnect_task(void *arg) {
    for (;;) {
        EventBits_t events = xEventGroupWaitBits(
            s_wifi_event_group,
            WIFI_RECONNECT_BIT | WIFI_RETRY_RESET_BIT,
            pdTRUE,
            pdFALSE,
            portMAX_DELAY);

        if ((events & WIFI_RETRY_RESET_BIT) != 0) {
            s_wifi_retry_count = 0;
        }

        if ((events & WIFI_RECONNECT_BIT) == 0) {
            continue;
        }

        uint32_t delay_seconds = 1U << s_wifi_retry_count;
        if (delay_seconds > WIFI_MAX_RETRY_DELAY_SECONDS) {
            delay_seconds = WIFI_MAX_RETRY_DELAY_SECONDS;
        }
        if (s_wifi_retry_count < 5) {
            s_wifi_retry_count++;
        }

        ESP_LOGI(TAG, "Retrying Home Wi-Fi connection in %" PRIu32 " seconds.", delay_seconds);
        vTaskDelay(pdMS_TO_TICKS(delay_seconds * 1000));

        esp_err_t err = esp_wifi_connect();
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Wi-Fi reconnect request failed: %s", esp_err_to_name(err));
            xEventGroupSetBits(s_wifi_event_group, WIFI_RECONNECT_BIT);
        }
    }
}

/* Wi-Fi & IP Event Handler */
static void wifi_event_handler(void *arg, esp_event_base_t event_base, int32_t event_id, void *event_data) {
    ESP_LOGI(TAG, "System event: %s id=%" PRId32, event_base, event_id);
    if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_START) {
        ESP_LOGI(TAG, "Connecting to Home Wi-Fi: %s...", HOME_WIFI_SSID);
        esp_wifi_connect();
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_DISCONNECTED) {
        wifi_event_sta_disconnected_t *event = (wifi_event_sta_disconnected_t *)event_data;
        ESP_LOGW(TAG, "Home Wi-Fi disconnected (reason %d).", event->reason);
        xEventGroupSetBits(s_wifi_event_group, WIFI_RECONNECT_BIT);
    } else if (event_base == WIFI_EVENT && event_id == WIFI_EVENT_STA_CONNECTED) {
        ESP_LOGI(TAG, "Associated with Home Wi-Fi; waiting for an IP address.");
    } else if (event_base == IP_EVENT && event_id == IP_EVENT_STA_GOT_IP) {
        ip_event_got_ip_t *event = (ip_event_got_ip_t *)event_data;
        xEventGroupSetBits(s_wifi_event_group, WIFI_RETRY_RESET_BIT);
        ESP_LOGI(TAG, "==========================================================");
        ESP_LOGI(TAG, "CONNECTED TO HOME WI-FI! Assigned Local IP: " IPSTR, IP2STR(&event->ip_info.ip));
        ESP_LOGI(TAG, "Access Windows 11 WebOS on any device at: http://" IPSTR, IP2STR(&event->ip_info.ip));
        ESP_LOGI(TAG, "==========================================================");

        if (!s_sntp_started) {
            esp_sntp_setoperatingmode(SNTP_OPMODE_POLL);
            esp_sntp_setservername(0, "pool.ntp.org");
            esp_sntp_init();
            s_sntp_started = true;
        }

    }
}

/* Initialize Wi-Fi Station Only (No SoftAP) */
static void wifi_init_sta_only(void) {
    ESP_ERROR_CHECK(esp_netif_init());
    ESP_ERROR_CHECK(esp_event_loop_create_default());

    s_wifi_event_group = xEventGroupCreate();
    ESP_ERROR_CHECK(s_wifi_event_group != NULL ? ESP_OK : ESP_ERR_NO_MEM);
    BaseType_t task_created = xTaskCreate(wifi_reconnect_task, "wifi_reconnect", 3072, NULL, 4, NULL);
    ESP_ERROR_CHECK(task_created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);

    s_sta_netif = esp_netif_create_default_wifi_sta();

    ESP_ERROR_CHECK(esp_netif_dhcpc_stop(s_sta_netif));
    esp_netif_ip_info_t sta_ip_info = {0};
    ESP_ERROR_CHECK(esp_netif_str_to_ip4(HOME_WIFI_STATIC_IP, &sta_ip_info.ip));
    ESP_ERROR_CHECK(esp_netif_str_to_ip4(HOME_WIFI_GATEWAY, &sta_ip_info.gw));
    ESP_ERROR_CHECK(esp_netif_str_to_ip4(HOME_WIFI_NETMASK, &sta_ip_info.netmask));
    ESP_ERROR_CHECK(esp_netif_set_ip_info(s_sta_netif, &sta_ip_info));

    esp_netif_dns_info_t sta_dns_info = {0};
    sta_dns_info.ip.type = ESP_IPADDR_TYPE_V4;
    ESP_ERROR_CHECK(esp_netif_str_to_ip4(HOME_WIFI_GATEWAY, &sta_dns_info.ip.u_addr.ip4));
    ESP_ERROR_CHECK(esp_netif_set_dns_info(s_sta_netif, ESP_NETIF_DNS_MAIN, &sta_dns_info));
    esp_err_t fallback_dns_err = dns_adblock_set_fallback_dns(HOME_WIFI_GATEWAY);
    if (fallback_dns_err != ESP_OK) {
        ESP_LOGW(TAG, "Unable to configure router DNS fallback: %s", esp_err_to_name(fallback_dns_err));
    }

    wifi_init_config_t cfg = WIFI_INIT_CONFIG_DEFAULT();
    ESP_ERROR_CHECK(esp_wifi_init(&cfg));

    ESP_ERROR_CHECK(esp_event_handler_instance_register(WIFI_EVENT, ESP_EVENT_ANY_ID, &wifi_event_handler, NULL, NULL));
    ESP_ERROR_CHECK(esp_event_handler_instance_register(IP_EVENT, IP_EVENT_STA_GOT_IP, &wifi_event_handler, NULL, NULL));

    wifi_config_t sta_config = {
        .sta = {
            .ssid = HOME_WIFI_SSID,
            .password = HOME_WIFI_PASS,
            .threshold.authmode = WIFI_AUTH_WPA2_PSK,
        },
    };

    ESP_ERROR_CHECK(esp_wifi_set_mode(WIFI_MODE_STA));
    ESP_ERROR_CHECK(esp_wifi_set_config(WIFI_IF_STA, &sta_config));
    ESP_ERROR_CHECK(esp_wifi_start());
    // Disable WiFi power save to avoid PM/coex timer crashes
    ESP_ERROR_CHECK(esp_wifi_set_ps(WIFI_PS_NONE));

    ESP_LOGI(TAG, "Wi-Fi Station Mode Initialized: Home Station '%s'", HOME_WIFI_SSID);
}

/* Validate 8MB Octal PSRAM on ESP32-S3 N16R8 */
static void validate_octal_psram(void) {
    size_t psram_size = esp_psram_get_size();
    size_t free_psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t free_internal = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);

    ESP_LOGI(TAG, "==================================================");
    ESP_LOGI(TAG, "  ESP32-S3 N16R8 Windows 11 Host Initializing   ");
    ESP_LOGI(TAG, "==================================================");
    ESP_LOGI(TAG, "Detected PSRAM total: %zu MB (%zu bytes)", psram_size / (1024 * 1024), psram_size);
    ESP_LOGI(TAG, "Available 8MB Octal PSRAM: %zu KB free", free_psram / 1024);
    ESP_LOGI(TAG, "Internal SRAM: %zu KB free", free_internal / 1024);

    if (psram_size < 8 * 1024 * 1024) {
        ESP_LOGW(TAG, "WARNING: Detected PSRAM is under 8MB! Ensure CONFIG_SPIRAM_MODE_OCT=y in sdkconfig");
    } else {
        ESP_LOGI(TAG, "Octal 8MB PSRAM initialized and validated successfully.");
    }
}

static void auth_storage_reload_task(void *arg) {
    (void)arg;
    ESP_LOGI(TAG, "Loading persistent DNS settings from internal LittleFS");
    esp_err_t dns_config_err = dns_adblock_load_config_from_usb();
    if (dns_config_err == ESP_ERR_NOT_FOUND && usb_host_msc_is_mounted()) {
        dns_config_err = dns_adblock_save_config_to_usb();
    } else if (dns_config_err != ESP_OK && dns_config_err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "LittleFS DNS configuration could not be loaded: %s",
                 esp_err_to_name(dns_config_err));
    }
    esp_err_t dns_rules_err = dns_adblock_load_rules_from_usb();
    if (dns_rules_err == ESP_ERR_NOT_FOUND && usb_host_msc_is_mounted()) {
        dns_rules_err = dns_adblock_save_rules_to_usb();
    } else if (dns_rules_err != ESP_OK && dns_rules_err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "LittleFS DNS rules could not be loaded: %s",
                 esp_err_to_name(dns_rules_err));
    }
    esp_err_t dns_lists_err = dns_adblock_load_blocklists_from_usb();
    if (dns_lists_err != ESP_OK && dns_lists_err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "LittleFS DNS blocklists could not be loaded: %s",
                 esp_err_to_name(dns_lists_err));
    }
    esp_err_t dns_start_err = dns_adblock_start();
    if (dns_start_err != ESP_OK) {
        ESP_LOGE(TAG, "DNS resolver failed to start: %s", esp_err_to_name(dns_start_err));
    }

    ESP_LOGI(TAG, "Startup stage: waiting for USB storage before reloading account database");
    unsigned wait_intervals = 0;
    while (!usb_host_msc_is_ready()) {
        vTaskDelay(pdMS_TO_TICKS(500));
        if (++wait_intervals == 20) {
            ESP_LOGI(TAG, "Still waiting for USB storage; account reload remains pending");
            wait_intervals = 0;
        }
    }
    ESP_LOGI(TAG, "Startup stage: USB is mounted; loading persistent accounts");
    esp_err_t profile_err = profile_manager_init();
    if (profile_err != ESP_OK) {
        ESP_LOGW(TAG, "USB profile storage initialization failed: %s", esp_err_to_name(profile_err));
    }
    log_startup_resources("before account reload");
    auth_uac_init("/usb/system/users.db");
    UBaseType_t stack_high_water_mark = uxTaskGetStackHighWaterMark(NULL);
    ESP_LOGI(TAG, "Startup stage: account reload finished; auth task stack high-water mark=%u bytes",
             (unsigned)stack_high_water_mark);
    log_startup_resources("after account reload");
    vTaskDeleteWithCaps(NULL);
}

void app_main(void) {
    const esp_pm_config_t pm_config = {
        .max_freq_mhz = 240,
        .min_freq_mhz = 80,
        .light_sleep_enable = false,
    };
    ESP_ERROR_CHECK(esp_pm_configure(&pm_config));
    ESP_LOGI(TAG, "CPU frequency scaling enabled: 80-240 MHz");
    if (status_indicator_init() == ESP_OK) {
        status_indicator_set_rgb(0, 0, 96);
    }

    ESP_LOGI(TAG, "Startup stage 1/8: initializing OTA manager");
    esp_err_t ota_err = ota_manager_init();
    if (ota_err != ESP_OK) {
        ESP_LOGW(TAG, "OTA manager init warning: %s (OTA updates may be unavailable)", esp_err_to_name(ota_err));
    }

    ESP_LOGI(TAG, "Startup stage 1b/8: initializing app platform watchdog");
    esp_err_t platform_err = app_platform_init();
    if (platform_err != ESP_OK) {
        ESP_LOGW(TAG, "App platform watchdog init warning: %s", esp_err_to_name(platform_err));
    }

    ESP_LOGI(TAG, "Startup stage 2/8: initializing thermal monitoring");
    esp_err_t thermal_err = thermal_monitor_init();
    if (thermal_err != ESP_OK) {
        ESP_LOGE(TAG, "Temperature telemetry is unavailable: %s", esp_err_to_name(thermal_err));
    }
    
    ESP_LOGI(TAG, "Startup stage 2b/8: initializing profile manager");
    profile_manager_init();
    
    ESP_LOGI(TAG, "Startup stage 2c/8: initializing DNS ad-blocker");
    dns_adblock_init();

    ESP_LOGI(TAG, "Startup stage 3/8: initializing NVS");
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        ESP_ERROR_CHECK(nvs_flash_erase());
        ret = nvs_flash_init();
    }
    ESP_ERROR_CHECK(ret);

    /* 1. Verify 8MB Octal PSRAM */
    ESP_LOGI(TAG, "Startup stage 4/8: checking memory");
    validate_octal_psram();

    /* 2. Prepare internal-flash storage for the USB filename map */
    ESP_LOGI(TAG, "Startup stage 5/8: preparing persistent USB filename map");
    ret = usb_storage_map_init();
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "USB filename map is unavailable: %s; continuing in degraded storage mode",
                 esp_err_to_name(ret));
    }

    /* 3. Initialize default accounts; reload persistent accounts after USB mapping is ready */
    ESP_LOGI(TAG, "Startup stage 6/8: initializing fallback accounts");
    auth_uac_init("/usb/system/users.db");

    /* 4. Initialize Native USB-OTG Host MSC (Mount USB drive to /usb) */
    ESP_LOGI(TAG, "Startup stage 7/8: starting USB host and waiting for storage");
    log_startup_resources("before USB host initialization");
    ESP_LOGI(TAG, "Initializing USB-OTG Host for 32GB Flash Drive (GPIO 19 D-, GPIO 20 D+)...");
    ret = usb_host_msc_init("/usb");
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "USB MSC Host init failed or drive not inserted. Will retry in background task.");
    }

    /* 5. Start Wi-Fi Station (Home Network) */
    ESP_LOGI(TAG, "Startup stage 8/8: starting network services");
    wifi_init_sta_only();

    /* 6. Start Web Server with Win11 WebOS and REST/FS APIs */
    esp_err_t power_control_err = system_control_init();
    if (power_control_err != ESP_OK) {
        ESP_LOGE(TAG, "Power-control initialization failed: %s", esp_err_to_name(power_control_err));
    }
    ESP_LOGI(TAG, "Starting Windows 11 Web Server daemon...");
    win11_server_start();
    log_startup_resources("after web server start attempt");
    if (win11_server_is_running()) {
        ESP_LOGI(TAG, "Windows 11 WebOS active at http://192.168.1.20");
        esp_err_t ota_confirm_err = ota_manager_confirm_boot();
        if (ota_confirm_err != ESP_OK) {
            ESP_LOGE(TAG, "Pending OTA validation could not start: %s", esp_err_to_name(ota_confirm_err));
        }
    } else {
        ESP_LOGE(TAG, "Windows 11 WebOS is unavailable because the HTTP server did not start");
        esp_err_t reject_err = ota_manager_reject_boot();
        if (reject_err != ESP_OK && reject_err != ESP_ERR_INVALID_STATE) {
            ESP_LOGE(TAG, "Failed to reject unhealthy OTA image: %s", esp_err_to_name(reject_err));
        }
    }

    ESP_LOGI(TAG, "Startup complete; scheduling persistent account reload after core services");
    BaseType_t auth_task_created = xTaskCreateWithCaps(auth_storage_reload_task,
                                                        "auth_storage_reload",
                                                        AUTH_RELOAD_TASK_STACK_SIZE, NULL, 3, NULL,
                                                        MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT);
    ESP_ERROR_CHECK(auth_task_created == pdPASS ? ESP_OK : ESP_ERR_NO_MEM);
    

}
