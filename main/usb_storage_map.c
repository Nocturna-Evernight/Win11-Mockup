#include "usb_storage_map.h"

#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#include "esp_log.h"
#include "esp_random.h"
#include "esp_system.h"
#include "nvs.h"
#include "nvs_flash.h"
#include "esp_littlefs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/semphr.h"

#define USB_ROOT "/usb"
#define MAP_MOUNT "/storage"
#define LEGACY_MAP_FILE MAP_MOUNT "/usb_names.bin"
#define MAP_RECORD_MAGIC 0x554D4150U
#define MAP_MAX_DEPTH 16

static const char *TAG = "USB_NAME_MAP";
static bool s_map_ready;
static uint32_t s_next_sequence = 1;
static char s_map_file[40] = LEGACY_MAP_FILE;
static SemaphoreHandle_t s_map_mutex = NULL;

#define MAP_FILE s_map_file

typedef struct {
    uint32_t magic;
    uint32_t sequence;
    uint8_t is_directory;
    char logical[MAP_PATH_MAX];
    char physical[MAP_PATH_MAX];
} map_record_t;

static bool normalize_path(const char *path, char *relative, size_t size) {
    if (path == NULL || relative == NULL || size == 0) return false;
    const char *value = path;
    if (strncmp(value, USB_ROOT, sizeof(USB_ROOT) - 1) == 0 &&
        (value[sizeof(USB_ROOT) - 1] == '\0' || value[sizeof(USB_ROOT) - 1] == '/')) {
        value += sizeof(USB_ROOT) - 1;
    } else if (*value == '/') {
        value++;
    }

    size_t out = 0;
    const char *segment = value;
    for (const char *p = value;; p++) {
        if (*p == '\\' || *p == '%' || (*p != '\0' && (unsigned char)*p < 0x20)) return false;
        if (*p == '/' || *p == '\0') {
            size_t length = (size_t)(p - segment);
            if ((length == 1 && segment[0] == '.') ||
                (length == 2 && segment[0] == '.' && segment[1] == '.') ||
                length >= MAP_PATH_MAX) return false;
            if (length > 0) {
                if (out != 0) {
                    if (out + 1 >= size) return false;
                    relative[out++] = '/';
                }
                if (out + length >= size) return false;
                memcpy(relative + out, segment, length);
                out += length;
            }
            if (*p == '\0') break;
            segment = p + 1;
        }
    }
    relative[out] = '\0';
    return true;
}

static bool read_record(FILE *file, map_record_t *record) {
    size_t count = fread(record, sizeof(*record), 1, file);
    if (count != 1) return false;
    return record->magic == MAP_RECORD_MAGIC &&
        memchr(record->logical, '\0', sizeof(record->logical)) != NULL &&
        memchr(record->physical, '\0', sizeof(record->physical)) != NULL;
}

static bool read_record_fd(int fd, map_record_t *record) {
    uint8_t *buffer = (uint8_t *)record;
    size_t remaining = sizeof(*record);
    while (remaining > 0) {
        ssize_t count = read(fd, buffer, remaining);
        if (count <= 0) return false;
        buffer += count;
        remaining -= (size_t)count;
    }
    return record->magic == MAP_RECORD_MAGIC &&
        memchr(record->logical, '\0', sizeof(record->logical)) != NULL &&
        memchr(record->physical, '\0', sizeof(record->physical)) != NULL;
}

static esp_err_t find_record(const char *key, bool by_physical, map_record_t *found, bool *exists) {
    if (!s_map_mutex || xSemaphoreTake(s_map_mutex, pdMS_TO_TICKS(500)) != pdTRUE) return ESP_ERR_TIMEOUT;
    int fd = open(MAP_FILE, O_RDONLY);
    if (fd < 0) {
        xSemaphoreGive(s_map_mutex);
        return ESP_ERR_NOT_FOUND;
    }
    *exists = false;
    if (by_physical) {
        const char *base_name = strrchr(key, '/');
        base_name = base_name ? base_name + 1 : key;
        size_t name_length = strlen(base_name);
        uint32_t sequence = 0;
        if ((name_length != 9 && name_length != 17) ||
            (base_name[0] != 'D' && base_name[0] != 'F')) {
            close(fd);
            xSemaphoreGive(s_map_mutex);
            return ESP_OK;
        }
        for (size_t i = name_length - 8; i < name_length; i++) {
            char c = base_name[i];
            uint32_t digit;
            if (c >= '0' && c <= '9') digit = (uint32_t)(c - '0');
            else if (c >= 'A' && c <= 'F') digit = (uint32_t)(c - 'A' + 10);
            else if (c >= 'a' && c <= 'f') digit = (uint32_t)(c - 'a' + 10);
            else {
                close(fd);
                xSemaphoreGive(s_map_mutex);
                return ESP_OK;
            }
            sequence = (sequence << 4) | digit;
        }
        if (sequence == 0 || sequence >= s_next_sequence) {
            close(fd);
            xSemaphoreGive(s_map_mutex);
            return ESP_OK;
        }
        map_record_t record;
        for (uint32_t current_sequence = 1; current_sequence <= sequence; current_sequence++) {
            if (!read_record_fd(fd, &record) || record.sequence != current_sequence) {
                close(fd);
                xSemaphoreGive(s_map_mutex);
                return ESP_ERR_INVALID_CRC;
            }
        }
        *found = record;
        *exists = found->sequence == sequence && strcmp(found->physical, key) == 0;
        close(fd);
        xSemaphoreGive(s_map_mutex);
        return ESP_OK;
    }
    map_record_t record;
    for (uint32_t sequence = 1; sequence < s_next_sequence; sequence++) {
        if (!read_record_fd(fd, &record) || record.sequence != sequence) {
            close(fd);
            xSemaphoreGive(s_map_mutex);
            return ESP_ERR_INVALID_CRC;
        }
        if (strcmp(record.logical, key) == 0) {
            *found = record;
            *exists = record.is_directory != 2;
        }
    }
    close(fd);
    xSemaphoreGive(s_map_mutex);
    return ESP_OK;
}

