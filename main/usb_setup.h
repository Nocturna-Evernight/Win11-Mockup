/*
 * USB Setup Utility Header
 */

#ifndef USB_SETUP_H
#define USB_SETUP_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t usb_setup_create_default_dirs(void);
esp_err_t usb_setup_create_default_profile(void);
esp_err_t usb_setup_create_dns_config(void);
esp_err_t usb_setup_copy_web_assets(void);
esp_err_t usb_setup_init_all(void);

#ifdef __cplusplus
}
#endif

#endif // USB_SETUP_H