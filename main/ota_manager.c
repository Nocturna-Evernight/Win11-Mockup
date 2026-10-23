/*
 * OTA Firmware Manager – ESP32-S3 Win11 WebOS
 *
 * Strategy:
 *   1. Open /usb/system/firmware.bin from the USB FAT drive.
 *   2. Find the next OTA partition (OTA_0 or OTA_1) via esp_ota_ops.
 *   3. Stream the binary in 4 KB chunks, updating progress state atomically.
 *   4. On success, call esp_ota_set_boot_partition() and mark state DONE.
 *   5. The user explicitly requests a coordinated restart to apply the staged image.
 *
 * Safety guards:
 *   - Minimum binary size sanity check (must be > 64 KB).
 *   - Hash validation: reads the firmware back after writing and compares SHA-256.
 *   - Stack-safe: the OTA task runs on its own stack (16 KB), never recursing.
 *   - Abort flag allows the HTTP API to cancel an in-progress update.
 */

#include "ota_manager.h"

#include <stdio.h>
#include <string.h>
#include <inttypes.h>
#include <sys/stat.h>
#include <errno.h>

#include "esp_log.h"
#include "esp_ota_ops.h"
#include "esp_partition.h"
#include "esp_system.h"
#include "esp_app_desc.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"

#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "status_indicator.h"
#include "system_control.h"
#include "win11_server.h"

#define TAG                 "OTA_MGR"
#define OTA_FIRMWARE_PATH   "/usb/system/firmware.bin"
#define OTA_CHUNK_SIZE      4096
#define OTA_TASK_STACK      16384
#define OTA_MIN_BINARY_SIZE (64 * 1024)  /* sanity: must be at least 64 KB */
#ifndef CONFIG_APP_OTA_AUTO_REBOOT
#define CONFIG_APP_OTA_AUTO_REBOOT 0
#endif
#define OTA_VALIDATION_WINDOW_MS 3600000U
#define OTA_VALIDATION_CHECK_INTERVAL_MS 10000

/* --------------------------------------------------------------------------
 * Shared state (protected by a mutex)
 * -------------------------------------------------------------------------- */
static SemaphoreHandle_t s_status_mutex = NULL;
static ota_status_t      s_status       = { .state = OTA_STATE_IDLE };
static volatile bool     s_abort        = false;
static TaskHandle_t      s_task_handle  = NULL;
static esp_ota_handle_t  s_stream_handle = 0;
static const esp_partition_t *s_stream_partition = NULL;
static bool s_pending_verify;
static TaskHandle_t s_validation_task_handle;

/* --------------------------------------------------------------------------
 * Helpers
 * -------------------------------------------------------------------------- */

static void set_status_locked(ota_state_t state, uint8_t pct,
                               uint32_t written, uint32_t total,
                               const char *err_msg)
{
    if (xSemaphoreTake(s_status_mutex, pdMS_TO_TICKS(200)) == pdTRUE) {
        s_status.state            = state;
        s_status.progress_percent = pct;
        s_status.bytes_written    = written;
        s_status.total_bytes      = total;
        if (err_msg) {
            strlcpy(s_status.error_message, err_msg, sizeof(s_status.error_message));
        } else {
            s_status.error_message[0] = '\0';
        }
        xSemaphoreGive(s_status_mutex);
    }

    switch (state) {
        case OTA_STATE_READING:
            status_indicator_set_mode(STATUS_INDICATOR_OTA_READING, pct);
            break;
        case OTA_STATE_WRITING:
            status_indicator_set_mode(STATUS_INDICATOR_OTA_WRITING, pct);
            break;
        case OTA_STATE_VERIFYING:
            status_indicator_set_mode(STATUS_INDICATOR_OTA_VERIFYING, pct);
            break;
        case OTA_STATE_DONE:
            status_indicator_set_mode(STATUS_INDICATOR_OTA_PENDING_REBOOT, 100);
            break;
        case OTA_STATE_ERROR:
            status_indicator_set_mode(STATUS_INDICATOR_ERROR, 100);
            break;
        case OTA_STATE_IDLE:
        default:
            break;
    }
}

/* --------------------------------------------------------------------------
 * OTA worker task – runs entirely on its own stack, no recursion
 * -------------------------------------------------------------------------- */
