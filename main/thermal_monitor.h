#ifndef THERMAL_MONITOR_H
#define THERMAL_MONITOR_H

#include <stdbool.h>
#include "esp_err.h"

esp_err_t thermal_monitor_init(void);
bool thermal_monitor_get_celsius(float *temperature_celsius);
esp_err_t thermal_monitor_start_load_test(void);
bool thermal_monitor_is_load_test_running(void);

#endif
