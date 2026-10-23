/*
 * Native USB Host MSC Driver for ESP32-S3
 * Mounts 32GB USB Flash Drive to /usb via FATFS
 */

#include "usb_host_msc.h"
#include <stdio.h>
#include <string.h>
#include <sys/stat.h>
#include "esp_log.h"
#include "esp_err.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "usb/usb_host.h"
#include "usb/msc_host.h"
#include "usb/msc_host_vfs.h"
#include "esp_vfs_fat.h"
#include "usb_storage_map.h"
#include "usb_setup.h"
#include "status_indicator.h"

static const char *TAG = "USB_MSC_HOST";

#define USB_MSC_MONITOR_TASK_STACK_SIZE 16384
#define USB_HOST_DEVICE_SCAN_LIMIT 8
#define USB_EMPTY_SCAN_LOG_INTERVAL 10

static msc_host_device_handle_t s_msc_device = NULL;
static msc_host_vfs_handle_t s_vfs_handle = NULL;
static char s_mount_base[32] = "/usb";
static bool s_is_mounted = false;
static bool s_setup_complete = false;
static uint8_t s_device_address = 0;
static bool s_disconnect_pending;
static SemaphoreHandle_t s_msc_mutex = NULL;
static portMUX_TYPE s_info_mux = portMUX_INITIALIZER_UNLOCKED;
static usb_host_msc_info_t s_device_info;
static bool s_host_initialized;
static volatile bool s_shutdown_prepared;
static uint8_t s_empty_device_scan_count;

static void log_memory_snapshot(const char *stage) {
    ESP_LOGI(TAG, "%s: internal free=%zu largest=%zu minimum=%zu, PSRAM free=%zu",
             stage,
             heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL),
             heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL),
             heap_caps_get_free_size(MALLOC_CAP_SPIRAM));
}

static void copy_usb_string(char *dest, size_t dest_size, const wchar_t *src) {
    size_t out = 0;
    if (dest_size == 0) {
        return;
    }
    if (src == NULL) {
        dest[0] = '\0';
        return;
    }

    while (*src && out + 1 < dest_size) {
        uint32_t codepoint = (uint32_t)*src++;
        if (codepoint <= 0x7f) {
            dest[out++] = (char)codepoint;
        } else if (codepoint <= 0x7ff && out + 2 < dest_size) {
            dest[out++] = (char)(0xc0 | (codepoint >> 6));
            dest[out++] = (char)(0x80 | (codepoint & 0x3f));
        } else if (codepoint <= 0xffff && out + 3 < dest_size) {
            dest[out++] = (char)(0xe0 | (codepoint >> 12));
            dest[out++] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
            dest[out++] = (char)(0x80 | (codepoint & 0x3f));
        } else if (codepoint <= 0x10ffff && out + 4 < dest_size) {
            dest[out++] = (char)(0xf0 | (codepoint >> 18));
            dest[out++] = (char)(0x80 | ((codepoint >> 12) & 0x3f));
            dest[out++] = (char)(0x80 | ((codepoint >> 6) & 0x3f));
            dest[out++] = (char)(0x80 | (codepoint & 0x3f));
        } else {
            break;
        }
    }
    dest[out] = '\0';
}

/* Background task to handle USB Host Library events */
static void usb_host_lib_task(void *pvParameters) {
    while (1) {
        uint32_t event_flags;
        esp_err_t err = usb_host_lib_handle_events(portMAX_DELAY, &event_flags);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "USB host event wait failed: %s", esp_err_to_name(err));
            vTaskDelay(pdMS_TO_TICKS(100));
            continue;
        }
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_NO_CLIENTS) {
            ESP_LOGW(TAG, "No USB host clients registered");
        }
        if (event_flags & USB_HOST_LIB_EVENT_FLAGS_ALL_FREE) {
            ESP_LOGI(TAG, "USB host devices freed");
        }
    }
}