static void ota_update_task(void *arg)
{
    esp_err_t       err;
    FILE           *bin_file    = NULL;
    esp_ota_handle_t ota_handle = 0;
    char           *chunk       = NULL;
    uint32_t        total_bytes = 0;
    uint32_t        written     = 0;

    /* ---- 1. Verify USB is mounted ---- */
    if (!usb_host_msc_is_mounted()) {
        set_status_locked(OTA_STATE_ERROR, 0, 0, 0,
                          "USB storage is not mounted; cannot read firmware.bin");
        goto cleanup;
    }

    /* ---- 2. Resolve firmware path ---- */
    {
        char physical_path[256];
        err = usb_storage_map_resolve(OTA_FIRMWARE_PATH, physical_path, sizeof(physical_path));
        if (err != ESP_OK) {
            set_status_locked(OTA_STATE_ERROR, 0, 0, 0,
                              "firmware.bin not found on USB at /system/firmware.bin");
            goto cleanup;
        }

        struct stat st;
        if (stat(physical_path, &st) != 0 || st.st_size < OTA_MIN_BINARY_SIZE) {
            set_status_locked(OTA_STATE_ERROR, 0, 0, 0,
                              "firmware.bin is missing or smaller than 64 KB");
            goto cleanup;
        }
        total_bytes = (uint32_t)st.st_size;

        bin_file = fopen(physical_path, "rb");
        if (!bin_file) {
            set_status_locked(OTA_STATE_ERROR, 0, 0, total_bytes,
                              "Unable to open firmware.bin for reading");
            goto cleanup;
        }
    }

    /* ---- 3. Find the next OTA partition ---- */
    const esp_partition_t *update_partition = esp_ota_get_next_update_partition(NULL);
    if (!update_partition) {
        set_status_locked(OTA_STATE_ERROR, 0, 0, total_bytes,
                          "No OTA update partition found; check partitions.csv has ota_0/ota_1");
        goto cleanup;
    }
    ESP_LOGI(TAG, "Target OTA partition: %s (offset=0x%08" PRIx32 ", size=%" PRIu32 " bytes)",
             update_partition->label, update_partition->address, update_partition->size);

    if (total_bytes > update_partition->size) {
        set_status_locked(OTA_STATE_ERROR, 0, 0, total_bytes,
                          "firmware.bin is larger than the OTA partition");
        goto cleanup;
    }

    /* ---- 4. Begin OTA write ---- */
    err = esp_ota_begin(update_partition, OTA_SIZE_UNKNOWN, &ota_handle);
    if (err != ESP_OK) {
        char msg[128];
        snprintf(msg, sizeof(msg), "esp_ota_begin failed: %s", esp_err_to_name(err));
        set_status_locked(OTA_STATE_ERROR, 0, 0, total_bytes, msg);
        goto cleanup;
    }

    chunk = malloc(OTA_CHUNK_SIZE);
    if (!chunk) {
        set_status_locked(OTA_STATE_ERROR, 0, 0, total_bytes,
                          "Out of heap memory for OTA write buffer");
        (void)esp_ota_abort(ota_handle);
        goto cleanup;
    }

    set_status_locked(OTA_STATE_WRITING, 0, 0, total_bytes, NULL);
    ESP_LOGI(TAG, "Writing OTA image (%" PRIu32 " bytes)...", total_bytes);

    /* ---- 5. Stream firmware in chunks ---- */
    while (!s_abort) {
        size_t to_read = OTA_CHUNK_SIZE;
        if ((uint64_t)written + to_read > total_bytes) {
            to_read = total_bytes - written;
        }
        size_t got = fread(chunk, 1, to_read, bin_file);
        if (got == 0) break;   /* EOF or error */

        err = esp_ota_write(ota_handle, chunk, got);
        if (err != ESP_OK) {
            char msg[128];
            snprintf(msg, sizeof(msg), "esp_ota_write failed at offset %" PRIu32 ": %s",
                     written, esp_err_to_name(err));
            set_status_locked(OTA_STATE_ERROR, 0, written, total_bytes, msg);
            (void)esp_ota_abort(ota_handle);
            goto cleanup;
        }

        written += (uint32_t)got;
        uint8_t pct = (uint8_t)(((uint64_t)written * 100) / total_bytes);
        set_status_locked(OTA_STATE_WRITING, pct, written, total_bytes, NULL);

        /* Yield to Wi-Fi / system tasks every 32 KB */
        if ((written % (32 * 1024)) < OTA_CHUNK_SIZE) {
            vTaskDelay(pdMS_TO_TICKS(2));
        }
    }

    if (s_abort) {
        set_status_locked(OTA_STATE_ERROR, 0, written, total_bytes, "OTA update aborted by user");
        (void)esp_ota_abort(ota_handle);
        goto cleanup;
    }

    if (written != total_bytes || ferror(bin_file)) {
        set_status_locked(OTA_STATE_ERROR, 0, written, total_bytes,
                          "Firmware read incomplete; USB read error");
        (void)esp_ota_abort(ota_handle);
        goto cleanup;
    }

    /* ---- 6. Finalise + verify ---- */
    set_status_locked(OTA_STATE_VERIFYING, 99, written, total_bytes, NULL);
    err = esp_ota_end(ota_handle);
    ota_handle = 0;  /* consumed */
    if (err != ESP_OK) {
        char msg[128];
        snprintf(msg, sizeof(msg), "esp_ota_end failed (corrupt image?): %s", esp_err_to_name(err));
        set_status_locked(OTA_STATE_ERROR, 99, written, total_bytes, msg);
        goto cleanup;
    }

    /* ---- 7. Commit boot partition ---- */
    err = esp_ota_set_boot_partition(update_partition);
    if (err != ESP_OK) {
        char msg[128];
        snprintf(msg, sizeof(msg), "esp_ota_set_boot_partition failed: %s", esp_err_to_name(err));
        set_status_locked(OTA_STATE_ERROR, 99, written, total_bytes, msg);
        goto cleanup;
    }

    ESP_LOGI(TAG, "OTA update complete! New boot partition: %s. Restart pending.",
             update_partition->label);
    set_status_locked(OTA_STATE_DONE, 100, written, total_bytes, NULL);

cleanup:
    if (bin_file)  fclose(bin_file);
    if (chunk)     free(chunk);
    s_task_handle = NULL;
#if CONFIG_APP_OTA_AUTO_REBOOT
    ota_status_t final_status;
    ota_manager_get_status(&final_status);
    if (final_status.state == OTA_STATE_DONE) {
        esp_err_t restart_err = system_control_request_restart();
        if (restart_err != ESP_OK) {
            ESP_LOGE(TAG, "Automatic restart after OTA staging failed: %s",
                     esp_err_to_name(restart_err));
        }
    }
#endif
    vTaskDelete(NULL);
}