static esp_err_t append_record(map_record_t *record) {
    if (!s_map_mutex || xSemaphoreTake(s_map_mutex, pdMS_TO_TICKS(500)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (s_next_sequence == UINT32_MAX) {
        xSemaphoreGive(s_map_mutex);
        return ESP_ERR_INVALID_SIZE;
    }
    FILE *file = fopen(MAP_FILE, "ab");
    if (file == NULL) {
        xSemaphoreGive(s_map_mutex);
        return ESP_FAIL;
    }
    record->magic = MAP_RECORD_MAGIC;
    bool written = fwrite(record, sizeof(*record), 1, file) == 1 && fflush(file) == 0;
    bool closed = fclose(file) == 0;
    if (!written || !closed) {
        ESP_LOGE(TAG, "Unable to persist USB filename mapping for %s", record->logical);
        xSemaphoreGive(s_map_mutex);
        return ESP_FAIL;
    }
    s_next_sequence++;
    xSemaphoreGive(s_map_mutex);
    return ESP_OK;
}

static esp_err_t next_sequence(uint32_t *sequence) {
    if (s_next_sequence == 0 || s_next_sequence == UINT32_MAX) return ESP_FAIL;
    *sequence = s_next_sequence;
    return ESP_OK;
}

static bool join_path(const char *parent, const char *name, char *result, size_t result_size) {
    int length = parent[0] == '\0'
        ? snprintf(result, result_size, "%s", name)
        : snprintf(result, result_size, "%s/%s", parent, name);
    return length > 0 && (size_t)length < result_size;
}

static bool physical_absolute(const char *relative, char *absolute, size_t size) {
    int length = relative[0] == '\0'
        ? snprintf(absolute, size, "%s", USB_ROOT)
        : snprintf(absolute, size, "%s/%s", USB_ROOT, relative);
    return length > 0 && (size_t)length < size;
}

static bool is_windows_system_volume_information(const char *logical_directory, const char *name) {
    return logical_directory[0] == '\0' &&
        strcasecmp(name, "System Volume Information") == 0;
}

static esp_err_t create_mapping(const char *logical, const char *physical, bool is_directory,
                                map_record_t *record) {
    char normalized[MAP_PATH_MAX];
    if (!normalize_path(logical, normalized, sizeof(normalized)) || strcmp(normalized, logical) != 0) {
        ESP_LOGE(TAG, "USB filename cannot be represented by the logical-path API: %s", logical);
        return ESP_ERR_INVALID_ARG;
    }
    map_record_t existing_mapping;
    bool logical_path_exists = false;
    esp_err_t err = find_record(logical, false, &existing_mapping, &logical_path_exists);
    if (err != ESP_OK) return err;
    if (logical_path_exists) {
        ESP_LOGE(TAG, "Cannot map USB entry because logical path already exists: %s", logical);
        return ESP_ERR_INVALID_STATE;
    }
    uint32_t sequence;
    err = next_sequence(&sequence);
    if (err != ESP_OK) return err;
    for (;;) {
        char opaque_name[18];
        snprintf(opaque_name, sizeof(opaque_name), "%c%08" PRIX32 "%08" PRIX32,
                 is_directory ? 'D' : 'F', esp_random(), sequence);
        int name_length = physical[0] == '\0'
            ? snprintf(record->physical, sizeof(record->physical), "%s", opaque_name)
            : snprintf(record->physical, sizeof(record->physical), "%s/%s", physical, opaque_name);
        if (name_length <= 0 || (size_t)name_length >= sizeof(record->physical) ||
            strlcpy(record->logical, logical, sizeof(record->logical)) >= sizeof(record->logical)) {
            return ESP_ERR_INVALID_SIZE;
        }
        char absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
        if (!physical_absolute(record->physical, absolute, sizeof(absolute))) return ESP_ERR_INVALID_SIZE;
        struct stat status;
        if (stat(absolute, &status) != 0) break;
    }
    record->sequence = sequence;
    record->is_directory = is_directory ? 1 : 0;
    return append_record(record);
}

static esp_err_t migrate_directory(const char *logical_directory, const char *physical_directory,
                                   unsigned depth) {
    if (depth > MAP_MAX_DEPTH) {
        ESP_LOGE(TAG, "USB directory nesting exceeds supported depth (%u)", MAP_MAX_DEPTH);
        return ESP_ERR_INVALID_SIZE;
    }
    char absolute_directory[MAP_PATH_MAX + sizeof(USB_ROOT)];
    if (!physical_absolute(physical_directory, absolute_directory, sizeof(absolute_directory))) {
        return ESP_ERR_INVALID_SIZE;
    }
    DIR *directory = opendir(absolute_directory);
    if (directory == NULL) {
        ESP_LOGE(TAG, "Cannot scan USB directory %s", absolute_directory);
        return ESP_FAIL;
    }

    closedir(directory);

    // Rename one entry per scan so changing directory entries cannot invalidate readdir().
    for (;;) {
        directory = opendir(absolute_directory);
        if (directory == NULL) return ESP_FAIL;
        struct dirent *entry;
        bool renamed = false;
        esp_err_t result = ESP_OK;
        while ((entry = readdir(directory)) != NULL) {
            if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
            if (is_windows_system_volume_information(logical_directory, entry->d_name)) {
                ESP_LOGD(TAG, "Leaving Windows-managed metadata directory unchanged");
                continue;
            }
            char current_physical[MAP_PATH_MAX];
            char logical_path[MAP_PATH_MAX];
            if (!join_path(physical_directory, entry->d_name, current_physical, sizeof(current_physical)) ||
                !join_path(logical_directory, entry->d_name, logical_path, sizeof(logical_path))) {
                result = ESP_ERR_INVALID_SIZE;
                break;
            }
            map_record_t mapping = {0};
            bool found = false;
            result = find_record(current_physical, true, &mapping, &found);
            if (result != ESP_OK) break;
            if (found) continue;

            char current_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
            if (!physical_absolute(current_physical, current_absolute, sizeof(current_absolute))) {
                result = ESP_ERR_INVALID_SIZE;
                break;
            }
            struct stat status;
            if (stat(current_absolute, &status) != 0) {
                result = ESP_FAIL;
                break;
            }
            bool logical_found = false;
            result = find_record(logical_path, false, &mapping, &logical_found);
            if (result != ESP_OK) break;
            if (logical_found) {
                if (mapping.is_directory != (S_ISDIR(status.st_mode) ? 1 : 0)) {
                    ESP_LOGE(TAG, "Existing mapping has a different entry type for %s", logical_path);
                    result = ESP_ERR_INVALID_STATE;
                    break;
                }
                char mapped_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
                if (!physical_absolute(mapping.physical, mapped_absolute, sizeof(mapped_absolute))) {
                    result = ESP_ERR_INVALID_SIZE;
                    break;
                }
                struct stat mapped_status;
                if (stat(mapped_absolute, &mapped_status) == 0) {
                    ESP_LOGE(TAG, "Cannot resume mapping %s: both original and mapped entries exist",
                             logical_path);
                    result = ESP_ERR_INVALID_STATE;
                    break;
                }
                if (errno != ENOENT) {
                    result = ESP_FAIL;
                    break;
                }
            } else {
                result = create_mapping(logical_path, physical_directory, S_ISDIR(status.st_mode), &mapping);
                if (result != ESP_OK) break;
            }
            char target_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
            if (!physical_absolute(mapping.physical, target_absolute, sizeof(target_absolute))) {
                result = ESP_ERR_INVALID_SIZE;
                break;
            }
            if (rename(current_absolute, target_absolute) != 0) {
                ESP_LOGE(TAG, "Cannot rename USB entry %s to opaque path %s",
                         current_absolute, target_absolute);
                result = ESP_FAIL;
                break;
            }
            renamed = true;
            break;
        }
        closedir(directory);
        if (result != ESP_OK) return result;
        if (!renamed) break;
    }

    directory = opendir(absolute_directory);
    if (directory == NULL) return ESP_FAIL;
    struct dirent *entry;
    esp_err_t result = ESP_OK;
    while ((entry = readdir(directory)) != NULL) {
        if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
        if (is_windows_system_volume_information(logical_directory, entry->d_name)) continue;
        char current_physical[MAP_PATH_MAX];
        if (!join_path(physical_directory, entry->d_name, current_physical, sizeof(current_physical))) {
            result = ESP_ERR_INVALID_SIZE;
            break;
        }
        map_record_t mapping = {0};
        bool found = false;
        result = find_record(current_physical, true, &mapping, &found);
        if (result != ESP_OK || !found) {
            if (result == ESP_OK) result = ESP_ERR_INVALID_STATE;
            break;
        }
        if (mapping.is_directory) {
            result = migrate_directory(mapping.logical, mapping.physical, depth + 1);
            if (result != ESP_OK) break;
        }
    }
    closedir(directory);
    return result;
}

esp_err_t usb_storage_map_init(void) {
    if (s_map_ready) return ESP_OK;
    nvs_handle_t nvs_handle;
    esp_err_t err = nvs_open("usb_name_map", NVS_READWRITE, &nvs_handle);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Cannot open filename-map initialization state: %s", esp_err_to_name(err));
        return err;
    }
    uint8_t database_initialized = 0;
    esp_err_t db_state_err = nvs_get_u8(nvs_handle, "database_ready", &database_initialized);
    if (db_state_err != ESP_OK && db_state_err != ESP_ERR_NVS_NOT_FOUND) {
        nvs_close(nvs_handle);
        ESP_LOGE(TAG, "Cannot read filename-map database state: %s", esp_err_to_name(db_state_err));
        return db_state_err;
    }
    const esp_vfs_littlefs_conf_t config = {
        .base_path = MAP_MOUNT,
        .partition_label = "storage",
        .format_if_mount_failed = false,
        .read_only = false,
    };
    err = esp_vfs_littlefs_register(&config);
    if (err != ESP_OK) {
        if (db_state_err != ESP_ERR_NVS_NOT_FOUND) {
            nvs_close(nvs_handle);
            ESP_LOGE(TAG, "LittleFS mount failed for initialized storage; preserving partition: %s",
                     esp_err_to_name(err));
            return err;
        }
        ESP_LOGW(TAG, "First-time LittleFS mount failed (%s); formatting new partition",
                 esp_err_to_name(err));
        err = esp_littlefs_format("storage");
        if (err == ESP_OK) err = esp_vfs_littlefs_register(&config);
        // After successful format, ensure NVS flag is set
        if (err == ESP_OK && db_state_err != ESP_OK) {
            nvs_handle_t nvs_handle;
            err = nvs_open("usb_name_map", NVS_READWRITE, &nvs_handle);
            if (err == ESP_OK) {
                err = nvs_set_u8(nvs_handle, "database_ready", 1);
                if (err == ESP_OK) err = nvs_commit(nvs_handle);
                nvs_close(nvs_handle);
            }
        }
    }
    if (err != ESP_OK) {
        nvs_close(nvs_handle);
        ESP_LOGE(TAG, "Cannot mount internal filename-map partition: %s", esp_err_to_name(err));
        return err;
    }
    nvs_close(nvs_handle);

    s_map_mutex = xSemaphoreCreateMutex();
    if (!s_map_mutex) {
        ESP_LOGE(TAG, "Failed to create map mutex");
        return ESP_ERR_NO_MEM;
    }

    if (xSemaphoreTake(s_map_mutex, pdMS_TO_TICKS(500)) != pdTRUE) return ESP_ERR_TIMEOUT;
    FILE *file = fopen(MAP_FILE, "ab");
    if (file == NULL) {
        xSemaphoreGive(s_map_mutex);
        ESP_LOGE(TAG, "Cannot open internal USB filename map");
        return ESP_FAIL;
    }
    if (fclose(file) != 0) {
        xSemaphoreGive(s_map_mutex);
        return ESP_FAIL;
    }
    xSemaphoreGive(s_map_mutex);

    if (db_state_err == ESP_ERR_NVS_NOT_FOUND) {
        err = nvs_open("usb_name_map", NVS_READWRITE, &nvs_handle);
        if (err == ESP_OK) {
            err = nvs_set_u8(nvs_handle, "database_ready", 1);
            if (err == ESP_OK) err = nvs_commit(nvs_handle);
            nvs_close(nvs_handle);
        }
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Cannot persist filename-map database state: %s", esp_err_to_name(err));
            return err;
        }
    }

    struct stat status;
    if (stat(MAP_FILE, &status) != 0 || status.st_size < 0) return ESP_FAIL;
    off_t valid_size = status.st_size - status.st_size % (off_t)sizeof(map_record_t);
    if (valid_size != status.st_size) {
        ESP_LOGW(TAG, "Discarding an incomplete trailing filename-map record");
        if (truncate(MAP_FILE, valid_size) != 0) {
            ESP_LOGE(TAG, "Cannot repair the incomplete trailing map record");
            return ESP_FAIL;
        }
    }
    if (xSemaphoreTake(s_map_mutex, pdMS_TO_TICKS(500)) != pdTRUE) return ESP_ERR_TIMEOUT;
    file = fopen(MAP_FILE, "rb");
    if (file == NULL) {
        xSemaphoreGive(s_map_mutex);
        return ESP_FAIL;
    }
    map_record_t record;
    bool invalid_map = false;
    uint32_t expected_sequence = 1;
    for (off_t offset = 0; offset < valid_size; offset += (off_t)sizeof(map_record_t)) {
        if (!read_record(file, &record) || record.sequence != expected_sequence++) {
            invalid_map = true;
            break;
        }
    }
    invalid_map = invalid_map || ferror(file) != 0 || ftell(file) != valid_size;
    fclose(file);
    xSemaphoreGive(s_map_mutex);
    if (invalid_map) {
        ESP_LOGE(TAG, "Internal filename map is corrupt; refusing to rename or expose USB data");
        return ESP_ERR_INVALID_CRC;
    }
    s_next_sequence = expected_sequence;
    s_map_ready = true;
    return ESP_OK;
}

