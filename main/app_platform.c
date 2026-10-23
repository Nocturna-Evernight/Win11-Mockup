/*
 * App Platform Watchdog Implementation
 * Runs a FreeRTOS task at priority 2 that:
 *  - Samples internal heap + PSRAM every 500 ms
 *  - Emits pressure callbacks when levels change
 *  - At CRITICAL: calls cleanup helpers + logs warnings
 *  - At EMERGENCY: logs and suspends non-essential work
 *  - Also exposes app_platform_get_pressure() for REST API use
 */
#include "app_platform.h"
#include "status_indicator.h"
#include "usb_host_msc.h"
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include <string.h>

#define TAG "APP_PLATFORM"

/* --- Thresholds (bytes) -------------------------------------------- */
#define INTERNAL_WARN_BYTES      (60u  * 1024u)
#define INTERNAL_CRIT_BYTES      (30u  * 1024u)
#define INTERNAL_EMERG_BYTES     (15u  * 1024u)
#define PSRAM_WARN_BYTES         (512u * 1024u)
#define PSRAM_CRIT_BYTES         (128u * 1024u)

#define MAX_PRESSURE_CBS         8
#define WATCHDOG_TASK_STACK      4096
#define WATCHDOG_TASK_PRIORITY   2
#define WATCHDOG_POLL_MS         500

/* --- State ---------------------------------------------------------- */
static SemaphoreHandle_t         s_mutex;
static platform_resource_snapshot_t s_snapshot;
static platform_pressure_cb_t    s_callbacks[MAX_PRESSURE_CBS];
static uint8_t                   s_cb_count;
static bool                      s_initialized;

/* --- Internal helpers ---------------------------------------------- */
static platform_pressure_t compute_pressure(size_t int_free, size_t psram_free)
{
    if (int_free < INTERNAL_EMERG_BYTES) {
        return PLATFORM_PRESSURE_EMERGENCY;
    }
    if (int_free < INTERNAL_CRIT_BYTES || psram_free < PSRAM_CRIT_BYTES) {
        return PLATFORM_PRESSURE_CRITICAL;
    }
    if (int_free < INTERNAL_WARN_BYTES || psram_free < PSRAM_WARN_BYTES) {
        return PLATFORM_PRESSURE_LOW;
    }
    return PLATFORM_PRESSURE_NONE;
}

static const char *pressure_level_name(platform_pressure_t level)
{
    static const char *names[] = {"none", "low", "critical", "emergency"};
    return level <= PLATFORM_PRESSURE_EMERGENCY ? names[level] : "unknown";
}

static void invoke_callbacks(platform_pressure_t level, const platform_resource_snapshot_t *snap)
{
    for (uint8_t i = 0; i < s_cb_count; i++) {
        if (s_callbacks[i]) {
            s_callbacks[i](level, snap);
        }
    }
}

static void watchdog_task(void *arg)
{
    platform_pressure_t last_level = PLATFORM_PRESSURE_NONE;
    uint32_t emerg_count = 0;
    TickType_t last_pressure_log_tick = 0;
    bool pressure_logged = false;

    for (;;) {
        vTaskDelay(pdMS_TO_TICKS(WATCHDOG_POLL_MS));

        size_t int_free  = heap_caps_get_free_size(MALLOC_CAP_INTERNAL);
        size_t int_min   = heap_caps_get_minimum_free_size(MALLOC_CAP_INTERNAL);
        size_t psram_free = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);

        platform_pressure_t level = compute_pressure(int_free, psram_free);
        bool level_changed = level != last_level;
        if (level == PLATFORM_PRESSURE_EMERGENCY && last_level != PLATFORM_PRESSURE_EMERGENCY) {
            emerg_count++;
        }

        /* Build snapshot */
        platform_resource_snapshot_t snap = {
            .level                = level,
            .internal_free_bytes  = int_free,
            .internal_min_free_bytes = int_min,
            .psram_free_bytes     = psram_free,
            .http_suspended       = false,
            .emergency_count      = emerg_count,
        };

        /* Pressure-specific actions */
        if (level >= PLATFORM_PRESSURE_EMERGENCY) {
            snap.http_suspended = true;
        }
        snap.emergency_count = emerg_count;

        /* Update shared snapshot under lock */
        if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_snapshot = snap;
            xSemaphoreGive(s_mutex);
        }

        /* Fire callbacks on level change */
        if (level_changed) {
            if (level >= PLATFORM_PRESSURE_EMERGENCY) {
                status_indicator_set_rgb(255, 0, 0);
            } else if (level >= PLATFORM_PRESSURE_CRITICAL) {
                status_indicator_set_rgb(255, 24, 0);
            } else if (level >= PLATFORM_PRESSURE_LOW) {
                status_indicator_set_rgb(255, 72, 0);
            } else if (usb_host_msc_is_mounted()) {
                status_indicator_set_rgb(0, 64, 0);
            } else {
                status_indicator_set_rgb(0, 0, 96);
            }
            TickType_t now = xTaskGetTickCount();
            if (!pressure_logged || level == PLATFORM_PRESSURE_EMERGENCY ||
                (TickType_t)(now - last_pressure_log_tick) >= pdMS_TO_TICKS(10000)) {
                if (level >= PLATFORM_PRESSURE_CRITICAL) {
                    ESP_LOGW(TAG, "Memory pressure %s: internal=%zu bytes, PSRAM=%zu bytes",
                             pressure_level_name(level), int_free, psram_free);
                } else {
                    ESP_LOGI(TAG, "Memory pressure %s: internal=%zu bytes, PSRAM=%zu bytes",
                             pressure_level_name(level), int_free, psram_free);
                }
                last_pressure_log_tick = now;
                pressure_logged = true;
            }
            invoke_callbacks(level, &snap);
            last_level = level;
        }
    }
}

/* --- Public API ---------------------------------------------------- */

esp_err_t app_platform_init(void)
{
    if (s_initialized) {
        return ESP_OK;
    }
    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) {
        ESP_LOGE(TAG, "Failed to create mutex");
        return ESP_ERR_NO_MEM;
    }
    memset(&s_snapshot, 0, sizeof(s_snapshot));
    s_cb_count    = 0;
    s_initialized = true;

    BaseType_t ret = xTaskCreate(watchdog_task, "app_platform_wd",
                                  WATCHDOG_TASK_STACK, NULL,
                                  WATCHDOG_TASK_PRIORITY, NULL);
    if (ret != pdPASS) {
        ESP_LOGE(TAG, "Failed to create watchdog task");
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "App platform watchdog started (poll=500ms, "
                  "warn=%uKB, crit=%uKB, emerg=%uKB)",
             INTERNAL_WARN_BYTES / 1024,
             INTERNAL_CRIT_BYTES / 1024,
             INTERNAL_EMERG_BYTES / 1024);
    return ESP_OK;
}

platform_resource_snapshot_t app_platform_get_pressure(void)
{
    platform_resource_snapshot_t snap = {0};
    if (s_mutex && xSemaphoreTake(s_mutex, pdMS_TO_TICKS(50)) == pdTRUE) {
        snap = s_snapshot;
        xSemaphoreGive(s_mutex);
    }
    return snap;
}

esp_err_t app_platform_register_pressure_cb(platform_pressure_cb_t cb)
{
    if (!cb) return ESP_ERR_INVALID_ARG;
    if (s_cb_count >= MAX_PRESSURE_CBS) return ESP_ERR_NO_MEM;
    s_callbacks[s_cb_count++] = cb;
    return ESP_OK;
}