/* MSC event callback */
static void msc_event_cb(const msc_host_event_t *event, void *arg) {
    if (event->event == MSC_DEVICE_CONNECTED) {
        ESP_LOGI(TAG, "[Event ID: 1000] USB Mass Storage device connected at address %d",
                 event->device.address);
        portENTER_CRITICAL(&s_info_mux);
        s_device_address = event->device.address;
        portEXIT_CRITICAL(&s_info_mux);
        if (s_msc_mutex == NULL || xSemaphoreGive(s_msc_mutex) != pdTRUE) {
            ESP_LOGW(TAG, "USB insertion notification could not be queued");
        }
    } else if (event->event == MSC_DEVICE_DISCONNECTED) {
        portENTER_CRITICAL(&s_info_mux);
        uint8_t disconnected_address = s_device_address;
        s_device_address = 0;
        s_disconnect_pending = true;
        s_is_mounted = false;
        s_setup_complete = false;
        memset(&s_device_info, 0, sizeof(s_device_info));
        portEXIT_CRITICAL(&s_info_mux);
        ESP_LOGW(TAG, "[Event ID: 1002] USB Mass Storage device removed (address %u)",
                 (unsigned)disconnected_address);
        if (s_msc_mutex == NULL || xSemaphoreGive(s_msc_mutex) != pdTRUE) {
            ESP_LOGW(TAG, "USB removal cleanup notification could not be queued");
        }
    }
}

static void reconcile_usb_device_state(void) {
    portENTER_CRITICAL(&s_info_mux);
    uint8_t device_address = s_device_address;
    bool disconnect_pending = s_disconnect_pending;
    portEXIT_CRITICAL(&s_info_mux);
    if (disconnect_pending) {
        return;
    }

    if (device_address == 0) {
        uint8_t device_addresses[USB_HOST_DEVICE_SCAN_LIMIT] = {0};
        int device_count = 0;
        esp_err_t err = usb_host_device_addr_list_fill(
            USB_HOST_DEVICE_SCAN_LIMIT, device_addresses, &device_count);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "USB device-list scan failed: %s", esp_err_to_name(err));
            return;
        }

        if (device_count == 0) {
            s_empty_device_scan_count++;
            if (s_empty_device_scan_count == 1 ||
                s_empty_device_scan_count % USB_EMPTY_SCAN_LOG_INTERVAL == 0) {
                ESP_LOGW(TAG, "USB host sees no enumerated devices; internal heap free=%zu, largest=%zu",
                         heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                         heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
            }
            return;
        }

        s_empty_device_scan_count = 0;
        device_address = device_addresses[0];
        portENTER_CRITICAL(&s_info_mux);
        if (s_device_address == 0 && !s_disconnect_pending) {
            s_device_address = device_address;
        }
        device_address = s_device_address;
        disconnect_pending = s_disconnect_pending;
        portEXIT_CRITICAL(&s_info_mux);
        if (disconnect_pending || device_address == 0) {
            return;
        }
        ESP_LOGW(TAG, "USB host found already-enumerated device at address %u; recovering missed connect event",
                 (unsigned)device_address);
    }

    if (xSemaphoreGive(s_msc_mutex) != pdTRUE) {
        ESP_LOGD(TAG, "USB device notification is already pending");
    }
}

