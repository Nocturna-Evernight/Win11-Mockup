/*
 * User Profiles and UAC Elevation Engine
 * Persistent storage on 32GB USB Drive (/usb/system/users.db)
 */

#include "auth_uac.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include "esp_log.h"
#include "psa/crypto.h"
#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "cJSON.h"

static const char *TAG = "AUTH_UAC";
static user_account_t s_users[MAX_USERS];
static user_account_t s_loaded_users[MAX_USERS];
static int s_user_count = 0;
static char s_db_path[64] = "/usb/system/users.db";
static char s_settings_path[64] = "/usb/system/auth_settings.json";

static bool get_db_path(char *path, size_t path_size) {
    if (usb_host_msc_is_mounted()) {
        esp_err_t err = usb_storage_map_resolve(s_db_path, path, path_size);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Unable to resolve the abstracted account database path: %s", esp_err_to_name(err));
            return false;
        }
        return true;
    }
    if (strlcpy(path, s_db_path, path_size) >= path_size) {
        ESP_LOGE(TAG, "Account database path does not fit the destination buffer");
        return false;
    }
    return true;
}

static bool account_record_is_valid(const user_account_t *account) {
    if (memchr(account->username, '\0', sizeof(account->username)) == NULL ||
        account->username[0] == '\0' ||
        memchr(account->display_name, '\0', sizeof(account->display_name)) == NULL ||
        memchr(account->password_hash, '\0', sizeof(account->password_hash)) == NULL ||
        account->uac_level < UAC_POLICY_NEVER_NOTIFY ||
        account->uac_level > UAC_POLICY_ALWAYS_NOTIFY) {
        return false;
    }
    size_t hash_length = strnlen(account->password_hash, sizeof(account->password_hash));
    return hash_length == 0 || hash_length == sizeof(account->password_hash) - 1;
}

bool auth_hash_password(const char *password, char *output_hex) {
    if (password == NULL || output_hex == NULL) {
        ESP_LOGE(TAG, "Cannot hash a null password or output buffer.");
        return false;
    }

    unsigned char hash[32];
    size_t hash_length = 0;
    psa_status_t status = psa_crypto_init();
    if (status != PSA_SUCCESS) {
        ESP_LOGE(TAG, "PSA crypto initialization failed: %d", (int)status);
        output_hex[0] = '\0';
        return false;
    }

    status = psa_hash_compute(PSA_ALG_SHA_256,
                              (const unsigned char *)password, strlen(password),
                              hash, sizeof(hash), &hash_length);
    if (status != PSA_SUCCESS || hash_length != sizeof(hash)) {
        ESP_LOGE(TAG, "SHA-256 computation failed: %d", (int)status);
        output_hex[0] = '\0';
        return false;
    }

    for (int i = 0; i < 32; i++) {
        sprintf(output_hex + (i * 2), "%02x", hash[i]);
    }
    output_hex[64] = '\0';
    return true;
}

void auth_save_settings(void) {
    if (!usb_host_msc_is_mounted()) return;
    
    char physical_path[256];
    esp_err_t err = usb_storage_map_resolve(s_settings_path, physical_path, sizeof(physical_path));
    if (err != ESP_OK) {
        char parent_path[MAP_PATH_MAX];
        char *separator = strrchr(s_settings_path, '/');
        if (separator == NULL) return;
        size_t parent_length = (size_t)(separator - s_settings_path);
        memcpy(parent_path, s_settings_path, parent_length);
        parent_path[parent_length] = '\0';
        usb_storage_map_create_file(parent_path, separator + 1, physical_path, sizeof(physical_path));
    }
    
    FILE *f = fopen(physical_path, "w");
    if (f) {
        fprintf(f, "{\n");
        fprintf(f, "  \"admin_password_changed\": true,\n");
        fprintf(f, "  \"default_admin_username\": \"Administrator\",\n");
        fprintf(f, "  \"version\": 1\n");
        fprintf(f, "}\n");
        fclose(f);
    }
}

bool auth_has_admin_password_changed(void) {
    if (!usb_host_msc_is_mounted()) return false;
    
    char physical_path[256];
    esp_err_t err = usb_storage_map_resolve(s_settings_path, physical_path, sizeof(physical_path));
    if (err != ESP_OK) return false;
    
    FILE *f = fopen(physical_path, "r");
    if (!f) return false;
    fseek(f, 0, SEEK_END);
    long size = ftell(f);
    char *buf = malloc(size + 1);
    if (!buf) {
        fclose(f);
        return false;
    }
    fseek(f, 0, SEEK_SET);
    fread(buf, 1, size, f);
    buf[size] = '\0';
    fclose(f);
    
    cJSON *root = cJSON_Parse(buf);
    if (!root) {
        free(buf);
        return false;
    }
    cJSON *item = cJSON_GetObjectItem(root, "admin_password_changed");
    bool result = cJSON_IsTrue(item);
    cJSON_Delete(root);
    free(buf);
    return result;
}