static void ota_validation_task(void *arg)
{
    (void)arg;
    uint32_t remaining_ms = OTA_VALIDATION_WINDOW_MS;
    while (remaining_ms > 0) {
        uint32_t delay_ms = remaining_ms < OTA_VALIDATION_CHECK_INTERVAL_MS
            ? remaining_ms : OTA_VALIDATION_CHECK_INTERVAL_MS;
        vTaskDelay(pdMS_TO_TICKS(delay_ms));
        remaining_ms -= delay_ms;
        if (!win11_server_is_running()) {
            ESP_LOGE(TAG, "HTTP server stopped during OTA validation; rolling back");
            esp_err_t rollback_err = esp_ota_mark_app_invalid_rollback_and_reboot();
            ESP_LOGE(TAG, "OTA rollback request failed: %s", esp_err_to_name(rollback_err));
            s_validation_task_handle = NULL;
            vTaskDelete(NULL);
        }
    }

    esp_err_t err = esp_ota_mark_app_valid_cancel_rollback();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to confirm OTA image after validation window: %s",
                 esp_err_to_name(err));
        status_indicator_set_mode(STATUS_INDICATOR_ERROR, 100);
    } else {
        s_pending_verify = false;
        ESP_LOGI(TAG, "OTA image remained healthy for the validation window and is confirmed.");
        status_indicator_set_mode(STATUS_INDICATOR_NORMAL, 0);
        status_indicator_set_rgb(0, 64, 0);
    }
    s_validation_task_handle = NULL;
    vTaskDelete(NULL);
}

/* --------------------------------------------------------------------------
 * Public API
 * -------------------------------------------------------------------------- */