/* Background monitor and automount task */
static void usb_msc_monitor_task(void *pvParameters) {
    TickType_t last_wait_log_tick = 0;
    bool wait_log_emitted = false;
    while (1) {
        if (s_shutdown_prepared) {
            vTaskDelay(pdMS_TO_TICKS(1000));
            continue;
        }
        if (!usb_host_msc_is_mounted()) {
            TickType_t now = xTaskGetTickCount();
            if (!wait_log_emitted ||
                (TickType_t)(now - last_wait_log_tick) >= pdMS_TO_TICKS(60000)) {
                ESP_LOGI(TAG, "[Event ID: 1001] USB Mass Storage is not mounted; monitoring for insertion");
                last_wait_log_tick = now;
                wait_log_emitted = true;
            }
            if (xSemaphoreTake(s_msc_mutex, pdMS_TO_TICKS(3000)) == pdTRUE) {
                portENTER_CRITICAL(&s_info_mux);
                bool disconnect_pending = s_disconnect_pending;
                uint8_t device_address = s_device_address;
                s_disconnect_pending = false;
                portEXIT_CRITICAL(&s_info_mux);

                if (disconnect_pending) {
                    status_indicator_set_rgb(0, 0, 96);
                    if (s_vfs_handle != NULL) {
                        esp_err_t unregister_err = msc_host_vfs_unregister(s_vfs_handle);
                        if (unregister_err != ESP_OK) {
                            ESP_LOGE(TAG, "Failed to unregister USB filesystem after removal: %s",
                                     esp_err_to_name(unregister_err));
                        }
                        s_vfs_handle = NULL;
                    }
                    if (s_msc_device != NULL) {
                        esp_err_t uninstall_err = msc_host_uninstall_device(s_msc_device);
                        if (uninstall_err != ESP_OK) {
                            ESP_LOGE(TAG, "Failed to release disconnected USB device: %s",
                                     esp_err_to_name(uninstall_err));
                        }
                        s_msc_device = NULL;
                    }
                    portENTER_CRITICAL(&s_info_mux);
                    device_address = s_device_address;
                    portEXIT_CRITICAL(&s_info_mux);
                    if (device_address != 0 && xSemaphoreGive(s_msc_mutex) != pdTRUE) {
                        ESP_LOGW(TAG, "USB reconnection notification could not be re-queued");
                    }
                    continue;
                }
                if (device_address == 0) {
                    continue;
                }

                ESP_LOGI(TAG, "Installing USB Mass Storage device driver...");
                esp_err_t err = msc_host_install_device(device_address, &s_msc_device);
                if (err == ESP_OK) {
                    usb_host_msc_info_t detected_info = {0};
                    msc_host_device_info_t msc_info = {0};
                    err = msc_host_get_device_info(s_msc_device, &msc_info);
                    if (err == ESP_OK) {
                        if (msc_info.sector_size == 0 || msc_info.sector_count == 0 ||
                            msc_info.sector_count > UINT64_MAX / msc_info.sector_size) {
                            ESP_LOGE(TAG, "USB drive reported invalid capacity geometry");
                            msc_host_uninstall_device(s_msc_device);
                            s_msc_device = NULL;
                            vTaskDelay(pdMS_TO_TICKS(1500));
                            continue;
                        }
                        detected_info = (usb_host_msc_info_t) {
                            .vendor_id = msc_info.idVendor,
                            .product_id = msc_info.idProduct,
                            .sector_size = msc_info.sector_size,
                            .sector_count = msc_info.sector_count,
                            .capacity_bytes = (uint64_t)msc_info.sector_size * msc_info.sector_count,
                        };
                        copy_usb_string(detected_info.manufacturer, sizeof(detected_info.manufacturer), msc_info.iManufacturer);
                        copy_usb_string(detected_info.product, sizeof(detected_info.product), msc_info.iProduct);
                        copy_usb_string(detected_info.serial_number, sizeof(detected_info.serial_number), msc_info.iSerialNumber);

                        portENTER_CRITICAL(&s_info_mux);
                        s_device_info = detected_info;
                        portEXIT_CRITICAL(&s_info_mux);

                        ESP_LOGI(TAG, "USB device VID:PID=%04X:%04X, %s %s, capacity=%llu bytes",
                                 detected_info.vendor_id, detected_info.product_id,
                                 detected_info.manufacturer[0] ? detected_info.manufacturer : "Unknown manufacturer",
                                 detected_info.product[0] ? detected_info.product : "Unknown product",
                                 (unsigned long long)detected_info.capacity_bytes);
                    } else {
                        ESP_LOGE(TAG, "Failed to read USB device identity and capacity: %s", esp_err_to_name(err));
                        msc_host_uninstall_device(s_msc_device);
                        s_msc_device = NULL;
                        vTaskDelay(pdMS_TO_TICKS(1500));
                        continue;
                    }

                    const esp_vfs_fat_mount_config_t mount_config = {
                        .format_if_mount_failed = false,
                        .max_files = 16,
                        .allocation_unit_size = 32 * 1024
                    };

                    log_memory_snapshot("Before USB filesystem mount");
                    err = msc_host_vfs_register(s_msc_device, s_mount_base, &mount_config, &s_vfs_handle);
                    if (err == ESP_OK) {
                        log_memory_snapshot("After USB filesystem mount");
                        char device_id[128];
                        int id_length = detected_info.serial_number[0] != '\0'
                            ? snprintf(device_id, sizeof(device_id), "%04X:%04X:%s",
                                       detected_info.vendor_id, detected_info.product_id,
                                       detected_info.serial_number)
                            : snprintf(device_id, sizeof(device_id), "%04X:%04X:%llu",
                                       detected_info.vendor_id, detected_info.product_id,
                                       (unsigned long long)detected_info.capacity_bytes);
                        err = id_length > 0 && (size_t)id_length < sizeof(device_id)
                            ? usb_storage_map_migrate(device_id) : ESP_ERR_INVALID_SIZE;
                        if (err != ESP_OK) {
                            if (s_vfs_handle != NULL) {
                                esp_err_t unregister_err = msc_host_vfs_unregister(s_vfs_handle);
                                if (unregister_err != ESP_OK) {
                                    ESP_LOGE(TAG, "Failed to unregister USB filesystem after map failure: %s",
                                             esp_err_to_name(unregister_err));
                                }
                                s_vfs_handle = NULL;
                            }
                            if (s_msc_device != NULL) {
                                esp_err_t uninstall_err = msc_host_uninstall_device(s_msc_device);
                                if (uninstall_err != ESP_OK) {
                                    ESP_LOGE(TAG, "Failed to release USB device after map failure: %s",
                                             esp_err_to_name(uninstall_err));
                                }
                                s_msc_device = NULL;
                            }
                            portENTER_CRITICAL(&s_info_mux);
                            memset(&s_device_info, 0, sizeof(s_device_info));
                            portEXIT_CRITICAL(&s_info_mux);
                            continue;
                        }
                        portENTER_CRITICAL(&s_info_mux);
                        bool device_removed = s_disconnect_pending || s_device_address != device_address;
                        s_is_mounted = !device_removed;
                        s_setup_complete = false;
                        portEXIT_CRITICAL(&s_info_mux);
                        if (device_removed) {
                            continue;
                        }

                        usb_host_msc_create_default_win11_dirs();
                        esp_err_t setup_err = usb_setup_init_all();
                        UBaseType_t stack_remaining = uxTaskGetStackHighWaterMark(NULL);
                        ESP_LOGI(TAG, "USB MSC monitor task stack high-water mark=%u bytes",
                                 (unsigned)stack_remaining);
                        log_memory_snapshot("After USB filesystem setup");
                        if (setup_err != ESP_OK) {
                            ESP_LOGW(TAG, "USB first-time setup reported: %s", esp_err_to_name(setup_err));
                        }
                        portENTER_CRITICAL(&s_info_mux);
                        device_removed = s_disconnect_pending || s_device_address != device_address;
                        s_is_mounted = !device_removed;
                        s_setup_complete = !device_removed;
                        portEXIT_CRITICAL(&s_info_mux);
                        if (device_removed) {
                            continue;
                        }
                        status_indicator_set_rgb(0, 64, 0);
                        ESP_LOGI(TAG, "[Event ID: 1004] USB storage (%llu bytes) successfully mounted at %s",
                                 (unsigned long long)detected_info.capacity_bytes, s_mount_base);
                    } else {
                        ESP_LOGE(TAG, "[Event ID: 1005] Failed to mount FATFS from USB drive: %s",
                                 esp_err_to_name(err));
                        portENTER_CRITICAL(&s_info_mux);
                        memset(&s_device_info, 0, sizeof(s_device_info));
                        portEXIT_CRITICAL(&s_info_mux);
                        msc_host_uninstall_device(s_msc_device);
                        s_msc_device = NULL;
                    }
                } else {
                    ESP_LOGE(TAG, "Failed to install USB Mass Storage device: %s", esp_err_to_name(err));
                }
            } else {
                reconcile_usb_device_state();
            }
        }
        vTaskDelay(pdMS_TO_TICKS(1500));
    }
}