bool auth_set_admin_password(const char *username, const char *new_password) {
    if (!username || !new_password) return false;
    
    char hash[65];
    if (!auth_hash_password(new_password, hash)) return false;
    
    for (int i = 0; i < s_user_count; i++) {
        if (s_users[i].is_admin && strcmp(s_users[i].username, username) == 0) {
            char previous_hash[sizeof(s_users[i].password_hash)];
            memcpy(previous_hash, s_users[i].password_hash, sizeof(previous_hash));
            strncpy(s_users[i].password_hash, hash, sizeof(s_users[i].password_hash));
            s_users[i].password_hash[64] = '\0';
            if (!auth_save_users()) {
                memcpy(s_users[i].password_hash, previous_hash, sizeof(previous_hash));
                return false;
            }
            auth_save_settings();
            ESP_LOGI(TAG, "Admin password updated for user: %s", username);
            return true;
        }
    }
    return false;
}

void auth_uac_init(const char *db_path) {
    if (db_path) {
        size_t path_length = strnlen(db_path, sizeof(s_db_path));
        if (path_length == 0 || path_length >= sizeof(s_db_path)) {
            ESP_LOGE(TAG, "User database path is empty or too long");
            return;
        }
        memcpy(s_db_path, db_path, path_length + 1);
    }

    char resolved_db_path[MAP_PATH_MAX + 8];
    bool needs_db_mapping = false;
    bool database_missing = false;
    if (usb_host_msc_is_mounted()) {
        esp_err_t path_err = usb_storage_map_resolve(s_db_path, resolved_db_path,
                                                     sizeof(resolved_db_path));
        if (path_err == ESP_ERR_NOT_FOUND) {
            needs_db_mapping = true;
            database_missing = true;
        } else if (path_err != ESP_OK) {
            ESP_LOGE(TAG, "Unable to resolve the abstracted account database path: %s",
                     esp_err_to_name(path_err));
            return;
        }
    } else if (!get_db_path(resolved_db_path, sizeof(resolved_db_path))) {
        return;
    }
    FILE *f = needs_db_mapping ? NULL : fopen(resolved_db_path, "rb");
    database_missing = database_missing || f == NULL;
    if (f) {
        int stored_user_count = 0;
        bool valid = fread(&stored_user_count, sizeof(stored_user_count), 1, f) == 1 &&
                     stored_user_count > 0 && stored_user_count <= MAX_USERS;
        memset(s_loaded_users, 0, sizeof(s_loaded_users));
        if (valid) {
            for (int i = 0; i < stored_user_count; i++) {
                if (fread(&s_loaded_users[i], sizeof(user_account_t), 1, f) != 1 ||
                    !account_record_is_valid(&s_loaded_users[i])) {
                    valid = false;
                    break;
                }
            }
        }
        if (valid && fgetc(f) != EOF) {
            valid = false;
        }
        if (ferror(f)) {
            valid = false;
        }
        fclose(f);
        if (valid) {
            memset(s_users, 0, sizeof(s_users));
            memcpy(s_users, s_loaded_users, (size_t)stored_user_count * sizeof(s_users[0]));
            s_user_count = stored_user_count;
            ESP_LOGI(TAG, "Loaded %d user accounts from USB database.", s_user_count);
            return;
        }
        ESP_LOGE(TAG, "User database is truncated, oversized, or invalid; using in-memory defaults without overwriting it");
    }

    ESP_LOGI(TAG, "Creating default Windows 11 accounts...");
    memset(s_users, 0, sizeof(s_users));
    s_user_count = 0;

    user_account_t *admin = &s_users[s_user_count++];
    strlcpy(admin->username, "Administrator", sizeof(admin->username));
    strlcpy(admin->display_name, "System Administrator", sizeof(admin->display_name));
    if (!auth_hash_password("password", admin->password_hash)) {
        s_user_count = 0;
        return;
    }
    admin->is_admin = true;
    admin->uac_level = 2;

    user_account_t *kennard = &s_users[s_user_count++];
    strlcpy(kennard->username, "Kennard", sizeof(kennard->username));
    strlcpy(kennard->display_name, "Kennard Devida", sizeof(kennard->display_name));
    if (!auth_hash_password("password", kennard->password_hash)) {
        s_user_count = 0;
        return;
    }
    kennard->is_admin = true;
    kennard->uac_level = 2;

    user_account_t *guest = &s_users[s_user_count++];
    strlcpy(guest->username, "Guest", sizeof(guest->username));
    strlcpy(guest->display_name, "Guest User", sizeof(guest->display_name));
    guest->password_hash[0] = '\0';
    guest->is_admin = false;
    guest->uac_level = 3;

    if (database_missing) {
        if (needs_db_mapping) {
            char parent_path[MAP_PATH_MAX];
            char *separator = strrchr(s_db_path, '/');
            if (separator == NULL || separator == s_db_path) {
                ESP_LOGE(TAG, "Cannot determine account database parent directory");
                return;
            }
            size_t parent_length = (size_t)(separator - s_db_path);
            if (parent_length >= sizeof(parent_path)) {
                ESP_LOGE(TAG, "Account database parent directory path is too long");
                return;
            }
            memcpy(parent_path, s_db_path, parent_length);
            parent_path[parent_length] = '\0';
            esp_err_t map_err = usb_storage_map_create_file(parent_path, separator + 1,
                                                            resolved_db_path, sizeof(resolved_db_path));
            if (map_err != ESP_OK) {
                ESP_LOGE(TAG, "Unable to create mapped account database: %s",
                         esp_err_to_name(map_err));
                return;
            }
        }
        auth_save_users();
        auth_save_settings();
    }
}

