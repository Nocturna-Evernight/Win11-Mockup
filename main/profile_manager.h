/*
 * Profile Manager for Per-Profile Setups and Compartmentalization
 * Stores each profile's settings, wallpaper, apps, preferences on USB flash drive
 */

#ifndef PROFILE_MANAGER_H
#define PROFILE_MANAGER_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define MAX_PROFILES                16
#define MAX_PROFILE_NAME_LEN        32
#define MAX_DISPLAY_NAME_LEN        64
#define MAX_WALLPAPER_PATH_LEN      128
#define MAX_APP_COUNT               32
#define MAX_APP_NAME_LEN            32

typedef struct {
    char name[MAX_PROFILE_NAME_LEN];
    char display_name[MAX_DISPLAY_NAME_LEN];
    char wallpaper_path[MAX_WALLPAPER_PATH_LEN];
    bool is_admin;
    bool is_default;
    uint32_t created_time;
    uint32_t last_used_time;
} profile_info_t;

typedef struct {
    char profile_name[MAX_PROFILE_NAME_LEN];
    char theme[16];
    bool dark_mode;
    int wallpaper_mode;
    int screen_resolution;
    bool taskbar_locked;
    bool show_desktop_icons;
    bool transparency_enabled;
    int sound_volume;
    bool notifications_enabled;
} profile_settings_t;

typedef struct {
    char profile_name[MAX_PROFILE_NAME_LEN];
    char app_names[MAX_APP_COUNT][MAX_APP_NAME_LEN];
    int app_count;
    bool isolated_storage;
} profile_apps_t;

esp_err_t profile_manager_init(void);
esp_err_t profile_manager_deinit(void);

esp_err_t profile_manager_create_profile(const char *name, const char *display_name, bool is_admin);
esp_err_t profile_manager_delete_profile(const char *name);
esp_err_t profile_manager_switch_profile(const char *name);
esp_err_t profile_manager_get_active_profile(char *name, size_t name_size);
esp_err_t profile_manager_get_profile_info(const char *name, profile_info_t *info);
esp_err_t profile_manager_list_profiles(profile_info_t *profiles, size_t max_profiles, size_t *count);
esp_err_t profile_manager_set_default_profile(const char *name);

esp_err_t profile_manager_save_settings(const char *profile_name, const profile_settings_t *settings);
esp_err_t profile_manager_load_settings(const char *profile_name, profile_settings_t *settings);
esp_err_t profile_manager_save_current_settings(void);
esp_err_t profile_manager_load_current_settings(void);

esp_err_t profile_manager_save_wallpaper(const char *profile_name, const uint8_t *data, size_t data_len, const char *format);
esp_err_t profile_manager_get_wallpaper_path(const char *profile_name, char *path, size_t path_size);

esp_err_t profile_manager_compartmentalize_storage(const char *profile_name, bool enable);
bool profile_manager_is_storage_compartmentalized(const char *profile_name);

esp_err_t profile_manager_export_profile(const char *profile_name, const char *export_path);
esp_err_t profile_manager_import_profile(const char *import_path);

bool profile_manager_profile_exists(const char *name);

const char *profile_manager_get_profiles_dir(void);

#ifdef __cplusplus
}
#endif

#endif // PROFILE_MANAGER_H