esp_err_t usb_storage_map_migrate(const char *device_id) {
    if (!s_map_ready) return ESP_ERR_INVALID_STATE;
    if (device_id == NULL || device_id[0] == '\0' || strlen(device_id) >= 128) {
        return ESP_ERR_INVALID_ARG;
    }

    uint32_t identity_hash = 2166136261U;
    for (const unsigned char *p = (const unsigned char *)device_id; *p != '\0'; p++) {
        identity_hash = (identity_hash ^ *p) * 16777619U;
    }
    char identity_key[16];
    char selected_map[sizeof(s_map_file)];
    snprintf(identity_key, sizeof(identity_key), "drv_%08" PRIx32, identity_hash);

    nvs_handle_t nvs_handle;
    esp_err_t err = nvs_open("usb_name_map", NVS_READWRITE, &nvs_handle);
    if (err != ESP_OK) return err;

    size_t mapped_id_length = 0;
    err = nvs_get_str(nvs_handle, identity_key, NULL, &mapped_id_length);
    if (err == ESP_OK) {
        char mapped_id[128];
        if (mapped_id_length > sizeof(mapped_id) ||
            nvs_get_str(nvs_handle, identity_key, mapped_id, &mapped_id_length) != ESP_OK ||
            strcmp(mapped_id, device_id) != 0) {
            ESP_LOGE(TAG, "USB drive identity hash collision; refusing to use another drive's filename map");
            nvs_close(nvs_handle);
            return ESP_ERR_INVALID_STATE;
        }
        size_t legacy_id_length = 0;
        esp_err_t legacy_err = nvs_get_str(nvs_handle, "drive_identity", NULL, &legacy_id_length);
        bool use_legacy_map = false;
        if (legacy_err == ESP_OK) {
            char legacy_id[128];
            if (legacy_id_length > sizeof(legacy_id) ||
                nvs_get_str(nvs_handle, "drive_identity", legacy_id, &legacy_id_length) != ESP_OK) {
                nvs_close(nvs_handle);
                return ESP_ERR_INVALID_STATE;
            }
            use_legacy_map = strcmp(legacy_id, device_id) == 0;
        } else if (legacy_err != ESP_ERR_NVS_NOT_FOUND) {
            nvs_close(nvs_handle);
            return legacy_err;
        }
        int path_length = use_legacy_map
            ? snprintf(selected_map, sizeof(selected_map), "%s", LEGACY_MAP_FILE)
            : snprintf(selected_map, sizeof(selected_map), MAP_MOUNT "/map_%08" PRIx32 ".bin",
                       identity_hash);
        if (path_length <= 0 || (size_t)path_length >= sizeof(selected_map)) {
            nvs_close(nvs_handle);
            return ESP_ERR_INVALID_SIZE;
        }
    } else if (err == ESP_ERR_NVS_NOT_FOUND) {
        size_t legacy_id_length = 0;
        esp_err_t legacy_err = nvs_get_str(nvs_handle, "drive_identity", NULL, &legacy_id_length);
        bool use_legacy_map = legacy_err == ESP_ERR_NVS_NOT_FOUND;
        if (legacy_err == ESP_OK) {
            char legacy_id[128];
            if (legacy_id_length > sizeof(legacy_id) ||
                nvs_get_str(nvs_handle, "drive_identity", legacy_id, &legacy_id_length) != ESP_OK) {
                nvs_close(nvs_handle);
                return ESP_ERR_INVALID_STATE;
            }
            use_legacy_map = strcmp(legacy_id, device_id) == 0;
        } else if (legacy_err != ESP_ERR_NVS_NOT_FOUND) {
            nvs_close(nvs_handle);
            return legacy_err;
        }

        int path_length = use_legacy_map
            ? snprintf(selected_map, sizeof(selected_map), "%s", LEGACY_MAP_FILE)
            : snprintf(selected_map, sizeof(selected_map), MAP_MOUNT "/map_%08" PRIx32 ".bin",
                       identity_hash);
        if (path_length <= 0 || (size_t)path_length >= sizeof(selected_map)) {
            nvs_close(nvs_handle);
            return ESP_ERR_INVALID_SIZE;
        }

        struct stat map_status;
        if (stat(selected_map, &map_status) != 0 && errno != ENOENT) {
            nvs_close(nvs_handle);
            return ESP_FAIL;
        }
        FILE *map_file = fopen(selected_map, "ab");
        if (map_file == NULL) {
            nvs_close(nvs_handle);
            return ESP_FAIL;
        }
        if (fclose(map_file) != 0) {
            nvs_close(nvs_handle);
            return ESP_FAIL;
        }
        err = nvs_set_str(nvs_handle, identity_key, device_id);
        if (err == ESP_OK && use_legacy_map && legacy_err == ESP_ERR_NVS_NOT_FOUND) {
            err = nvs_set_str(nvs_handle, "drive_identity", device_id);
        }
        if (err == ESP_OK) err = nvs_commit(nvs_handle);
        if (err != ESP_OK) {
            nvs_close(nvs_handle);
            return err;
        }
    } else {
        nvs_close(nvs_handle);
        return err;
    }

    nvs_close(nvs_handle);
    strlcpy(s_map_file, selected_map, sizeof(s_map_file));

    struct stat status;
    if (stat(MAP_FILE, &status) != 0 || status.st_size < 0) {
        ESP_LOGE(TAG, "Filename map for this USB drive is missing or unreadable");
        return ESP_ERR_NOT_FOUND;
    }
    off_t valid_size = status.st_size - status.st_size % (off_t)sizeof(map_record_t);
    if (valid_size != status.st_size) {
        ESP_LOGW(TAG, "Discarding an incomplete trailing filename-map record");
        if (truncate(MAP_FILE, valid_size) != 0) return ESP_FAIL;
    }
    if (xSemaphoreTake(s_map_mutex, pdMS_TO_TICKS(500)) != pdTRUE) return ESP_ERR_TIMEOUT;
    FILE *map_file = fopen(MAP_FILE, "rb");
    if (map_file == NULL) {
        xSemaphoreGive(s_map_mutex);
        return ESP_FAIL;
    }
    map_record_t record;
    uint32_t expected_sequence = 1;
    bool invalid_map = false;
    for (off_t offset = 0; offset < valid_size; offset += (off_t)sizeof(map_record_t)) {
        if (!read_record(map_file, &record) || record.sequence != expected_sequence++) {
            invalid_map = true;
            break;
        }
    }
    invalid_map = invalid_map || ferror(map_file) != 0 || ftell(map_file) != valid_size;
    fclose(map_file);
    xSemaphoreGive(s_map_mutex);
    if (invalid_map) {
        ESP_LOGE(TAG, "Filename map for this USB drive is corrupt; refusing to rename or expose its data");
        return ESP_ERR_INVALID_CRC;
    }
    s_next_sequence = expected_sequence;

    ESP_LOGI(TAG, "Using the saved filename map for USB device %s", device_id);
    err = migrate_directory("", "", 0);
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "USB filename migration did not complete; drive will remain unavailable");
    }
    return err;
}

