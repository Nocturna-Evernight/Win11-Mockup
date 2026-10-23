/*
 * Authentication & UAC System Header
 */
#ifndef AUTH_UAC_H
#define AUTH_UAC_H

#include <stdbool.h>

#define MAX_USERS 8

typedef enum {
    UAC_POLICY_ALWAYS_NOTIFY = 3,
    UAC_POLICY_PROMPT_CONSENT = 2,
    UAC_POLICY_NO_DIM = 1,
    UAC_POLICY_NEVER_NOTIFY = 0
} uac_policy_t;

typedef struct {
    char username[32];
    char display_name[64];
    char password_hash[65];
    bool is_admin;
    int uac_level;
} user_account_t;

void auth_uac_init(const char *db_path);
bool auth_hash_password(const char *password, char *output_hex);
bool auth_verify_login(const char *username, const char *password, user_account_t *out_user);
bool auth_verify_admin_password(const char *password);
bool uac_verify_elevation(const char *acting_username, const char *admin_password, const char *target_exe);
bool auth_save_users(void);
void auth_save_settings(void);
bool auth_has_admin_password_changed(void);
bool auth_set_admin_password(const char *username, const char *new_password);

#endif // AUTH_UAC_H
