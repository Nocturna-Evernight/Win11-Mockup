#include "system_control.h"

#include <stdbool.h>

#include "dns_adblock.h"
#include "esp_log.h"
#include "esp_system.h"
#include "esp_wifi.h"
#include "ota_manager.h"
#include "status_indicator.h"
#include "usb_host_msc.h"
#include "win11_server.h"
#include "driver/gpio.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"

#ifndef CONFIG_APP_POWER_RESPONSE_DELAY_MS
#define CONFIG_APP_POWER_RESPONSE_DELAY_MS 800
#endif
#ifndef CONFIG_APP_BOOT_SHUTDOWN_ENABLED
#define CONFIG_APP_BOOT_SHUTDOWN_ENABLED 0
#endif
#ifndef CONFIG_APP_BOOT_BUTTON_GPIO
#define CONFIG_APP_BOOT_BUTTON_GPIO 0
#endif
#ifndef CONFIG_APP_BOOT_BUTTON_HOLD_MS
#define CONFIG_APP_BOOT_BUTTON_HOLD_MS 2500
#endif

#define TAG "SYSTEM_CONTROL"
#define BUTTON_POLL_INTERVAL_MS 50

typedef enum {
    POWER_ACTION_RESTART,
    POWER_ACTION_SHUTDOWN_PREPARATION,
} power_action_t;

static volatile bool s_preparing;
static bool s_initialized;
static portMUX_TYPE s_state_mux = portMUX_INITIALIZER_UNLOCKED;

static bool ota_is_active(void) {
    ota_status_t status;
    ota_manager_get_status(&status);
    return status.state == OTA_STATE_READING ||
           status.state == OTA_STATE_WRITING ||
           status.state == OTA_STATE_VERIFYING;
}

static void power_action_failed(const char *stage, esp_err_t err) {
    ESP_LOGE(TAG, "%s failed: %s; device remains powered", stage, esp_err_to_name(err));
    status_indicator_set_mode(STATUS_INDICATOR_ERROR, 100);
    portENTER_CRITICAL(&s_state_mux);
    s_preparing = false;
    portEXIT_CRITICAL(&s_state_mux);
}

static void power_action_task(void *arg) {
    power_action_t action = (power_action_t)(uintptr_t)arg;
    vTaskDelay(pdMS_TO_TICKS(CONFIG_APP_POWER_RESPONSE_DELAY_MS));

    status_indicator_set_mode(STATUS_INDICATOR_POWER_PREPARING, 100);
    esp_err_t dns_err = dns_adblock_stop();
    if (dns_err != ESP_OK && dns_err != ESP_ERR_INVALID_STATE) {
        power_action_failed("DNS service stop", dns_err);
        vTaskDelete(NULL);
        return;
    }

    esp_err_t err = win11_server_stop();
    if (err != ESP_OK) {
        power_action_failed("Web server stop", err);
        vTaskDelete(NULL);
        return;
    }

    err = esp_wifi_stop();
    if (err != ESP_OK && err != ESP_ERR_WIFI_NOT_INIT && err != ESP_ERR_WIFI_NOT_STARTED) {
        power_action_failed("Wi-Fi stop", err);
        vTaskDelete(NULL);
        return;
    }

    err = usb_host_msc_prepare_shutdown();
    if (err != ESP_OK) {
        power_action_failed("USB storage unmount", err);
        vTaskDelete(NULL);
        return;
    }

    if (action == POWER_ACTION_RESTART) {
        vTaskDelay(pdMS_TO_TICKS(100));
        esp_restart();
    }

    status_indicator_set_mode(STATUS_INDICATOR_POWER_READY, 100);
    for (;;) {
        vTaskDelay(portMAX_DELAY);
    }
}

static esp_err_t request_power_action(power_action_t action) {
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    if (ota_is_active()) return ESP_ERR_INVALID_STATE;

    portENTER_CRITICAL(&s_state_mux);
    if (s_preparing) {
        portEXIT_CRITICAL(&s_state_mux);
        return ESP_ERR_INVALID_STATE;
    }
    s_preparing = true;
    portEXIT_CRITICAL(&s_state_mux);

    status_indicator_set_mode(STATUS_INDICATOR_POWER_PREPARING, 100);
    BaseType_t result = xTaskCreate(power_action_task, "power_prepare", 6144,
                                    (void *)(uintptr_t)action, 5, NULL);
    if (result != pdPASS) {
        portENTER_CRITICAL(&s_state_mux);
        s_preparing = false;
        portEXIT_CRITICAL(&s_state_mux);
        status_indicator_set_mode(STATUS_INDICATOR_ERROR, 100);
        return ESP_ERR_NO_MEM;
    }
    return ESP_OK;
}

#if CONFIG_APP_BOOT_SHUTDOWN_ENABLED
static void boot_button_task(void *arg) {
    (void)arg;
    const gpio_config_t config = {
        .pin_bit_mask = 1ULL << CONFIG_APP_BOOT_BUTTON_GPIO,
        .mode = GPIO_MODE_INPUT,
        .pull_up_en = GPIO_PULLUP_ENABLE,
        .pull_down_en = GPIO_PULLDOWN_DISABLE,
        .intr_type = GPIO_INTR_DISABLE,
    };
    esp_err_t err = gpio_config(&config);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "BOOT button GPIO configuration failed: %s", esp_err_to_name(err));
        vTaskDelete(NULL);
        return;
    }

    bool pressed = false;
    bool triggered = false;
    TickType_t pressed_at = 0;
    for (;;) {
        bool is_pressed = gpio_get_level(CONFIG_APP_BOOT_BUTTON_GPIO) == 0;
        if (!is_pressed) {
            pressed = false;
            triggered = false;
        } else if (!pressed) {
            pressed = true;
            pressed_at = xTaskGetTickCount();
        } else if (!triggered &&
                   (xTaskGetTickCount() - pressed_at) >= pdMS_TO_TICKS(CONFIG_APP_BOOT_BUTTON_HOLD_MS)) {
            triggered = true;
            ESP_LOGI(TAG, "BOOT button held; requesting orderly shutdown preparation.");
            esp_err_t request_err = system_control_request_shutdown_preparation();
            if (request_err != ESP_OK) {
                ESP_LOGE(TAG, "BOOT-button shutdown preparation request failed: %s",
                         esp_err_to_name(request_err));
                status_indicator_set_mode(STATUS_INDICATOR_ERROR, 100);
            }
        }
        vTaskDelay(pdMS_TO_TICKS(BUTTON_POLL_INTERVAL_MS));
    }
}
#endif

esp_err_t system_control_init(void) {
    if (s_initialized) return ESP_OK;
    s_initialized = true;
#if CONFIG_APP_BOOT_SHUTDOWN_ENABLED
    if (xTaskCreate(boot_button_task, "boot_button", 3072, NULL, 3, NULL) != pdPASS) {
        s_initialized = false;
        return ESP_ERR_NO_MEM;
    }
#endif
    return ESP_OK;
}

esp_err_t system_control_request_restart(void) {
    return request_power_action(POWER_ACTION_RESTART);
}

esp_err_t system_control_request_shutdown_preparation(void) {
    return request_power_action(POWER_ACTION_SHUTDOWN_PREPARATION);
}
