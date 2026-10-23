/*
 * DNS Ad-Blocker (Pi-Hole Style) for ESP32-S3
 * DNS-level ad/tracker/malware blocking using PSRAM for blocklists
 * Configurable via internal terminal or Web GUI
 */

#ifndef DNS_ADBLOCK_H
#define DNS_ADBLOCK_H

#include <stdbool.h>
#include <stdint.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

#define DNS_ADBLOCK_MAX_DOMAINS     16384
#define DNS_ADBLOCK_MAX_LIST_URLS   16
#define DNS_ADBLOCK_MAX_LIST_URL_LEN 256
#define DNS_ADBLOCK_MAX_DOMAIN_LEN   253
#define DNS_PORT                     53
#define DNS_ADBLOCK_PSRAM_BUFFER_SIZE (2 * 1024 * 1024)
#define DNS_ADBLOCK_LOG_CAPACITY     64

typedef enum {
    DNS_ADBLOCK_ACTION_BLOCK = 0,
    DNS_ADBLOCK_ACTION_ALLOW = 1,
    DNS_ADBLOCK_ACTION_LOG_ONLY = 2,
} dns_adblock_action_t;

typedef enum {
    DNS_ADBLOCK_LIST_TYPE_ADS = 0,
    DNS_ADBLOCK_LIST_TYPE_TRACKING = 1,
    DNS_ADBLOCK_LIST_TYPE_MALWARE = 2,
    DNS_ADBLOCK_LIST_TYPE_CUSTOM = 3,
} dns_adblock_list_type_t;

typedef struct {
    char url[DNS_ADBLOCK_MAX_LIST_URL_LEN];
    dns_adblock_list_type_t type;
    bool enabled;
    char last_updated[32];
    uint32_t entry_count;
} dns_adblock_list_info_t;

typedef struct {
    uint32_t total_queries;
    uint32_t blocked_queries;
    uint32_t allowed_queries;
    uint32_t failed_queries;
    uint32_t cached_entries;
    uint32_t psram_used_bytes;
    uint32_t psram_free_bytes;
    bool running;
    char last_error[128];
} dns_adblock_stats_t;

typedef struct {
    bool enabled;
    uint16_t port;
    char upstream_dns[64];
    uint32_t cache_ttl_seconds;
    bool log_queries;
    dns_adblock_action_t default_action;
    char custom_blocklist_path[128];
    char custom_allowlist_path[128];
} dns_adblock_config_t;

typedef struct {
    char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    bool blocked;
    uint32_t hit_count;
    bool regex;
} dns_adblock_domain_rule_t;

typedef enum {
    DNS_ADBLOCK_LOG_ALLOWED = 0,
    DNS_ADBLOCK_LOG_BLOCKED = 1,
    DNS_ADBLOCK_LOG_FAILED = 2,
} dns_adblock_log_status_t;

typedef struct {
    uint64_t timestamp_ms;
    char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    char client_ip[16];
    dns_adblock_log_status_t status;
    bool timestamp_valid;
} dns_adblock_log_entry_t;

typedef struct {
    uint64_t total_queries;
    uint32_t allowed;
    uint32_t blocked;
    uint32_t failed;
    uint32_t hourly_allowed[24];
    uint32_t hourly_blocked[24];
    uint32_t hourly_failed[24];
} dns_adblock_daily_summary_t;

esp_err_t dns_adblock_init(void);
esp_err_t dns_adblock_start(void);
esp_err_t dns_adblock_stop(void);
esp_err_t dns_adblock_deinit(void);

esp_err_t dns_adblock_get_config(dns_adblock_config_t *config);
esp_err_t dns_adblock_set_config(const dns_adblock_config_t *config);
esp_err_t dns_adblock_set_fallback_dns(const char *address);
esp_err_t dns_adblock_save_config_to_usb(void);
esp_err_t dns_adblock_load_config_from_usb(void);
esp_err_t dns_adblock_save_rules_to_usb(void);
esp_err_t dns_adblock_load_rules_from_usb(void);

esp_err_t dns_adblock_add_blocklist(const char *url, dns_adblock_list_type_t type);
esp_err_t dns_adblock_remove_blocklist(size_t index);
esp_err_t dns_adblock_enable_blocklist(size_t index, bool enable);
esp_err_t dns_adblock_update_blocklists(void);
esp_err_t dns_adblock_get_blocklists(dns_adblock_list_info_t *lists, size_t max_lists, size_t *count);
esp_err_t dns_adblock_save_blocklists_to_usb(void);
esp_err_t dns_adblock_load_blocklists_from_usb(void);

esp_err_t dns_adblock_add_domain(const char *domain, bool block);
esp_err_t dns_adblock_add_regex(const char *pattern, bool block);
esp_err_t dns_adblock_remove_domain(const char *domain);
esp_err_t dns_adblock_remove_regex(const char *pattern);
esp_err_t dns_adblock_list_domains(dns_adblock_domain_rule_t *rules, size_t max_rules,
                                   size_t *count, size_t *total);
esp_err_t dns_adblock_list_domains_page(dns_adblock_domain_rule_t *rules, size_t max_rules,
                                        size_t offset, int blocked_filter,
                                        size_t *count, size_t *total);
bool dns_adblock_check_domain(const char *domain);

esp_err_t dns_adblock_get_stats(dns_adblock_stats_t *stats);
esp_err_t dns_adblock_clear_stats(void);
esp_err_t dns_adblock_get_log(dns_adblock_log_entry_t *entries, size_t max_entries,
                              size_t *count);
esp_err_t dns_adblock_get_log_for_date(const char *date, dns_adblock_log_entry_t *entries,
                                       size_t max_entries, size_t *count);
esp_err_t dns_adblock_get_daily_summary(const char *date, dns_adblock_daily_summary_t *summary);

esp_err_t dns_adblock_export_log(char *output, size_t max_len, int max_entries);
esp_err_t dns_adblock_clear_log(void);

esp_err_t dns_adblock_flush_daily_log_to_usb(void);

bool dns_adblock_is_running(void);
const char *dns_adblock_get_version(void);

#ifdef __cplusplus
}
#endif

#endif // DNS_ADBLOCK_H