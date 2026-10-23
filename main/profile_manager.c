/*
 * Profile Manager Implementation
 * Per-profile setups, compartmentalization, and USB-based storage
 */

#include "profile_manager.h"
#include <dirent.h>
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <sys/stat.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"
#include "cJSON.h"
#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "auth_uac.h"

static const char *TAG = "PROFILE_MGR";

#define PROFILES_BASE_DIR "/usb/profiles"
#define CURRENT_PROFILE_FILE "/usb/system/current_profile.txt"

static SemaphoreHandle_t s_mutex = NULL;
static bool s_initialized = false;
static char s_active_profile[MAX_PROFILE_NAME_LEN] = "Default";

static bool valid_profile_name(const char *name) {
    if (!name || !name[0] || strlen(name) >= MAX_PROFILE_NAME_LEN) return false;
    for (const char *p = name; *p; p++) {
        if (!((*p >= 'a' && *p <= 'z') || (*p >= 'A' && *p <= 'Z') ||
              (*p >= '0' && *p <= '9') || *p == '_' || *p == '-')) return false;
    }
    return true;
}

static void load_default_settings(profile_settings_t *settings, const char *profile_name) {
    memset(settings, 0, sizeof(profile_settings_t));
    strcpy(settings->profile_name, profile_name);
    strcpy(settings->theme, "light");
    settings->dark_mode = false;
    settings->wallpaper_mode = 0;
    settings->screen_resolution = 1080;
    settings->taskbar_locked = false;
    settings->show_desktop_icons = true;
    settings->transparency_enabled = true;
    settings->sound_volume = 80;
    settings->notifications_enabled = true;
}

esp_err_t profile_manager_init(void) {
    if (s_initialized) return ESP_OK;
    if (!s_mutex) s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) return ESP_ERR_NO_MEM;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;

    // Ensure profiles directory exists
    usb_storage_map_mkdir("/usb/profiles");
    usb_storage_map_mkdir("/usb/system");
    usb_storage_map_mkdir("/usb/assets");
    usb_storage_map_mkdir("/usb/wallpaper");
    
    // Create default profile
    if (!profile_manager_profile_exists("Default")) {
        profile_manager_create_profile("Default", "Default User", false);
    }
    
    // Load current profile
    char physical_path[256];
    esp_err_t err = usb_storage_map_resolve(CURRENT_PROFILE_FILE, physical_path, sizeof(physical_path));
    if (err == ESP_OK) {
        FILE *f = fopen(physical_path, "r");
        if (f) {
            if (fgets(s_active_profile, sizeof(s_active_profile), f) == NULL) {
                strlcpy(s_active_profile, "Default", sizeof(s_active_profile));
            }
            s_active_profile[strcspn(s_active_profile, "\n\r")] = 0;
            fclose(f);
        }
    } else if (usb_storage_map_create_file("/usb/system", "current_profile.txt",
                                           physical_path, sizeof(physical_path)) == ESP_OK) {
        FILE *f = fopen(physical_path, "w");
        if (f) {
            fputs("Default", f);
            fclose(f);
        }
    }
    if (!valid_profile_name(s_active_profile) || !profile_manager_profile_exists(s_active_profile)) {
        strlcpy(s_active_profile, "Default", sizeof(s_active_profile));
    }
    s_initialized = true;
    ESP_LOGI(TAG, "Profile manager initialized");
    return ESP_OK;
}

bool profile_manager_profile_exists(const char *name) {
    if (!valid_profile_name(name) || !usb_host_msc_is_mounted()) return false;
    
    char logical_path[128];
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s", name);
    char physical_path[256];
    esp_err_t err = usb_storage_map_resolve(logical_path, physical_path, sizeof(physical_path));
    return err == ESP_OK;
}

