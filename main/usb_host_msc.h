/*
 * USB Host MSC Driver Header
 */
#ifndef USB_HOST_MSC_H
#define USB_HOST_MSC_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#define USB_HOST_MSC_TEXT_MAX 64

typedef struct {
    uint16_t vendor_id;
    uint16_t product_id;
    uint32_t sector_size;
    uint32_t sector_count;
    uint64_t capacity_bytes;
    char manufacturer[USB_HOST_MSC_TEXT_MAX];
    char product[USB_HOST_MSC_TEXT_MAX];
    char serial_number[USB_HOST_MSC_TEXT_MAX];
} usb_host_msc_info_t;

#ifdef __cplusplus
extern "C" {
#endif

esp_err_t usb_host_msc_init(const char *mount_path);
bool usb_host_msc_is_mounted(void);
bool usb_host_msc_is_ready(void);
esp_err_t usb_host_msc_get_info(usb_host_msc_info_t *info);
esp_err_t usb_host_msc_get_capacity(uint64_t *device_total_bytes,
                                    uint64_t *filesystem_total_bytes,
                                    uint64_t *filesystem_free_bytes);
esp_err_t usb_host_msc_prepare_shutdown(void);
void usb_host_msc_create_default_win11_dirs(void);

#ifdef __cplusplus
}
#endif

#endif // USB_HOST_MSC_H
