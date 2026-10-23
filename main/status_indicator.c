#include "status_indicator.h"

#include "driver/rmt_encoder.h"
#include "driver/rmt_tx.h"
#include "esp_log.h"
#include "esp_rom_sys.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#ifndef CONFIG_APP_STATUS_LED_GPIO
#define CONFIG_APP_STATUS_LED_GPIO 48
#endif
#ifndef CONFIG_APP_STATUS_LED_ENABLED
#define CONFIG_APP_STATUS_LED_ENABLED 0
#endif
#ifndef CONFIG_APP_STATUS_LED_BRIGHTNESS
#define CONFIG_APP_STATUS_LED_BRIGHTNESS 20
#endif

static const char *TAG = "STATUS_LED";
static rmt_channel_handle_t s_channel;
static rmt_encoder_handle_t s_encoder;
static SemaphoreHandle_t s_mutex;
static status_indicator_mode_t s_mode = STATUS_INDICATOR_NORMAL;

static void transmit_rgb(uint8_t red, uint8_t green, uint8_t blue) {
    if (!s_channel || !s_encoder || !s_mutex ||
        xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return;

    uint8_t pixel[3] = {
        (uint8_t)(((uint16_t)green * CONFIG_APP_STATUS_LED_BRIGHTNESS) / 100),
        (uint8_t)(((uint16_t)red * CONFIG_APP_STATUS_LED_BRIGHTNESS) / 100),
        (uint8_t)(((uint16_t)blue * CONFIG_APP_STATUS_LED_BRIGHTNESS) / 100),
    };
    const rmt_transmit_config_t transmit_config = {
        .loop_count = 0,
        .flags.eot_level = 0,
    };
    if (rmt_transmit(s_channel, s_encoder, pixel, sizeof(pixel), &transmit_config) == ESP_OK &&
        rmt_tx_wait_all_done(s_channel, 100) == ESP_OK) {
        esp_rom_delay_us(80);
    }
    xSemaphoreGive(s_mutex);
}

esp_err_t status_indicator_init(void) {
    if (!CONFIG_APP_STATUS_LED_ENABLED) return ESP_ERR_NOT_SUPPORTED;
    if (s_channel != NULL) return ESP_OK;

    const rmt_tx_channel_config_t channel_config = {
        .gpio_num = CONFIG_APP_STATUS_LED_GPIO,
        .clk_src = RMT_CLK_SRC_DEFAULT,
        .resolution_hz = 10000000,
        .mem_block_symbols = 64,
        .trans_queue_depth = 1,
        .flags.with_dma = false,
        .flags.invert_out = false,
        .flags.init_level = false,
    };
    esp_err_t err = rmt_new_tx_channel(&channel_config, &s_channel);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "RGB LED unavailable on GPIO%d: %s", CONFIG_APP_STATUS_LED_GPIO, esp_err_to_name(err));
        s_channel = NULL;
        return err;
    }

    const rmt_bytes_encoder_config_t encoder_config = {
        .bit0 = {.duration0 = 4, .level0 = 1, .duration1 = 8, .level1 = 0},
        .bit1 = {.duration0 = 8, .level0 = 1, .duration1 = 4, .level1 = 0},
        .flags.msb_first = 1,
    };
    err = rmt_new_bytes_encoder(&encoder_config, &s_encoder);
    if (err == ESP_OK) err = rmt_enable(s_channel);
    if (err != ESP_OK) {
        ESP_LOGW(TAG, "RGB LED encoder unavailable: %s", esp_err_to_name(err));
        if (s_encoder) rmt_del_encoder(s_encoder);
        rmt_del_channel(s_channel);
        s_encoder = NULL;
        s_channel = NULL;
        return err;
    }

    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) {
        rmt_disable(s_channel);
        rmt_del_encoder(s_encoder);
        rmt_del_channel(s_channel);
        s_encoder = NULL;
        s_channel = NULL;
        return ESP_ERR_NO_MEM;
    }
    ESP_LOGI(TAG, "WS2812 status LED initialized on GPIO%d", CONFIG_APP_STATUS_LED_GPIO);
    return ESP_OK;
}

void status_indicator_set_rgb(uint8_t red, uint8_t green, uint8_t blue) {
    if (s_mode == STATUS_INDICATOR_NORMAL) {
        transmit_rgb(red, green, blue);
    }
}

void status_indicator_set_mode(status_indicator_mode_t mode, uint8_t progress_percent) {
    static const uint8_t colors[][3] = {
        [STATUS_INDICATOR_NORMAL] = {0, 0, 0},
        [STATUS_INDICATOR_OTA_READING] = {0, 64, 255},
        [STATUS_INDICATOR_OTA_WRITING] = {0, 180, 255},
        [STATUS_INDICATOR_OTA_VERIFYING] = {255, 100, 0},
        [STATUS_INDICATOR_OTA_PENDING_REBOOT] = {32, 64, 255},
        [STATUS_INDICATOR_ERROR] = {255, 0, 0},
        [STATUS_INDICATOR_POWER_PREPARING] = {255, 48, 0},
        [STATUS_INDICATOR_POWER_READY] = {180, 0, 255},
    };
    if (mode < STATUS_INDICATOR_NORMAL || mode > STATUS_INDICATOR_POWER_READY) return;
    s_mode = mode;
    if (mode == STATUS_INDICATOR_NORMAL) {
        transmit_rgb(0, 0, 0);
        return;
    }

    uint8_t brightness = progress_percent < 20 ? 20 : progress_percent;
    if (brightness > 100) brightness = 100;
    transmit_rgb((uint8_t)((colors[mode][0] * brightness) / 100),
                 (uint8_t)((colors[mode][1] * brightness) / 100),
                 (uint8_t)((colors[mode][2] * brightness) / 100));
}