esp_err_t profile_manager_create_profile(const char *name, const char *display_name, bool is_admin) {
    if (!valid_profile_name(name) || !display_name || !display_name[0] ||
        strlen(display_name) >= MAX_DISPLAY_NAME_LEN) return ESP_ERR_INVALID_ARG;
    if (profile_manager_profile_exists(name)) return ESP_ERR_INVALID_STATE;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    
    char logical_path[128];
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s", name);
    usb_storage_map_mkdir(logical_path);
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s/wallpaper", name);
    usb_storage_map_mkdir(logical_path);
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s/assets", name);
    usb_storage_map_mkdir(logical_path);
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s/settings", name);
    usb_storage_map_mkdir(logical_path);
    
    // Save profile info
    char profile_path[128];
    snprintf(profile_path, sizeof(profile_path), "/usb/profiles/%s", name);
    char physical_path[256];
    esp_err_t err = usb_storage_map_create_file(profile_path, "info.json", physical_path, sizeof(physical_path));
    if (err != ESP_OK) return err;
    FILE *f = fopen(physical_path, "w");
    if (!f) return ESP_FAIL;
    cJSON *root = cJSON_CreateObject();
    if (!root) { fclose(f); return ESP_ERR_NO_MEM; }
    cJSON_AddStringToObject(root, "name", name);
    cJSON_AddStringToObject(root, "display_name", display_name);
    cJSON_AddBoolToObject(root, "is_admin", is_admin);
    cJSON_AddNumberToObject(root, "created_time", (double)esp_timer_get_time() / 1000000.0);
    cJSON_AddNumberToObject(root, "last_used_time", (double)esp_timer_get_time() / 1000000.0);
    char *json = cJSON_PrintUnformatted(root);
    bool saved = json && fputs(json, f) >= 0 && fclose(f) == 0;
    if (json) cJSON_free(json);
    cJSON_Delete(root);
    if (!saved) return ESP_FAIL;
    
    // Save default settings
    profile_settings_t settings;
    load_default_settings(&settings, name);
    err = profile_manager_save_settings(name, &settings);
    if (err != ESP_OK) return err;
    
    ESP_LOGI(TAG, "Profile created: %s", name);
    return ESP_OK;
}

esp_err_t profile_manager_switch_profile(const char *name) {
    if (!name) return ESP_ERR_INVALID_ARG;
    if (!profile_manager_profile_exists(name)) return ESP_ERR_INVALID_STATE;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        strcpy(s_active_profile, name);
        xSemaphoreGive(s_mutex);
    }
    
    // Save current profile
    char physical_path[256];
    usb_storage_map_resolve(CURRENT_PROFILE_FILE, physical_path, sizeof(physical_path));
    FILE *f = fopen(physical_path, "w");
    if (f) {
        fprintf(f, "%s", name);
        fclose(f);
    }
    
    // Update last used time
    char info_path[128];
    snprintf(info_path, sizeof(info_path), "/usb/profiles/%s/info.json", name);
    esp_err_t err = usb_storage_map_resolve(info_path, physical_path, sizeof(physical_path));
    if (err == ESP_OK) {
        FILE *info_f = fopen(physical_path, "r");
        if (info_f) {
            fseek(info_f, 0, SEEK_END);
            long size = ftell(info_f);
            char *buf = malloc(size + 1);
            if (buf) {
                fseek(info_f, 0, SEEK_SET);
                fread(buf, 1, size, info_f);
                buf[size] = '\0';
                cJSON *root = cJSON_Parse(buf);
                if (root) {
                    cJSON_ReplaceItemInObject(root, "last_used_time", cJSON_CreateNumber(esp_timer_get_time() / 1000000));
                    char *out = cJSON_PrintUnformatted(root);
                    if (out) {
                        fclose(info_f);
                        info_f = fopen(physical_path, "w");
                        if (info_f) {
                            fprintf(info_f, "%s", out);
                            fclose(info_f);
                        }
                        cJSON_free(out);
                    }
                    cJSON_Delete(root);
                } else {
                    fclose(info_f);
                }
                free(buf);
            } else {
                fclose(info_f);
            }
        }
    }
    
    ESP_LOGI(TAG, "Switched to profile: %s", name);
    return ESP_OK;
}

