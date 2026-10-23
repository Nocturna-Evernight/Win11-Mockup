#pragma once

#include <stdbool.h>
#include "esp_err.h"

esp_err_t system_control_init(void);
esp_err_t system_control_request_restart(void);
esp_err_t system_control_request_shutdown_preparation(void);