esp_err_t usb_host_msc_init(const char *mount_path) {
    if (s_host_initialized) {
        ESP_LOGW(TAG, "USB MSC host initialization was requested more than once");
        return ESP_ERR_INVALID_STATE;
    }
    if (mount_path) {
        size_t mount_path_len = strnlen(mount_path, sizeof(s_mount_base));
        if (mount_path_len == 0 || mount_path_len >= sizeof(s_mount_base)) {
            ESP_LOGE(TAG, "USB mount path is empty or too long");
            return ESP_ERR_INVALID_ARG;
        }
        memcpy(s_mount_base, mount_path, mount_path_len + 1);
    }

    s_msc_mutex = xSemaphoreCreateBinary();
    if (s_msc_mutex == NULL) {
        ESP_LOGE(TAG, "Failed to allocate USB insertion semaphore");
        return ESP_ERR_NO_MEM;
    }

    /* 1. Install USB Host Library */
    const usb_host_config_t host_config = {
        .skip_phy_setup = false,
        .intr_flags = ESP_INTR_FLAG_LEVEL1,
    };
    esp_err_t err = usb_host_install(&host_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "USB Host install failed: %s", esp_err_to_name(err));
        return err;
    }

    s_host_initialized = true;
    BaseType_t task_result = xTaskCreatePinnedToCore(usb_host_lib_task, "usb_lib_task", 8192, NULL, 10, NULL, 0);
    if (task_result != pdPASS) {
        ESP_LOGE(TAG, "Failed to create USB host event task");
        esp_err_t uninstall_err = usb_host_uninstall();
        if (uninstall_err != ESP_OK) {
            ESP_LOGE(TAG, "USB host cleanup after task creation failure failed: %s", esp_err_to_name(uninstall_err));
        }
        s_host_initialized = false;
        vSemaphoreDelete(s_msc_mutex);
        s_msc_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }

    /* 2. Install MSC Host Driver */
    const msc_host_driver_config_t msc_config = {
        .create_backround_task = true,
        .task_priority = 10,
        .stack_size = 4096,
        .callback = msc_event_cb,
    };
    err = msc_host_install(&msc_config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "MSC Host install failed: %s", esp_err_to_name(err));
        return err;
    }

    task_result = xTaskCreatePinnedToCore(usb_msc_monitor_task, "usb_msc_task",
                                          USB_MSC_MONITOR_TASK_STACK_SIZE, NULL, 4, NULL, 1);
    if (task_result != pdPASS) {
        ESP_LOGE(TAG, "Failed to create USB MSC monitor task; devices will not be mounted");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool usb_host_msc_is_mounted(void) {
    bool mounted;
    portENTER_CRITICAL(&s_info_mux);
    mounted = s_is_mounted;
    portEXIT_CRITICAL(&s_info_mux);
    return mounted;
}

bool usb_host_msc_is_ready(void) {
    bool ready;
    portENTER_CRITICAL(&s_info_mux);
    ready = s_is_mounted && s_setup_complete;
    portEXIT_CRITICAL(&s_info_mux);
    return ready;
}

esp_err_t usb_host_msc_get_info(usb_host_msc_info_t *info) {
    if (!info) {
        return ESP_ERR_INVALID_ARG;
    }

    portENTER_CRITICAL(&s_info_mux);
    *info = s_device_info;
    bool capacity_valid = info->sector_size != 0 && info->sector_count != 0 &&
        info->sector_count <= UINT64_MAX / info->sector_size &&
        info->capacity_bytes == (uint64_t)info->sector_size * info->sector_count;
    portEXIT_CRITICAL(&s_info_mux);

    return capacity_valid ? ESP_OK : ESP_ERR_INVALID_STATE;
}

/* Report physical SCSI capacity and filesystem free space for the mounted volume. */
esp_err_t usb_host_msc_get_capacity(uint64_t *device_total_bytes,
                                    uint64_t *filesystem_total_bytes,
                                    uint64_t *filesystem_free_bytes) {
    if (!device_total_bytes || !filesystem_total_bytes || !filesystem_free_bytes) {
        return ESP_ERR_INVALID_ARG;
    }
    if (!usb_host_msc_is_mounted()) {
        return ESP_ERR_INVALID_STATE;
    }

    usb_host_msc_info_t info;
    esp_err_t err = usb_host_msc_get_info(&info);
    if (err != ESP_OK) {
        return err;
    }
    *device_total_bytes = info.capacity_bytes;

    err = esp_vfs_fat_info(s_mount_base, filesystem_total_bytes, filesystem_free_bytes);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to read filesystem capacity at %s: %s", s_mount_base, esp_err_to_name(err));
        return err;
    }
    if (*filesystem_free_bytes > *filesystem_total_bytes) {
        ESP_LOGE(TAG, "Filesystem reported more free space than its total capacity");
        return ESP_ERR_INVALID_STATE;
    }

    return ESP_OK;
}