esp_err_t profile_manager_get_active_profile(char *name, size_t name_size) {
    if (!name || name_size == 0) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        strlcpy(name, s_active_profile, name_size);
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

esp_err_t profile_manager_save_settings(const char *profile_name, const profile_settings_t *settings) {
    if (!valid_profile_name(profile_name) || !settings) return ESP_ERR_INVALID_ARG;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    
    char logical_path[128];
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s/settings/settings.json", profile_name);
    char physical_path[256];
    char parent[128];
    snprintf(parent, sizeof(parent), "/usb/profiles/%s/settings", profile_name);
    esp_err_t err = usb_storage_map_create_file(parent, "settings.json", physical_path, sizeof(physical_path));
    if (err == ESP_ERR_INVALID_STATE) {
        err = usb_storage_map_resolve(logical_path, physical_path, sizeof(physical_path));
    }
    if (err != ESP_OK) return err;
    
    FILE *f = fopen(physical_path, "w");
    if (!f) return ESP_FAIL;
    
    fprintf(f, "{\n");
    fprintf(f, "  \"profile_name\": \"%s\",\n", settings->profile_name);
    fprintf(f, "  \"theme\": \"%s\",\n", settings->theme);
    fprintf(f, "  \"dark_mode\": %s,\n", settings->dark_mode ? "true" : "false");
    fprintf(f, "  \"wallpaper_mode\": %d,\n", settings->wallpaper_mode);
    fprintf(f, "  \"screen_resolution\": %d,\n", settings->screen_resolution);
    fprintf(f, "  \"taskbar_locked\": %s,\n", settings->taskbar_locked ? "true" : "false");
    fprintf(f, "  \"show_desktop_icons\": %s,\n", settings->show_desktop_icons ? "true" : "false");
    fprintf(f, "  \"transparency_enabled\": %s,\n", settings->transparency_enabled ? "true" : "false");
    fprintf(f, "  \"sound_volume\": %d,\n", settings->sound_volume);
    fprintf(f, "  \"notifications_enabled\": %s\n", settings->notifications_enabled ? "true" : "false");
    fprintf(f, "}\n");
    
    return fclose(f) == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t profile_manager_load_settings(const char *profile_name, profile_settings_t *settings) {
    if (!valid_profile_name(profile_name) || !settings) return ESP_ERR_INVALID_ARG;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    
    char logical_path[128];
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s/settings.json", profile_name);
    char physical_path[256];
    esp_err_t err = usb_storage_map_resolve(logical_path, physical_path, sizeof(physical_path));
    if (err != ESP_OK) {
        load_default_settings(settings, profile_name);
        return ESP_OK;
    }
    
    FILE *f = fopen(physical_path, "r");
    if (!f) {
        load_default_settings(settings, profile_name);
        return ESP_OK;
    }
    
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    char *buf = malloc(size + 1);
    if (!buf) {
        fclose(f);
        return ESP_ERR_NO_MEM;
    }
    fseek(f, 0, SEEK_SET);
    fread(buf, 1, size, f);
    buf[size] = '\0';
    fclose(f);
    
    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        free(buf);
        load_default_settings(settings, profile_name);
        return ESP_OK;
    }
    
    load_default_settings(settings, profile_name);
    
    cJSON *item = cJSON_GetObjectItem(root, "dark_mode");
    if (cJSON_IsBool(item)) settings->dark_mode = cJSON_IsTrue(item);
    
    item = cJSON_GetObjectItem(root, "sound_volume");
    if (cJSON_IsNumber(item)) settings->sound_volume = item->valueint;
    
    item = cJSON_GetObjectItem(root, "theme");
    if (cJSON_IsString(item)) strlcpy(settings->theme, item->valuestring, sizeof(settings->theme));

    item = cJSON_GetObjectItem(root, "wallpaper_mode");
    if (cJSON_IsNumber(item)) settings->wallpaper_mode = item->valueint;
    item = cJSON_GetObjectItem(root, "screen_resolution");
    if (cJSON_IsNumber(item)) settings->screen_resolution = item->valueint;
    item = cJSON_GetObjectItem(root, "taskbar_locked");
    if (cJSON_IsBool(item)) settings->taskbar_locked = cJSON_IsTrue(item);
    item = cJSON_GetObjectItem(root, "show_desktop_icons");
    if (cJSON_IsBool(item)) settings->show_desktop_icons = cJSON_IsTrue(item);
    item = cJSON_GetObjectItem(root, "transparency_enabled");
    if (cJSON_IsBool(item)) settings->transparency_enabled = cJSON_IsTrue(item);
    item = cJSON_GetObjectItem(root, "notifications_enabled");
    if (cJSON_IsBool(item)) settings->notifications_enabled = cJSON_IsTrue(item);
    
    cJSON_Delete(root);
    free(buf);
    return ESP_OK;
}

esp_err_t profile_manager_save_current_settings(void) {
    char name[MAX_PROFILE_NAME_LEN];
    profile_manager_get_active_profile(name, sizeof(name));
    profile_settings_t settings;
    profile_manager_load_settings(name, &settings);
    return profile_manager_save_settings(name, &settings);
}

esp_err_t profile_manager_save_wallpaper(const char *profile_name, const uint8_t *data, size_t data_len, const char *format) {
    if (!valid_profile_name(profile_name) || !data || !data_len || !format ||
        (strcmp(format, "jpg") != 0 && strcmp(format, "png") != 0 && strcmp(format, "webp") != 0)) return ESP_ERR_INVALID_ARG;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    
    char filename[64];
    snprintf(filename, sizeof(filename), "wallpaper.%s", format);
    static const char *other_formats[] = {"jpg", "png", "webp"};
    for (size_t i = 0; i < sizeof(other_formats) / sizeof(other_formats[0]); i++) {
        if (strcmp(format, other_formats[i]) == 0) continue;
        char old_logical[128], old_physical[256];
        snprintf(old_logical, sizeof(old_logical), "/usb/profiles/%s/wallpaper/wallpaper.%s",
                 profile_name, other_formats[i]);
        if (usb_storage_map_resolve(old_logical, old_physical, sizeof(old_physical)) == ESP_OK) {
            usb_storage_map_delete(old_logical);
        }
    }
    char logical_path[128];
    snprintf(logical_path, sizeof(logical_path), "/usb/profiles/%s/wallpaper/%s", profile_name, filename);
    char physical_path[256];
    esp_err_t err = usb_storage_map_resolve(logical_path, physical_path, sizeof(physical_path));
    if (err != ESP_OK) {
        char parent[128];
        snprintf(parent, sizeof(parent), "/usb/profiles/%s/wallpaper", profile_name);
        err = usb_storage_map_create_file(parent, filename, physical_path, sizeof(physical_path));
        if (err != ESP_OK) return err;
    }
    
    FILE *f = fopen(physical_path, "wb");
    if (!f) return ESP_FAIL;
    bool saved = fwrite(data, 1, data_len, f) == data_len;
    return fclose(f) == 0 && saved ? ESP_OK : ESP_FAIL;
}

esp_err_t profile_manager_get_wallpaper_path(const char *profile_name, char *path, size_t path_size) {
    if (!profile_name || !path || path_size == 0) return ESP_ERR_INVALID_ARG;
    snprintf(path, path_size, "/api/profiles/%s/wallpaper/wallpaper.jpg", profile_name);
    return ESP_OK;
}

esp_err_t profile_manager_list_profiles(profile_info_t *profiles, size_t max_profiles, size_t *count) {
    if (!profiles || !count) return ESP_ERR_INVALID_ARG;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    
    *count = 0;
    char profiles_path[256];
    if (usb_storage_map_resolve(PROFILES_BASE_DIR, profiles_path, sizeof(profiles_path)) != ESP_OK) return ESP_FAIL;
    DIR *dir = opendir(profiles_path);
    if (!dir) return ESP_FAIL;
    
    struct dirent *entry;
    while ((entry = readdir(dir)) != NULL && *count < max_profiles) {
        if (entry->d_name[0] == '.' || !valid_profile_name(entry->d_name)) continue;
        char info_path[320];
        snprintf(info_path, sizeof(info_path), "/usb/profiles/%s/info.json", entry->d_name);
        char physical_path[256];
        esp_err_t err = usb_storage_map_resolve(info_path, physical_path, sizeof(physical_path));
        if (err == ESP_OK) {
            FILE *f = fopen(physical_path, "r");
            if (f) {
                fseek(f, 0, SEEK_END);
                long size = ftell(f);
                char *buf = malloc(size + 1);
                if (buf) {
                    fseek(f, 0, SEEK_SET);
                    fread(buf, 1, size, f);
                    buf[size] = '\0';
                    cJSON *root = cJSON_Parse(buf);
                    if (root) {
                        memset(&profiles[*count], 0, sizeof(profiles[*count]));
                        strlcpy(profiles[*count].name, entry->d_name, MAX_PROFILE_NAME_LEN);
                        cJSON *item = cJSON_GetObjectItem(root, "display_name");
                        if (cJSON_IsString(item)) strlcpy(profiles[*count].display_name, item->valuestring, MAX_DISPLAY_NAME_LEN);
                        item = cJSON_GetObjectItem(root, "is_admin");
                        profiles[*count].is_admin = cJSON_IsTrue(item);
                        profiles[*count].is_default = strcmp(entry->d_name, "Default") == 0;
                        (*count)++;
                        cJSON_Delete(root);
                    }
                    free(buf);
                }
                fclose(f);
            }
        }
    }
    closedir(dir);
    return ESP_OK;
}

esp_err_t profile_manager_get_profile_info(const char *name, profile_info_t *info) {
    if (!valid_profile_name(name) || !info) return ESP_ERR_INVALID_ARG;
    char logical[128], physical[256];
    snprintf(logical, sizeof(logical), "/usb/profiles/%s/info.json", name);
    esp_err_t err = usb_storage_map_resolve(logical, physical, sizeof(physical));
    if (err != ESP_OK) return err;
    FILE *f = fopen(physical, "r");
    if (!f) return ESP_FAIL;
    char buffer[512];
    size_t length = fread(buffer, 1, sizeof(buffer) - 1, f);
    bool read_failed = ferror(f) != 0;
    fclose(f);
    if (read_failed) return ESP_FAIL;
    buffer[length] = '\0';
    cJSON *root = cJSON_Parse(buffer);
    if (!root) return ESP_ERR_INVALID_RESPONSE;
    memset(info, 0, sizeof(*info));
    strlcpy(info->name, name, sizeof(info->name));
    cJSON *item = cJSON_GetObjectItem(root, "display_name");
    if (cJSON_IsString(item)) strlcpy(info->display_name, item->valuestring, sizeof(info->display_name));
    item = cJSON_GetObjectItem(root, "is_admin");
    info->is_admin = cJSON_IsTrue(item);
    info->is_default = strcmp(name, "Default") == 0;
    item = cJSON_GetObjectItem(root, "created_time");
    if (cJSON_IsNumber(item)) info->created_time = (uint32_t)item->valuedouble;
    item = cJSON_GetObjectItem(root, "last_used_time");
    if (cJSON_IsNumber(item)) info->last_used_time = (uint32_t)item->valuedouble;
    cJSON_Delete(root);
    return ESP_OK;
}

esp_err_t profile_manager_delete_profile(const char *name) {
    if (!valid_profile_name(name) || strcmp(name, "Default") == 0) return ESP_ERR_INVALID_ARG;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    if (strcmp(name, s_active_profile) == 0) return ESP_ERR_INVALID_STATE;
    char logical[128];
    snprintf(logical, sizeof(logical), "/usb/profiles/%s", name);
    return usb_storage_map_delete(logical);
}

esp_err_t profile_manager_set_default_profile(const char *name) {
    if (!valid_profile_name(name) || !profile_manager_profile_exists(name)) return ESP_ERR_INVALID_ARG;
    char physical[256];
    esp_err_t err = usb_storage_map_resolve("/usb/system/default_profile.txt", physical, sizeof(physical));
    if (err != ESP_OK) err = usb_storage_map_create_file("/usb/system", "default_profile.txt", physical, sizeof(physical));
    if (err != ESP_OK) return err;
    FILE *f = fopen(physical, "w");
    if (!f) return ESP_FAIL;
    fputs(name, f);
    return fclose(f) == 0 ? ESP_OK : ESP_FAIL;
}

esp_err_t profile_manager_compartmentalize_storage(const char *profile_name, bool enable) {
    if (!valid_profile_name(profile_name)) return ESP_ERR_INVALID_ARG;
    if (!usb_host_msc_is_mounted()) return ESP_ERR_INVALID_STATE;
    char path[128], physical[256];
    snprintf(path, sizeof(path), "/usb/profiles/%s/storage_isolated.flag", profile_name);
    esp_err_t err = usb_storage_map_resolve(path, physical, sizeof(physical));
    if (!enable) return err == ESP_OK ? usb_storage_map_delete(path) : ESP_OK;
    char parent[128];
    snprintf(parent, sizeof(parent), "/usb/profiles/%s", profile_name);
    if (err != ESP_OK) err = usb_storage_map_create_file(parent, "storage_isolated.flag", physical, sizeof(physical));
    if (err != ESP_OK) return err;
    FILE *f = fopen(physical, "w");
    if (!f) return ESP_FAIL;
    fputs("1", f);
    return fclose(f) == 0 ? ESP_OK : ESP_FAIL;
}

bool profile_manager_is_storage_compartmentalized(const char *profile_name) {
    if (!valid_profile_name(profile_name) || !usb_host_msc_is_mounted()) return false;
    char logical[128], physical[256];
    snprintf(logical, sizeof(logical), "/usb/profiles/%s/storage_isolated.flag", profile_name);
    return usb_storage_map_resolve(logical, physical, sizeof(physical)) == ESP_OK;
}

esp_err_t profile_manager_export_profile(const char *profile_name, const char *export_path) {
    return ESP_OK;
}

esp_err_t profile_manager_import_profile(const char *import_path) {
    return ESP_OK;
}

const char *profile_manager_get_profiles_dir(void) {
    return PROFILES_BASE_DIR;
}

esp_err_t profile_manager_deinit(void) {
    if (s_mutex) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    s_initialized = false;
    return ESP_OK;
}