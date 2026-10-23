/*
 * OTA Firmware Manager for ESP32-S3 Win11 WebOS
 * Supports USB-based OTA: reads /usb/system/firmware.bin and flashes OTA partition
 */
#ifndef OTA_MANAGER_H
#define OTA_MANAGER_H

#include <stdint.h>
#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

typedef enum {
    OTA_STATE_IDLE         = 0,
    OTA_STATE_READING      = 1,   /* Reading firmware from USB */
    OTA_STATE_WRITING      = 2,   /* Writing to OTA partition  */
    OTA_STATE_VERIFYING    = 3,   /* Verifying written data    */
    OTA_STATE_DONE         = 4,   /* OTA complete, pending reboot */
    OTA_STATE_ERROR        = 5,   /* An error occurred         */
} ota_state_t;

typedef struct {
    ota_state_t state;
    uint8_t     progress_percent;  /* 0–100                    */
    uint32_t    bytes_written;
    uint32_t    total_bytes;
    char        error_message[128];
    char        firmware_version[64]; /* parsed from header if present */
} ota_status_t;

/**
 * @brief Initialize OTA manager subsystem (call once at startup).
 *        Logs the currently running partition and any pending OTA info.
 */
esp_err_t ota_manager_init(void);
esp_err_t ota_manager_confirm_boot(void);
esp_err_t ota_manager_reject_boot(void);

/**
 * @brief Trigger an OTA update from USB.
 *        Reads /usb/system/firmware.bin and flashes it to the next OTA slot.
 *        This launches a background FreeRTOS task; call ota_manager_get_status()
 *        to poll progress.
 * @return ESP_OK if task started, ESP_ERR_INVALID_STATE if already running.
 */
esp_err_t ota_manager_start_usb_update(void);

/**
 * @brief Get a snapshot of the current OTA status (thread-safe).
 */
void ota_manager_get_status(ota_status_t *out);

/**
 * @brief Abort a pending OTA update (if possible).
 *        Has no effect if OTA has already completed.
 */
void ota_manager_abort(void);

/**
 * @brief Abort and clean up an HTTP streaming OTA update.
 *        Call from the upload handler after its current chunk write has stopped.
 */
void ota_manager_abort_stream(void);

/**
 * @brief Begin a streaming OTA update (e.g. from HTTP upload).
 * @param image_size Expected total binary size in bytes.
 */
esp_err_t ota_manager_begin_stream(size_t image_size);

/**
 * @brief Write a chunk of data to the streaming OTA partition.
 */
esp_err_t ota_manager_write_stream_chunk(const void *data, size_t length);

/**
 * @brief Finalize and commit a streaming OTA update.
 */
esp_err_t ota_manager_end_stream(void);

#ifdef __cplusplus
}
#endif

#endif /* OTA_MANAGER_H */