esp_err_t usb_host_msc_prepare_shutdown(void) {
    if (!usb_host_msc_is_mounted()) {
        s_shutdown_prepared = true;
        return ESP_OK;
    }

    if (s_vfs_handle != NULL) {
        esp_err_t err = msc_host_vfs_unregister(s_vfs_handle);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to unregister USB filesystem for power operation: %s",
                     esp_err_to_name(err));
            return err;
        }
        s_vfs_handle = NULL;
    }

    portENTER_CRITICAL(&s_info_mux);
    s_is_mounted = false;
    s_setup_complete = false;
    portEXIT_CRITICAL(&s_info_mux);
    s_shutdown_prepared = true;
    return ESP_OK;
}

/* Ensure Windows 11 folders exist on USB drive */
void usb_host_msc_create_default_win11_dirs(void) {
    const char *dirs[] = {
        "/usb/Windows",
        "/usb/Windows/System32",
        "/usb/Program Files",
        "/usb/Users",
        "/usb/Users/Administrator",
        "/usb/Users/Administrator/Desktop",
        "/usb/Users/Administrator/Documents",
        "/usb/system",
        "/usb/media"
    };

    for (size_t i = 0; i < sizeof(dirs) / sizeof(dirs[0]); i++) {
        esp_err_t err = usb_storage_map_mkdir(dirs[i]);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to create abstracted USB folder %s: %s",
                     dirs[i], esp_err_to_name(err));
        }
    }
}