static esp_err_t ensure_logical_path_mapped(const char *logical_path, map_record_t *mapping) {
    char current_logical[MAP_PATH_MAX] = "";
    char current_physical[MAP_PATH_MAX] = "";
    const char *segment = logical_path;

    while (*segment != '\0') {
        const char *separator = strchr(segment, '/');
        size_t segment_length = separator != NULL
            ? (size_t)(separator - segment)
            : strlen(segment);
        size_t prefix_length = strlen(current_logical);
        int logical_length = snprintf(current_logical + prefix_length,
                                      sizeof(current_logical) - prefix_length,
                                      "%s%.*s", prefix_length == 0 ? "" : "/",
                                      (int)segment_length, segment);
        if (logical_length <= 0 ||
            (size_t)logical_length >= sizeof(current_logical) - prefix_length) {
            return ESP_ERR_INVALID_SIZE;
        }

        bool found = false;
        esp_err_t err = find_record(current_logical, false, mapping, &found);
        if (err != ESP_OK) return err;
        if (found) {
            if (mapping->is_directory == 2) return ESP_ERR_NOT_FOUND;
            if (separator != NULL && mapping->is_directory != 1) return ESP_ERR_NOT_FOUND;
            if (strlcpy(current_physical, mapping->physical, sizeof(current_physical)) >=
                sizeof(current_physical)) {
                return ESP_ERR_INVALID_SIZE;
            }
        } else {
            char parent_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
            if (!physical_absolute(current_physical, parent_absolute, sizeof(parent_absolute))) {
                return ESP_ERR_INVALID_SIZE;
            }
            DIR *directory = opendir(parent_absolute);
            if (directory == NULL) return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;

            bool entry_exists = false;
            struct dirent *entry;
            errno = 0;
            while ((entry = readdir(directory)) != NULL) {
                if (strlen(entry->d_name) == segment_length &&
                    memcmp(entry->d_name, segment, segment_length) == 0) {
                    entry_exists = true;
                    break;
                }
            }
            int scan_errno = errno;
            closedir(directory);
            if (!entry_exists) return scan_errno != 0 ? ESP_FAIL : ESP_ERR_NOT_FOUND;

            char current_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
            int path_length = snprintf(current_absolute, sizeof(current_absolute),
                                       "%s/%.*s", parent_absolute,
                                       (int)segment_length, segment);
            if (path_length <= 0 || (size_t)path_length >= sizeof(current_absolute)) {
                return ESP_ERR_INVALID_SIZE;
            }
            struct stat status;
            if (stat(current_absolute, &status) != 0) return ESP_FAIL;
            err = create_mapping(current_logical, current_physical,
                                 S_ISDIR(status.st_mode), mapping);
            if (err != ESP_OK) return err;

            char target_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
            if (!physical_absolute(mapping->physical, target_absolute, sizeof(target_absolute))) {
                return ESP_ERR_INVALID_SIZE;
            }
            if (rename(current_absolute, target_absolute) != 0) {
                ESP_LOGE(TAG, "Cannot map USB entry %s to opaque path %s",
                         current_absolute, target_absolute);
                return ESP_FAIL;
            }
            if (separator != NULL && mapping->is_directory != 1) return ESP_ERR_NOT_FOUND;
            if (strlcpy(current_physical, mapping->physical, sizeof(current_physical)) >=
                sizeof(current_physical)) {
                return ESP_ERR_INVALID_SIZE;
            }
        }

        if (separator == NULL) break;
        segment = separator + 1;
    }
    return ESP_OK;
}