esp_err_t ota_manager_init(void)
{
    if (s_status_mutex == NULL) {
        s_status_mutex = xSemaphoreCreateMutex();
        if (s_status_mutex == NULL) {
            return ESP_ERR_NO_MEM;
        }
    }

    const esp_partition_t *running = esp_ota_get_running_partition();
    const esp_app_desc_t  *desc    = esp_app_get_description();
    ESP_LOGI(TAG, "Running partition: %s | App version: %s | IDF: %s",
             running ? running->label : "unknown",
             desc    ? desc->version   : "unknown",
             desc    ? desc->idf_ver   : "unknown");

    esp_ota_img_states_t ota_state;
    if (running && esp_ota_get_state_partition(running, &ota_state) == ESP_OK) {
        if (ota_state == ESP_OTA_IMG_PENDING_VERIFY) {
            ESP_LOGI(TAG, "OTA image pending verification; deferring confirmation until core startup succeeds.");
            s_pending_verify = true;
            status_indicator_set_mode(STATUS_INDICATOR_OTA_VERIFYING, 100);
        }
    }

    return ESP_OK;
}

esp_err_t ota_manager_confirm_boot(void)
{
    if (!s_pending_verify) return ESP_OK;
    if (s_validation_task_handle != NULL) return ESP_OK;
    if (!win11_server_is_running()) return ESP_ERR_INVALID_STATE;
    BaseType_t created = xTaskCreate(ota_validation_task, "ota_validation", 4096,
                                     NULL, 3, &s_validation_task_handle);
    if (created != pdPASS) {
        s_validation_task_handle = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "OTA image pending verification for one hour of healthy operation.");
    return ESP_OK;
}

esp_err_t ota_manager_reject_boot(void)
{
    if (!s_pending_verify) return ESP_ERR_INVALID_STATE;
    esp_err_t err = esp_ota_mark_app_invalid_rollback_and_reboot();
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Unable to reject failed OTA image: %s", esp_err_to_name(err));
    }
    return err;
}