bool auth_save_users(void) {
    char db_path[MAP_PATH_MAX + 8];
    if (!get_db_path(db_path, sizeof(db_path))) return false;
    FILE *f = fopen(db_path, "wb");
    if (f) {
        bool write_ok = s_user_count > 0 && s_user_count <= MAX_USERS &&
                        fwrite(&s_user_count, sizeof(s_user_count), 1, f) == 1 &&
                        fwrite(s_users, sizeof(user_account_t), (size_t)s_user_count, f) ==
                            (size_t)s_user_count;
        if (fclose(f) != 0) {
            write_ok = false;
        }
        if (write_ok) {
            ESP_LOGI(TAG, "User accounts committed to USB persistence.");
            return true;
        } else {
            ESP_LOGE(TAG, "Failed to completely write user database");
            return false;
        }
    } else {
        ESP_LOGW(TAG, "Could not open %s for write (USB mounted?).", db_path);
        return false;
    }
}

bool auth_verify_login(const char *username, const char *password, user_account_t *out_user) {
    if (username == NULL || password == NULL) {
        ESP_LOGE(TAG, "Login requires a username and password");
        return false;
    }
    char hash[65];
    if (!auth_hash_password(password, hash)) {
        return false;
    }

    for (int i = 0; i < s_user_count; i++) {
        if (strcmp(s_users[i].username, username) == 0) {
            if (strlen(s_users[i].password_hash) == 0 || strcmp(s_users[i].password_hash, hash) == 0) {
                if (out_user) {
                    memcpy(out_user, &s_users[i], sizeof(user_account_t));
                }
                ESP_LOGI(TAG, "User '%s' authenticated successfully.", username);
                return true;
            }
            break;
        }
    }
    ESP_LOGW(TAG, "Authentication failed for user '%s'.", username);
    return false;
}

bool auth_verify_admin_password(const char *password) {
    if (password == NULL || password[0] == '\0') return false;
    char hash[65];
    if (!auth_hash_password(password, hash)) return false;
    for (int i = 0; i < s_user_count; i++) {
        if (s_users[i].is_admin && s_users[i].password_hash[0] != '\0' &&
            strcmp(s_users[i].password_hash, hash) == 0) {
            return true;
        }
    }
    return false;
}

bool uac_verify_elevation(const char *acting_username, const char *admin_password, const char *target_exe) {
    if (acting_username == NULL || admin_password == NULL || target_exe == NULL) {
        ESP_LOGE(TAG, "Elevation request is missing required fields");
        return false;
    }
    ESP_LOGI(TAG, "UAC Elevation Requested by '%s' for '%s'", acting_username, target_exe);
    
    for (int i = 0; i < s_user_count; i++) {
        if (strcmp(s_users[i].username, acting_username) == 0) {
            if (s_users[i].is_admin) {
                ESP_LOGI(TAG, "UAC Granted: Acting user is already Administrator.");
                return true;
            }
        }
    }

    return auth_verify_admin_password(admin_password);
}