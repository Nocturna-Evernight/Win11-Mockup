#include "thermal_monitor.h"

#include <stdint.h>
#include "driver/temperature_sensor.h"
#include "esp_log.h"
#include "freertos/FreeRTOS.h"
#include "freertos/portmacro.h"
#include "freertos/task.h"

static const char *TAG = "THERMAL";
static portMUX_TYPE s_temperature_mux = portMUX_INITIALIZER_UNLOCKED;
static float s_temperature_celsius;
static bool s_temperature_valid;
static bool s_load_test_running;
static volatile uint32_t s_load_test_sink;

static void bounded_cpu_load_task(void *arg) {
    const TickType_t duration = pdMS_TO_TICKS(10000);
    const TickType_t started = xTaskGetTickCount();
    uint32_t value = 0x12345678;
    while ((TickType_t)(xTaskGetTickCount() - started) < duration) {
        for (uint32_t i = 0; i < 10000; i++) {
            value = (value << 5) ^ (value >> 2) ^ i;
        }
        s_load_test_sink = value;
        vTaskDelay(1);
    }
    portENTER_CRITICAL(&s_temperature_mux);
    s_load_test_running = false;
    portEXIT_CRITICAL(&s_temperature_mux);
    vTaskDelete(NULL);
}

static void temperature_monitor_task(void *arg) {
    temperature_sensor_config_t config = TEMPERATURE_SENSOR_CONFIG_DEFAULT(-10, 80);
    temperature_sensor_handle_t sensor = NULL;
    esp_err_t err = temperature_sensor_install(&config, &sensor);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to install internal temperature sensor: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    err = temperature_sensor_enable(sensor);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Failed to enable internal temperature sensor: %s", esp_err_to_name(err));
        temperature_sensor_uninstall(sensor);
        vTaskDelete(NULL);
        return;
    }

    for (;;) {
        float temperature_celsius = 0;
        err = temperature_sensor_get_celsius(sensor, &temperature_celsius);
        if (err == ESP_OK) {
            portENTER_CRITICAL(&s_temperature_mux);
            s_temperature_celsius = temperature_celsius;
            s_temperature_valid = true;
            portEXIT_CRITICAL(&s_temperature_mux);
        } else {
            ESP_LOGE(TAG, "Failed to read internal temperature: %s", esp_err_to_name(err));
        }
        vTaskDelay(pdMS_TO_TICKS(2000));
    }
}

esp_err_t thermal_monitor_init(void) {
    if (xTaskCreate(temperature_monitor_task, "temperature_monitor", 3072, NULL, 2, NULL) != pdPASS) {
        ESP_LOGE(TAG, "Failed to create internal temperature monitor task");
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

bool thermal_monitor_get_celsius(float *temperature_celsius) {
    if (temperature_celsius == NULL) {
        return false;
    }
    portENTER_CRITICAL(&s_temperature_mux);
    bool valid = s_temperature_valid;
    if (valid) {
        *temperature_celsius = s_temperature_celsius;
    }
    portEXIT_CRITICAL(&s_temperature_mux);
    return valid;
}

esp_err_t thermal_monitor_start_load_test(void) {
    portENTER_CRITICAL(&s_temperature_mux);
    if (s_load_test_running) {
        portEXIT_CRITICAL(&s_temperature_mux);
        return ESP_ERR_INVALID_STATE;
    }
    s_load_test_running = true;
    portEXIT_CRITICAL(&s_temperature_mux);

    if (xTaskCreate(bounded_cpu_load_task, "temp_load_test", 2048, NULL, 1, NULL) != pdPASS) {
        portENTER_CRITICAL(&s_temperature_mux);
        s_load_test_running = false;
        portEXIT_CRITICAL(&s_temperature_mux);
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGW(TAG, "Started bounded 10-second CPU load test; temperature readings remain live sensor measurements");
    return ESP_OK;
}

bool thermal_monitor_is_load_test_running(void) {
    portENTER_CRITICAL(&s_temperature_mux);
    bool running = s_load_test_running;
    portEXIT_CRITICAL(&s_temperature_mux);
    return running;
}