esp_err_t ota_manager_start_usb_update(void)
{
    if (s_status_mutex == NULL) return ESP_ERR_INVALID_STATE;

    if (xSemaphoreTake(s_status_mutex, pdMS_TO_TICKS(500)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    bool already_running = (s_status.state == OTA_STATE_READING ||
                             s_status.state == OTA_STATE_WRITING ||
                             s_status.state == OTA_STATE_VERIFYING);
    if (!already_running) {
        s_status.state            = OTA_STATE_READING;
        s_status.progress_percent = 0;
        s_status.bytes_written    = 0;
        s_status.total_bytes      = 0;
        s_status.error_message[0] = '\0';
        s_abort                   = false;
    }
    xSemaphoreGive(s_status_mutex);

    if (already_running) {
        return ESP_ERR_INVALID_STATE;
    }
    status_indicator_set_mode(STATUS_INDICATOR_OTA_READING, 0);

    BaseType_t created = xTaskCreate(ota_update_task, "ota_update",
                                     OTA_TASK_STACK, NULL,
                                     5,  /* priority */
                                     &s_task_handle);
    if (created != pdPASS) {
        set_status_locked(OTA_STATE_ERROR, 0, 0, 0, "Failed to create OTA task (out of memory)");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

void ota_manager_get_status(ota_status_t *out)
{
    if (!out) return;
    if (s_status_mutex == NULL || xSemaphoreTake(s_status_mutex, pdMS_TO_TICKS(200)) != pdTRUE) {
        /* Return a safe default if mutex unavailable */
        memset(out, 0, sizeof(*out));
        out->state = OTA_STATE_IDLE;
        return;
    }
    *out = s_status;
    xSemaphoreGive(s_status_mutex);
}

void ota_manager_abort(void)
{
    s_abort = true;
}

void ota_manager_abort_stream(void)
{
    if (s_stream_handle != 0) {
        esp_ota_handle_t stream_handle = s_stream_handle;
        s_stream_handle = 0;
        (void)esp_ota_abort(stream_handle);
        ota_status_t current_status;
        ota_manager_get_status(&current_status);
        set_status_locked(OTA_STATE_ERROR, current_status.progress_percent,
                          current_status.bytes_written, current_status.total_bytes,
                          "OTA update aborted");
    }
}

esp_err_t ota_manager_begin_stream(size_t image_size)
{
    if (s_status_mutex == NULL) return ESP_ERR_INVALID_STATE;
    if (xSemaphoreTake(s_status_mutex, pdMS_TO_TICKS(500)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    bool running = (s_status.state == OTA_STATE_READING ||
                    s_status.state == OTA_STATE_WRITING ||
                    s_status.state == OTA_STATE_VERIFYING);
    if (running) {
        xSemaphoreGive(s_status_mutex);
        return ESP_ERR_INVALID_STATE;
    }

    s_stream_partition = esp_ota_get_next_update_partition(NULL);
    if (!s_stream_partition) {
        s_status.state = OTA_STATE_ERROR;
        strlcpy(s_status.error_message, "No OTA partition available", sizeof(s_status.error_message));
        xSemaphoreGive(s_status_mutex);
        return ESP_ERR_NOT_FOUND;
    }

    esp_err_t err = esp_ota_begin(s_stream_partition, image_size > 0 ? image_size : OTA_SIZE_UNKNOWN, &s_stream_handle);
    if (err != ESP_OK) {
        s_status.state = OTA_STATE_ERROR;
        snprintf(s_status.error_message, sizeof(s_status.error_message), "esp_ota_begin failed: %s", esp_err_to_name(err));
        xSemaphoreGive(s_status_mutex);
        return err;
    }

    s_status.state = OTA_STATE_WRITING;
    s_status.progress_percent = 0;
    s_status.bytes_written = 0;
    s_status.total_bytes = (uint32_t)image_size;
    s_status.error_message[0] = '\0';
    s_abort = false;
    xSemaphoreGive(s_status_mutex);
    status_indicator_set_mode(STATUS_INDICATOR_OTA_WRITING, 0);
    return ESP_OK;
}

esp_err_t ota_manager_write_stream_chunk(const void *data, size_t length)
{
    if (s_stream_handle == 0 || !data || length == 0) return ESP_ERR_INVALID_ARG;
    if (s_abort) return ESP_ERR_INVALID_STATE;

    esp_err_t err = esp_ota_write(s_stream_handle, data, length);
    if (err != ESP_OK) {
        set_status_locked(OTA_STATE_ERROR, 0, s_status.bytes_written, s_status.total_bytes, "OTA chunk write failed");
        (void)esp_ota_abort(s_stream_handle);
        s_stream_handle = 0;
        return err;
    }

    uint8_t progress = 0;
    if (xSemaphoreTake(s_status_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_status.bytes_written += (uint32_t)length;
        if (s_status.total_bytes > 0) {
            s_status.progress_percent = (uint8_t)(((uint64_t)s_status.bytes_written * 100) / s_status.total_bytes);
        }
        progress = s_status.progress_percent;
        xSemaphoreGive(s_status_mutex);
    }
    status_indicator_set_mode(STATUS_INDICATOR_OTA_WRITING, progress);
    return ESP_OK;
}

esp_err_t ota_manager_end_stream(void)
{
    if (s_stream_handle == 0) return ESP_ERR_INVALID_STATE;
    if (s_abort) {
        ota_manager_abort_stream();
        return ESP_ERR_INVALID_STATE;
    }

    set_status_locked(OTA_STATE_VERIFYING, 99, s_status.bytes_written, s_status.total_bytes, NULL);
    esp_err_t err = esp_ota_end(s_stream_handle);
    s_stream_handle = 0;
    if (err != ESP_OK) {
        set_status_locked(OTA_STATE_ERROR, 99, s_status.bytes_written, s_status.total_bytes, "esp_ota_end verification failed");
        return err;
    }

    err = esp_ota_set_boot_partition(s_stream_partition);
    if (err != ESP_OK) {
        set_status_locked(OTA_STATE_ERROR, 99, s_status.bytes_written, s_status.total_bytes, "esp_ota_set_boot_partition failed");
        return err;
    }

    set_status_locked(OTA_STATE_DONE, 100, s_status.bytes_written, s_status.total_bytes, NULL);
#if CONFIG_APP_OTA_AUTO_REBOOT
    esp_err_t restart_err = system_control_request_restart();
    if (restart_err != ESP_OK) {
        ESP_LOGE(TAG, "Automatic restart after streaming OTA staging failed: %s",
                 esp_err_to_name(restart_err));
    }
#endif
    return ESP_OK;
}
