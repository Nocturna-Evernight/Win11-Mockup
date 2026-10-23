#ifndef USB_STORAGE_MAP_H
#define USB_STORAGE_MAP_H

#include <stdbool.h>

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include "esp_err.h"

#define MAP_PATH_MAX 256

esp_err_t usb_storage_map_init(void);
esp_err_t usb_storage_map_migrate(const char *device_id);
esp_err_t usb_storage_map_resolve(const char *logical_path, char *physical_path, size_t path_size);
esp_err_t usb_storage_map_get_logical(const char *physical_path, char *logical_path, size_t path_size,
                                      bool *is_directory);
esp_err_t usb_storage_map_mkdir(const char *logical_path);
esp_err_t usb_storage_map_create_file(const char *logical_path, const char *name, char *physical_path,
                                      size_t path_size);
esp_err_t usb_storage_map_delete(const char *logical_path);

#endif
