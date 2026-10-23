/*
 * App Platform Watchdog — Memory pressure monitor and emergency safeguard
 * for the ESP32-S3 N16R8 (512KB internal SRAM, 8MB Octal PSRAM)
 *
 * Thresholds:
 *   Internal heap WARNING  : < 60 KB  → broadcasts 'low_memory' pressure event
 *   Internal heap CRITICAL : < 30 KB  → closes idle HTTP connections, frees caches
 *   Internal heap EMERGENCY: < 15 KB  → suspends HTTP server accept loop
 *   PSRAM WARNING          : < 512 KB → broadcasts 'psram_low' pressure event
 *   PSRAM CRITICAL         : < 128 KB → frees PSRAM caches
 */
#pragma once
#include "esp_err.h"
#include <stdint.h>
#include <stdbool.h>
#include <stddef.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Memory pressure levels, ordered by severity */
typedef enum {
    PLATFORM_PRESSURE_NONE     = 0,  /**< All resources nominal */
    PLATFORM_PRESSURE_LOW      = 1,  /**< < 60 KB internal or < 512 KB PSRAM */
    PLATFORM_PRESSURE_CRITICAL = 2,  /**< < 30 KB internal or < 128 KB PSRAM */
    PLATFORM_PRESSURE_EMERGENCY= 3,  /**< < 15 KB internal — HTTP suspended */
} platform_pressure_t;

/** Snapshot returned by app_platform_get_pressure() */
typedef struct {
    platform_pressure_t level;          /**< Highest active pressure level */
    size_t internal_free_bytes;         /**< Current free internal heap */
    size_t internal_min_free_bytes;     /**< All-time minimum free internal heap */
    size_t psram_free_bytes;            /**< Current free PSRAM */
    bool   http_suspended;              /**< True if HTTP accept loop is suspended */
    uint32_t emergency_count;           /**< How many times emergency was triggered */
} platform_resource_snapshot_t;

/**
 * Initialize and start the platform watchdog task.
 * Must be called after esp_heap_caps and FreeRTOS scheduler are running.
 * @return ESP_OK on success
 */
esp_err_t app_platform_init(void);

/**
 * Get the current resource pressure snapshot (thread-safe).
 */
platform_resource_snapshot_t app_platform_get_pressure(void);

/**
 * Register a callback invoked from the watchdog task when pressure changes.
 * Up to 8 callbacks may be registered.
 * @param cb  Callback function — keep it fast (no blocking calls).
 * @return ESP_OK or ESP_ERR_NO_MEM if the table is full
 */
typedef void (*platform_pressure_cb_t)(platform_pressure_t level, const platform_resource_snapshot_t *snap);
esp_err_t app_platform_register_pressure_cb(platform_pressure_cb_t cb);

#ifdef __cplusplus
}
#endif
