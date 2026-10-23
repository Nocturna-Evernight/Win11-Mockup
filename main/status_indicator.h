#pragma once

#include <stdint.h>
#include "esp_err.h"

typedef enum {
    STATUS_INDICATOR_NORMAL = 0,
    STATUS_INDICATOR_OTA_READING,
    STATUS_INDICATOR_OTA_WRITING,
    STATUS_INDICATOR_OTA_VERIFYING,
    STATUS_INDICATOR_OTA_PENDING_REBOOT,
    STATUS_INDICATOR_ERROR,
    STATUS_INDICATOR_POWER_PREPARING,
    STATUS_INDICATOR_POWER_READY,
} status_indicator_mode_t;

esp_err_t status_indicator_init(void);
void status_indicator_set_rgb(uint8_t red, uint8_t green, uint8_t blue);
void status_indicator_set_mode(status_indicator_mode_t mode, uint8_t progress_percent);