esp_err_t usb_storage_map_resolve(const char *logical_path, char *physical_path, size_t path_size) {
    if (!s_map_ready || logical_path == NULL || physical_path == NULL) return ESP_ERR_INVALID_STATE;
    char logical[MAP_PATH_MAX];
    if (!normalize_path(logical_path, logical, sizeof(logical))) return ESP_ERR_INVALID_ARG;
    if (logical[0] == '\0') {
        return strlcpy(physical_path, USB_ROOT, path_size) < path_size ? ESP_OK : ESP_ERR_INVALID_SIZE;
    }
    map_record_t mapping;
    bool found = false;
    esp_err_t err = find_record(logical, false, &mapping, &found);
    if (err != ESP_OK) return err;
    if (!found) {
        ESP_LOGD(TAG, "Logical path is not mapped; checking USB for %s", logical);
        err = ensure_logical_path_mapped(logical, &mapping);
        if (err != ESP_OK) {
            if (err == ESP_ERR_NOT_FOUND) {
                ESP_LOGD(TAG, "USB path does not exist yet: %s", logical);
            } else {
                ESP_LOGE(TAG, "Unable to map requested USB path %s: %s",
                         logical, esp_err_to_name(err));
            }
            return err;
        }
    } else if (mapping.is_directory == 2) {
        return ESP_ERR_NOT_FOUND;
    }
    return physical_absolute(mapping.physical, physical_path, path_size) ? ESP_OK : ESP_ERR_INVALID_SIZE;
}

esp_err_t usb_storage_map_get_logical(const char *physical_path, char *logical_path, size_t path_size,
                                      bool *is_directory) {
    if (!s_map_ready || physical_path == NULL || logical_path == NULL) return ESP_ERR_INVALID_STATE;
    char physical[MAP_PATH_MAX];
    if (!normalize_path(physical_path, physical, sizeof(physical)) || physical[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    map_record_t mapping;
    bool found = false;
    esp_err_t err = find_record(physical, true, &mapping, &found);
    if (err != ESP_OK) return err;
    if (!found) return ESP_ERR_NOT_FOUND;
    int length = snprintf(logical_path, path_size, "%s/%s", USB_ROOT, mapping.logical);
    if (length <= 0 || (size_t)length >= path_size) return ESP_ERR_INVALID_SIZE;
    if (is_directory != NULL) *is_directory = mapping.is_directory != 0;
    return ESP_OK;
}

esp_err_t usb_storage_map_mkdir(const char *logical_path) {
    if (!s_map_ready || logical_path == NULL) return ESP_ERR_INVALID_STATE;
    char logical[MAP_PATH_MAX];
    if (!normalize_path(logical_path, logical, sizeof(logical)) || logical[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    map_record_t existing;
    bool found = false;
    esp_err_t err = find_record(logical, false, &existing, &found);
    if (err != ESP_OK) return err;
    if (found) {
        char absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
        if (!physical_absolute(existing.physical, absolute, sizeof(absolute))) return ESP_ERR_INVALID_SIZE;
        struct stat status;
        if (stat(absolute, &status) == 0) {
            return existing.is_directory == 1 && S_ISDIR(status.st_mode) ? ESP_OK : ESP_ERR_INVALID_STATE;
        }
        if (existing.is_directory != 1 || mkdir(absolute, 0777) != 0) return ESP_FAIL;
        return ESP_OK;
    }

    char *separator = strrchr(logical, '/');
    char parent_logical[MAP_PATH_MAX] = "";
    if (separator != NULL) {
        size_t parent_length = (size_t)(separator - logical);
        memcpy(parent_logical, logical, parent_length);
        parent_logical[parent_length] = '\0';
    }
    char parent_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
    if (parent_logical[0] == '\0') {
        strlcpy(parent_absolute, USB_ROOT, sizeof(parent_absolute));
    } else {
        err = usb_storage_map_resolve(parent_logical, parent_absolute, sizeof(parent_absolute));
        if (err != ESP_OK) return err;
    }
    char parent_physical[MAP_PATH_MAX] = "";
    if (strcmp(parent_absolute, USB_ROOT) != 0) {
        const char *relative = parent_absolute + sizeof(USB_ROOT);
        if (strlcpy(parent_physical, relative, sizeof(parent_physical)) >= sizeof(parent_physical)) {
            return ESP_ERR_INVALID_SIZE;
        }
    }
    map_record_t mapping = {0};
    err = create_mapping(logical, parent_physical, true, &mapping);
    if (err != ESP_OK) return err;
    char absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
    if (!physical_absolute(mapping.physical, absolute, sizeof(absolute))) return ESP_ERR_INVALID_SIZE;
    if (mkdir(absolute, 0777) != 0) {
        ESP_LOGE(TAG, "Cannot create USB folder at %s", absolute);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t usb_storage_map_create_file(const char *logical_path, const char *name,
                                      char *physical_path, size_t path_size) {
    if (!s_map_ready || logical_path == NULL || name == NULL ||
        physical_path == NULL || path_size == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    size_t name_length = strnlen(name, MAP_PATH_MAX);
    if (name_length == 0 || name_length >= MAP_PATH_MAX ||
        strchr(name, '/') != NULL || strchr(name, '\\') != NULL ||
        strchr(name, '%') != NULL || strcmp(name, ".") == 0 || strcmp(name, "..") == 0) {
        return ESP_ERR_INVALID_ARG;
    }
    char parent_logical[MAP_PATH_MAX];
    if (!normalize_path(logical_path, parent_logical, sizeof(parent_logical))) return ESP_ERR_INVALID_ARG;
    char full_logical[MAP_PATH_MAX];
    int logical_length = parent_logical[0] == '\0'
        ? snprintf(full_logical, sizeof(full_logical), "%s", name)
        : snprintf(full_logical, sizeof(full_logical), "%s/%s", parent_logical, name);
    if (logical_length <= 0 || (size_t)logical_length >= sizeof(full_logical)) return ESP_ERR_INVALID_SIZE;

    map_record_t existing;
    bool found = false;
    esp_err_t err = find_record(full_logical, false, &existing, &found);
    if (err != ESP_OK) return err;
    if (found) {
        if (existing.is_directory != 0 ||
            !physical_absolute(existing.physical, physical_path, path_size)) {
            return ESP_ERR_INVALID_STATE;
        }
        struct stat status;
        if (stat(physical_path, &status) == 0) return ESP_ERR_INVALID_STATE;
        if (errno != ENOENT) return ESP_FAIL;
        FILE *file = fopen(physical_path, "wb");
        if (file == NULL) return ESP_FAIL;
        if (fclose(file) != 0) return ESP_FAIL;
        return ESP_OK;
    }

    char parent_physical[MAP_PATH_MAX] = "";
    if (parent_logical[0] != '\0') {
        char parent_absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
        err = usb_storage_map_resolve(parent_logical, parent_absolute, sizeof(parent_absolute));
        if (err != ESP_OK) return err;
        if (strlcpy(parent_physical, parent_absolute + sizeof(USB_ROOT), sizeof(parent_physical)) >=
            sizeof(parent_physical)) return ESP_ERR_INVALID_SIZE;
    }

    map_record_t mapping = {0};
    err = create_mapping(full_logical, parent_physical, false, &mapping);
    if (err != ESP_OK) return err;
    if (!physical_absolute(mapping.physical, physical_path, path_size)) return ESP_ERR_INVALID_SIZE;
    FILE *file = fopen(physical_path, "wb");
    if (file == NULL) {
        ESP_LOGE(TAG, "Cannot create USB file for logical path %s", full_logical);
        mapping.sequence = s_next_sequence;
        mapping.is_directory = 2;
        esp_err_t tombstone_err = append_record(&mapping);
        return tombstone_err == ESP_OK ? ESP_FAIL : tombstone_err;
    }
    if (fclose(file) != 0) return ESP_FAIL;
    return ESP_OK;
}

static esp_err_t mark_deleted(const map_record_t *mapping) {
    map_record_t tombstone = *mapping;
    tombstone.sequence = s_next_sequence;
    tombstone.is_directory = 2;
    return append_record(&tombstone);
}

static esp_err_t delete_mapped_entry(const char *logical_path, unsigned depth) {
    if (depth > MAP_MAX_DEPTH) return ESP_ERR_INVALID_SIZE;
    map_record_t mapping;
    bool found = false;
    esp_err_t err = find_record(logical_path, false, &mapping, &found);
    if (err != ESP_OK) return err;
    if (!found) return ESP_ERR_NOT_FOUND;

    char absolute[MAP_PATH_MAX + sizeof(USB_ROOT)];
    if (!physical_absolute(mapping.physical, absolute, sizeof(absolute))) return ESP_ERR_INVALID_SIZE;
    struct stat status;
    if (stat(absolute, &status) != 0) return ESP_ERR_NOT_FOUND;
    if (mapping.is_directory == 1) {
        for (;;) {
            DIR *directory = opendir(absolute);
            if (directory == NULL) return ESP_FAIL;
            struct dirent *entry;
            bool has_child = false;
            char physical_child[MAP_PATH_MAX];
            while ((entry = readdir(directory)) != NULL) {
                if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
                if (!join_path(mapping.physical, entry->d_name, physical_child, sizeof(physical_child))) {
                    closedir(directory);
                    return ESP_ERR_INVALID_SIZE;
                }
                has_child = true;
                break;
            }
            closedir(directory);
            if (!has_child) break;
            map_record_t child;
            bool child_found = false;
            err = find_record(physical_child, true, &child, &child_found);
            if (err != ESP_OK || !child_found) {
                return err == ESP_OK ? ESP_ERR_INVALID_STATE : err;
            }
            err = delete_mapped_entry(child.logical, depth + 1);
            if (err != ESP_OK) return err;
        }
        if (rmdir(absolute) != 0) return ESP_FAIL;
    } else if (unlink(absolute) != 0) {
        return ESP_FAIL;
    }
    return mark_deleted(&mapping);
}

esp_err_t usb_storage_map_delete(const char *logical_path) {
    if (!s_map_ready || logical_path == NULL) return ESP_ERR_INVALID_ARG;
    char logical[MAP_PATH_MAX];
    if (!normalize_path(logical_path, logical, sizeof(logical)) || logical[0] == '\0') {
        return ESP_ERR_INVALID_ARG;
    }
    return delete_mapped_entry(logical, 0);
}
