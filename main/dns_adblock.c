/*
 * DNS Ad-Blocker Implementation (Pi-Hole Style)
 * Implements a simple DNS server with blocklist filtering using PSRAM
 */

#include "dns_adblock.h"
#include <stdio.h>
#include <string.h>
#include <stdlib.h>
#include <errno.h>
#include <ctype.h>
#include <regex.h>
#include <unistd.h>
#include <dirent.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <time.h>
#include <lwip/inet.h>
#include <lwip/sockets.h>
#include <lwip/netdb.h>
#include "esp_log.h"
#include "esp_heap_caps.h"
#include "esp_timer.h"
#include "esp_http_client.h"
#include "esp_crt_bundle.h"
#include "esp_littlefs.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/semphr.h"
#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "cJSON.h"

static const char *TAG = "DNS_ADBLOCK";

#define DNS_HEADER_SIZE 12
#define DNS_ADBLOCK_MAX_REGEX_RULES 32
#define DNS_ADBLOCK_TASK_STACK_SIZE 12288
#define DNS_DAILY_FLUSH_TASK_STACK_SIZE 16384
#define DNS_ADBLOCK_STORAGE_DIR "/storage/dns"
#define DNS_ADBLOCK_CONFIG_PATH DNS_ADBLOCK_STORAGE_DIR "/config.json"
#define DNS_ADBLOCK_RULES_PATH DNS_ADBLOCK_STORAGE_DIR "/domains.txt"
#define DNS_ADBLOCK_HISTORY_FILE_FORMAT DNS_ADBLOCK_STORAGE_DIR "/history-%s.tsv"
#define DNS_ADBLOCK_LISTS_PATH DNS_ADBLOCK_STORAGE_DIR "/adlists.txt"
#define DNS_ADBLOCK_LEGACY_USB_DIR "/usb/system/dns"
#define DNS_ADBLOCK_LEGACY_HISTORY_FILE_FORMAT DNS_ADBLOCK_LEGACY_USB_DIR "/history-%s.tsv"

typedef struct {
    uint16_t id;
    uint16_t flags;
    uint16_t qdcount;
    uint16_t ancount;
    uint16_t nscount;
    uint16_t arcount;
} dns_header_t;

typedef struct {
    char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    bool blocked;
    uint32_t hit_count;
    bool regex;
    bool user_defined;
    uint16_t blocklist_mask;
    regex_t compiled_regex;
} dns_cache_entry_t;

static SemaphoreHandle_t s_mutex = NULL;
static TaskHandle_t s_dns_task = NULL;
static bool s_running = false;
static dns_adblock_config_t s_config;
static char s_fallback_dns[64];
static dns_adblock_list_info_t s_lists[DNS_ADBLOCK_MAX_LIST_URLS];
static size_t s_list_count = 0;
static dns_adblock_stats_t s_stats;
static dns_cache_entry_t *s_psram_cache = NULL;
static uint32_t s_cache_count = 0;
static uint32_t s_cache_capacity = 0;
static bool s_initialized = false;
static dns_adblock_log_entry_t s_query_log[DNS_ADBLOCK_LOG_CAPACITY];
static size_t s_query_log_head = 0;
static size_t s_query_log_count = 0;
static SemaphoreHandle_t s_log_storage_mutex = NULL;
static TaskHandle_t s_daily_flush_task = NULL;
static TaskHandle_t s_dns_watchdog_task = NULL;
static bool s_history_write_error_reported;

static esp_err_t ensure_dns_storage_directory(void) {
    if (!esp_littlefs_mounted("storage")) return ESP_ERR_INVALID_STATE;
    if (mkdir(DNS_ADBLOCK_STORAGE_DIR, 0755) != 0 && errno != EEXIST) return ESP_FAIL;
    return ESP_OK;
}

static esp_err_t append_history_entry(const dns_adblock_log_entry_t *entry) {
    if (!entry || !entry->timestamp_valid || !s_log_storage_mutex) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_log_storage_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }
    esp_err_t err = ensure_dns_storage_directory();
    char path[128];
    time_t seconds = (time_t)(entry->timestamp_ms / 1000ULL) + 8 * 3600;
    struct tm utc8_time;
    char date[11];
    if (err == ESP_OK &&
        (!gmtime_r(&seconds, &utc8_time) ||
         strftime(date, sizeof(date), "%Y-%m-%d", &utc8_time) != 10)) {
        err = ESP_FAIL;
    }
    if (err == ESP_OK) {
        int path_len = snprintf(path, sizeof(path), DNS_ADBLOCK_HISTORY_FILE_FORMAT, date);
        if (path_len <= 0 || (size_t)path_len >= sizeof(path)) err = ESP_ERR_INVALID_SIZE;
    }
    FILE *file = err == ESP_OK ? fopen(path, "a") : NULL;
    if (err == ESP_OK && !file) err = ESP_FAIL;
    if (err == ESP_OK) {
        bool write_ok = fprintf(file, "%llu\t%d\t%s\t%s\n",
                                (unsigned long long)(entry->timestamp_ms / 1000ULL),
                                (int)entry->status, entry->client_ip, entry->domain) > 0 &&
                        fflush(file) == 0;
        bool close_ok = fclose(file) == 0;
        if (!write_ok || !close_ok) err = ESP_FAIL;
    }
    xSemaphoreGive(s_log_storage_mutex);
    if (err == ESP_OK) {
        s_history_write_error_reported = false;
    } else if (!s_history_write_error_reported) {
        ESP_LOGE(TAG, "Unable to append DNS history to internal LittleFS: %s",
                 esp_err_to_name(err));
        s_history_write_error_reported = true;
    }
    return err;
}

static FILE *open_history_file(const char *date) {
    char path[128];
    int path_len = snprintf(path, sizeof(path), DNS_ADBLOCK_HISTORY_FILE_FORMAT, date);
    if (path_len <= 0 || (size_t)path_len >= sizeof(path)) return NULL;
    FILE *file = fopen(path, "r");
    if (file || errno != ENOENT || !usb_host_msc_is_mounted()) return file;

    char legacy_logical_path[160];
    char legacy_path[MAP_PATH_MAX];
    path_len = snprintf(legacy_logical_path, sizeof(legacy_logical_path),
                        DNS_ADBLOCK_LEGACY_HISTORY_FILE_FORMAT, date);
    if (path_len <= 0 || (size_t)path_len >= sizeof(legacy_logical_path) ||
        usb_storage_map_resolve(legacy_logical_path, legacy_path,
                                sizeof(legacy_path)) != ESP_OK) return NULL;
    return fopen(legacy_path, "r");
}

static bool is_valid_domain_char(char c);

static esp_err_t add_rule(const char *pattern, bool block, bool is_regex, int blocklist_index) {
    if (!pattern || !s_psram_cache) return ESP_ERR_INVALID_ARG;
    size_t pattern_length = strnlen(pattern, DNS_ADBLOCK_MAX_DOMAIN_LEN);
    if (pattern_length == 0 || pattern_length >= DNS_ADBLOCK_MAX_DOMAIN_LEN) {
        return ESP_ERR_INVALID_ARG;
    }

    regex_t compiled_regex;
    memset(&compiled_regex, 0, sizeof(compiled_regex));
    if (is_regex) {
        for (size_t i = 0; i < pattern_length; i++) {
            if ((unsigned char)pattern[i] < 0x20 || (unsigned char)pattern[i] == 0x7f) {
                return ESP_ERR_INVALID_ARG;
            }
        }
        if (regcomp(&compiled_regex, pattern, REG_EXTENDED | REG_ICASE | REG_NOSUB) != 0) {
            return ESP_ERR_INVALID_ARG;
        }
    } else {
        if (pattern[0] == '.' || pattern[pattern_length - 1] == '.') return ESP_ERR_INVALID_ARG;
        for (size_t i = 0; i < pattern_length; i++) {
            if (!is_valid_domain_char(pattern[i])) return ESP_ERR_INVALID_ARG;
        }
    }

    char normalized[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    strlcpy(normalized, pattern, sizeof(normalized));
    if (!is_regex) {
        for (char *p = normalized; *p; p++) *p = (char)tolower((unsigned char)*p);
    }

    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) {
        if (is_regex) regfree(&compiled_regex);
        return ESP_ERR_TIMEOUT;
    }
    size_t regex_count = 0;
    for (uint32_t i = 0; i < s_cache_count; i++) {
        if (s_psram_cache[i].regex) regex_count++;
        if (s_psram_cache[i].regex == is_regex &&
            strcmp(s_psram_cache[i].domain, normalized) == 0) {
            if (is_regex) {
                regfree(&s_psram_cache[i].compiled_regex);
                s_psram_cache[i].compiled_regex = compiled_regex;
            }
            if (blocklist_index >= 0) {
                s_psram_cache[i].blocklist_mask |= (uint16_t)(1U << blocklist_index);
                if (!s_psram_cache[i].user_defined) s_psram_cache[i].blocked = block;
            } else {
                s_psram_cache[i].blocked = block;
                s_psram_cache[i].user_defined = true;
            }
            xSemaphoreGive(s_mutex);
            return ESP_OK;
        }
    }
    if (s_cache_count >= s_cache_capacity ||
        (is_regex && regex_count >= DNS_ADBLOCK_MAX_REGEX_RULES)) {
        xSemaphoreGive(s_mutex);
        if (is_regex) regfree(&compiled_regex);
        return ESP_ERR_NO_MEM;
    }

    dns_cache_entry_t *entry = &s_psram_cache[s_cache_count++];
    memset(entry, 0, sizeof(*entry));
    strlcpy(entry->domain, normalized, sizeof(entry->domain));
    entry->blocked = block;
    entry->regex = is_regex;
    entry->user_defined = blocklist_index < 0;
    if (blocklist_index >= 0) entry->blocklist_mask = (uint16_t)(1U << blocklist_index);
    if (is_regex) entry->compiled_regex = compiled_regex;
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

static void load_default_config(void) {
    memset(&s_config, 0, sizeof(s_config));
    s_config.enabled = true;
    s_config.port = DNS_PORT;
    strcpy(s_config.upstream_dns, "8.8.8.8");
    s_config.cache_ttl_seconds = 300;
    s_config.log_queries = true;
    s_config.default_action = DNS_ADBLOCK_ACTION_ALLOW;
    strcpy(s_config.custom_blocklist_path, DNS_ADBLOCK_STORAGE_DIR "/blocklist.txt");
    strcpy(s_config.custom_allowlist_path, DNS_ADBLOCK_STORAGE_DIR "/allowlist.txt");
}

static void init_stats(void) {
    memset(&s_stats, 0, sizeof(s_stats));
    s_stats.running = s_running;
    s_stats.last_error[0] = '\0';
}

static void restore_daily_stats(void) {
    time_t now = time(NULL) + 8 * 3600;
    struct tm utc8_time;
    char date[11];
    if (now < 1704067200 || !gmtime_r(&now, &utc8_time) ||
        strftime(date, sizeof(date), "%Y-%m-%d", &utc8_time) != 10) return;
    dns_adblock_daily_summary_t summary;
    if (dns_adblock_get_daily_summary(date, &summary) != ESP_OK) return;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return;
    s_stats.total_queries = summary.total_queries > UINT32_MAX
        ? UINT32_MAX : (uint32_t)summary.total_queries;
    s_stats.allowed_queries = summary.allowed;
    s_stats.blocked_queries = summary.blocked;
    s_stats.failed_queries = summary.failed;
    xSemaphoreGive(s_mutex);
}

static void record_query(const char *domain, const char *client_ip, bool blocked,
                         const char *failure_reason) {
    if (!s_mutex || xSemaphoreTake(s_mutex, pdMS_TO_TICKS(50)) != pdTRUE) return;

    bool failed = failure_reason != NULL;
    bool should_log = s_config.log_queries;
    dns_adblock_log_entry_t history_entry = {0};
    s_stats.total_queries++;
    if (failed) s_stats.failed_queries++;
    else if (blocked) s_stats.blocked_queries++;
    else s_stats.allowed_queries++;
    if (failed) strlcpy(s_stats.last_error, failure_reason, sizeof(s_stats.last_error));

    if (should_log) {
        struct timeval now;
        gettimeofday(&now, NULL);
        history_entry.timestamp_valid = now.tv_sec >= 1704067200;
        history_entry.timestamp_ms = history_entry.timestamp_valid
            ? (uint64_t)now.tv_sec * 1000ULL + (uint64_t)now.tv_usec / 1000ULL
            : (uint64_t)(esp_timer_get_time() / 1000);
        strlcpy(history_entry.domain, domain, sizeof(history_entry.domain));
        strlcpy(history_entry.client_ip, client_ip, sizeof(history_entry.client_ip));
        history_entry.status = failed ? DNS_ADBLOCK_LOG_FAILED :
            (blocked ? DNS_ADBLOCK_LOG_BLOCKED : DNS_ADBLOCK_LOG_ALLOWED);
        s_query_log[s_query_log_head] = history_entry;
        s_query_log_head = (s_query_log_head + 1) % DNS_ADBLOCK_LOG_CAPACITY;
        if (s_query_log_count < DNS_ADBLOCK_LOG_CAPACITY) s_query_log_count++;
    }
    xSemaphoreGive(s_mutex);
    if (should_log) (void)append_history_entry(&history_entry);
}

static void send_servfail(int server, uint8_t *packet, size_t question_end,
                          const struct sockaddr_in *client, socklen_t client_length) {
    packet[2] = (uint8_t)((packet[2] & 0x79) | 0x80);
    packet[3] = 0x82;
    packet[4] = 0;
    packet[5] = 1;
    memset(packet + 6, 0, 6);
    sendto(server, packet, question_end, 0,
           (const struct sockaddr *)client, client_length);
}

static int exchange_dns_query(int upstream, const struct sockaddr_in *endpoint,
                              const uint8_t *query, size_t query_length,
                              uint8_t *response, size_t response_size) {
    if (sendto(upstream, query, query_length, 0,
               (const struct sockaddr *)endpoint, sizeof(*endpoint)) < 0) return -1;

    int64_t deadline_us = esp_timer_get_time() + 2000000;
    while (true) {
        int64_t remaining_us = deadline_us - esp_timer_get_time();
        if (remaining_us <= 0) return 0;

        fd_set upstream_set;
        FD_ZERO(&upstream_set);
        FD_SET(upstream, &upstream_set);
        struct timeval timeout = {
            .tv_sec = (long)(remaining_us / 1000000),
            .tv_usec = (long)(remaining_us % 1000000),
        };
        int ready = select(upstream + 1, &upstream_set, NULL, NULL, &timeout);
        if (ready == 0) return 0;
        if (ready < 0) return -1;

        struct sockaddr_in responder = {0};
        socklen_t responder_length = sizeof(responder);
        int response_length = recvfrom(upstream, response, response_size, 0,
                                       (struct sockaddr *)&responder, &responder_length);
        if (response_length < 0) return -1;
        if (response_length < DNS_HEADER_SIZE ||
            responder.sin_addr.s_addr != endpoint->sin_addr.s_addr ||
            responder.sin_port != endpoint->sin_port ||
            response[0] != query[0] || response[1] != query[1] ||
            (response[2] & 0x80) == 0) continue;
        return response_length;
    }
}

static void daily_flush_task(void *arg) {
    (void)arg;
    while (true) {
        if (usb_host_msc_is_ready()) {
            esp_err_t err = dns_adblock_flush_daily_log_to_usb();
            if (err == ESP_OK) {
                ESP_LOGI(TAG, "[Event ID: 2001] Archived a completed DNS history day to USB; stack remaining=%u bytes",
                         (unsigned)uxTaskGetStackHighWaterMark(NULL));
            } else if (err != ESP_ERR_NOT_FOUND) {
                ESP_LOGW(TAG, "[Event ID: 2002] Daily DNS history archive failed: %s; retaining LittleFS data",
                         esp_err_to_name(err));
                UBaseType_t stack_remaining = uxTaskGetStackHighWaterMark(NULL);
                if (stack_remaining < 2048) {
                    ESP_LOGW(TAG, "Daily DNS flush task stack is low: %u bytes remaining",
                             (unsigned)stack_remaining);
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(60000));
    }
}

static bool is_valid_domain_char(char c) {
    return isalnum((unsigned char)c) || c == '-' || c == '.' || c == '_';
}

esp_err_t dns_adblock_init(void) {
    if (s_initialized) return ESP_OK;
    
    s_mutex = xSemaphoreCreateMutex();
    if (!s_mutex) return ESP_ERR_NO_MEM;
    s_log_storage_mutex = xSemaphoreCreateMutex();
    if (!s_log_storage_mutex) {
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
        return ESP_ERR_NO_MEM;
    }
    
    // Allocate PSRAM for domain cache
    size_t free_psram = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
    size_t reserve = free_psram > (2U * 1024U * 1024U) ? (2U * 1024U * 1024U) : free_psram / 4;
    size_t capacity = (free_psram - reserve) / sizeof(dns_cache_entry_t);
    if (capacity > DNS_ADBLOCK_MAX_DOMAINS) capacity = DNS_ADBLOCK_MAX_DOMAINS;
    while (capacity > 0 && !s_psram_cache) {
        s_psram_cache = heap_caps_malloc(sizeof(dns_cache_entry_t) * capacity,
                                         MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
        if (!s_psram_cache) capacity = capacity * 3 / 4;
    }
    s_cache_capacity = (uint32_t)capacity;
    if (!s_psram_cache) {
        ESP_LOGW(TAG, "Failed to allocate PSRAM for domain cache");
    } else {
        ESP_LOGI(TAG, "DNS rule cache capacity: %u", (unsigned)s_cache_capacity);
    }
    
    load_default_config();
    init_stats();
    memset(s_lists, 0, sizeof(s_lists));
    s_list_count = 0;
    s_cache_count = 0;
    
    s_initialized = true;
    static const char *starter_rules[] = {
        "doubleclick.net",
        "googlesyndication.com",
        "googleadservices.com",
        "adservice.google.com",
        "adnxs.com",
        "adsrvr.org",
        "scorecardresearch.com",
        "taboola.com",
        "outbrain.com",
        "criteo.com",
    };
    for (size_t i = 0; i < sizeof(starter_rules) / sizeof(starter_rules[0]); i++) {
        dns_adblock_add_domain(starter_rules[i], true);
    }

    if (xTaskCreateWithCaps(daily_flush_task, "dns_daily_flush",
                            DNS_DAILY_FLUSH_TASK_STACK_SIZE, NULL, 1,
                            &s_daily_flush_task,
                            MALLOC_CAP_INTERNAL | MALLOC_CAP_8BIT) != pdPASS) {
        ESP_LOGW(TAG, "Failed to create daily flush task");
        s_daily_flush_task = NULL;
    } else {
        ESP_LOGI(TAG, "Daily DNS log flush task started with %u-byte internal stack",
                 (unsigned)DNS_DAILY_FLUSH_TASK_STACK_SIZE);
    }

    ESP_LOGI(TAG, "DNS Ad-blocker initialized (uses PSRAM)");
    return ESP_OK;
}

bool dns_adblock_check_domain(const char *domain) {
    if (!domain || !s_psram_cache || strnlen(domain, DNS_ADBLOCK_MAX_DOMAIN_LEN) >= DNS_ADBLOCK_MAX_DOMAIN_LEN) {
        return s_config.default_action == DNS_ADBLOCK_ACTION_BLOCK;
    }
    
    char d[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    strcpy(d, domain);
    // Convert to lowercase
    for (char *p = d; *p; p++) *p = tolower(*p);
    
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        size_t best_match_rank = 0;
        bool matched = false;
        bool blocked = false;
        for (uint32_t i = 0; i < s_cache_count; i++) {
            size_t rule_length = strlen(s_psram_cache[i].domain);
            bool matches;
            size_t match_rank;
            if (s_psram_cache[i].regex) {
                matches = regexec(&s_psram_cache[i].compiled_regex, d, 0, NULL, 0) == 0;
                match_rank = 1;
            } else {
                size_t domain_length = strlen(d);
                matches = strcmp(s_psram_cache[i].domain, d) == 0 ||
                    (domain_length > rule_length && d[domain_length - rule_length - 1] == '.' &&
                     strcmp(d + domain_length - rule_length, s_psram_cache[i].domain) == 0);
                match_rank = rule_length + 1;
            }
            if (matches) {
                s_psram_cache[i].hit_count++;
                if (match_rank >= best_match_rank) {
                    best_match_rank = match_rank;
                    blocked = s_psram_cache[i].blocked;
                    matched = true;
                }
            }
        }
        xSemaphoreGive(s_mutex);
        if (matched) return blocked;
    }
    return s_config.default_action == DNS_ADBLOCK_ACTION_BLOCK;
}

esp_err_t dns_adblock_add_domain(const char *domain, bool block) {
    return add_rule(domain, block, false, -1);
}

esp_err_t dns_adblock_add_regex(const char *pattern, bool block) {
    return add_rule(pattern, block, true, -1);
}

esp_err_t dns_adblock_load_config_from_usb(void) {
    esp_err_t err = ensure_dns_storage_directory();
    if (err != ESP_OK) return err;
    FILE *f = fopen(DNS_ADBLOCK_CONFIG_PATH, "rb");
    bool migrated = false;
    if (!f && errno == ENOENT && usb_host_msc_is_mounted()) {
        char legacy_path[MAP_PATH_MAX];
        if (usb_storage_map_resolve(DNS_ADBLOCK_LEGACY_USB_DIR "/config.json",
                                    legacy_path, sizeof(legacy_path)) == ESP_OK) {
            f = fopen(legacy_path, "rb");
            migrated = f != NULL;
        }
    }
    if (!f) return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    
    char buf[512];
    size_t len = fread(buf, 1, sizeof(buf) - 1, f);
    bool read_failed = ferror(f) != 0;
    fclose(f);
    if (read_failed) return ESP_FAIL;
    buf[len] = '\0';
    cJSON *root = cJSON_Parse(buf);
    if (!root) return ESP_ERR_INVALID_RESPONSE;
    dns_adblock_config_t config;
    dns_adblock_get_config(&config);
    cJSON *item = cJSON_GetObjectItemCaseSensitive(root, "enabled");
    if (cJSON_IsBool(item)) config.enabled = cJSON_IsTrue(item);
    item = cJSON_GetObjectItemCaseSensitive(root, "port");
    if (cJSON_IsNumber(item) && item->valueint > 0 && item->valueint <= UINT16_MAX) config.port = (uint16_t)item->valueint;
    item = cJSON_GetObjectItemCaseSensitive(root, "upstream_dns");
    if (cJSON_IsString(item) && strlen(item->valuestring) < sizeof(config.upstream_dns)) {
        strlcpy(config.upstream_dns, item->valuestring, sizeof(config.upstream_dns));
    }
    item = cJSON_GetObjectItemCaseSensitive(root, "cache_ttl_seconds");
    if (cJSON_IsNumber(item) && item->valueint >= 0) config.cache_ttl_seconds = (uint32_t)item->valueint;
    item = cJSON_GetObjectItemCaseSensitive(root, "log_queries");
    if (cJSON_IsBool(item)) config.log_queries = cJSON_IsTrue(item);
    item = cJSON_GetObjectItemCaseSensitive(root, "default_action");
    if (cJSON_IsNumber(item) && item->valueint >= DNS_ADBLOCK_ACTION_BLOCK &&
        item->valueint <= DNS_ADBLOCK_ACTION_LOG_ONLY) config.default_action = (dns_adblock_action_t)item->valueint;
    cJSON_Delete(root);
    err = dns_adblock_set_config(&config);
    if (err == ESP_OK && migrated) err = dns_adblock_save_config_to_usb();
    return err;
}

esp_err_t dns_adblock_save_config_to_usb(void) {
    esp_err_t err = ensure_dns_storage_directory();
    if (err != ESP_OK) return err;
    char temporary_path[sizeof(DNS_ADBLOCK_CONFIG_PATH) + 8];
    int path_len = snprintf(temporary_path, sizeof(temporary_path), "%s.tmp",
                            DNS_ADBLOCK_CONFIG_PATH);
    if (path_len <= 0 || (size_t)path_len >= sizeof(temporary_path)) return ESP_ERR_INVALID_SIZE;
    FILE *f = fopen(temporary_path, "w");
    if (!f) return ESP_FAIL;
    
    dns_adblock_config_t config;
    esp_err_t config_err = dns_adblock_get_config(&config);
    if (config_err != ESP_OK) { fclose(f); remove(temporary_path); return config_err; }
    cJSON *root = cJSON_CreateObject();
    if (!root) { fclose(f); remove(temporary_path); return ESP_ERR_NO_MEM; }
    cJSON_AddBoolToObject(root, "enabled", config.enabled);
    cJSON_AddNumberToObject(root, "port", config.port);
    cJSON_AddStringToObject(root, "upstream_dns", config.upstream_dns);
    cJSON_AddNumberToObject(root, "cache_ttl_seconds", config.cache_ttl_seconds);
    cJSON_AddBoolToObject(root, "log_queries", config.log_queries);
    cJSON_AddNumberToObject(root, "default_action", config.default_action);
    char *json = cJSON_PrintUnformatted(root);
    bool saved = json && fputs(json, f) >= 0 && fflush(f) == 0;
    bool closed = fclose(f) == 0;
    if (json) cJSON_free(json);
    cJSON_Delete(root);
    if (!saved || !closed || rename(temporary_path, DNS_ADBLOCK_CONFIG_PATH) != 0) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t dns_adblock_save_rules_to_usb(void) {
    esp_err_t err = ensure_dns_storage_directory();
    if (err != ESP_OK) return err;
    char temporary_path[sizeof(DNS_ADBLOCK_RULES_PATH) + 8];
    int path_len = snprintf(temporary_path, sizeof(temporary_path), "%s.tmp",
                            DNS_ADBLOCK_RULES_PATH);
    if (path_len <= 0 || (size_t)path_len >= sizeof(temporary_path)) return ESP_ERR_INVALID_SIZE;
    FILE *file = fopen(temporary_path, "w");
    if (!file) return ESP_FAIL;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(200)) != pdTRUE) {
        fclose(file);
        return ESP_ERR_TIMEOUT;
    }
    bool saved = true;
    for (uint32_t i = 0; i < s_cache_count; i++) {
        if (!s_psram_cache[i].user_defined) continue;
        const char *action = s_psram_cache[i].blocked
            ? (s_psram_cache[i].regex ? "block-regex" : "block")
            : (s_psram_cache[i].regex ? "allow-regex" : "allow");
        if (fprintf(file, "%s %s\n", action,
                    s_psram_cache[i].domain) < 0) {
            saved = false;
            break;
        }
    }
    xSemaphoreGive(s_mutex);
    if (fflush(file) != 0) saved = false;
    if (fclose(file) != 0) saved = false;
    if (!saved || rename(temporary_path, DNS_ADBLOCK_RULES_PATH) != 0) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t dns_adblock_load_rules_from_usb(void) {
    esp_err_t err = ensure_dns_storage_directory();
    if (err != ESP_OK) return err;
    FILE *file = fopen(DNS_ADBLOCK_RULES_PATH, "r");
    bool migrated = false;
    if (!file && errno == ENOENT && usb_host_msc_is_mounted()) {
        char legacy_path[MAP_PATH_MAX];
        if (usb_storage_map_resolve(DNS_ADBLOCK_LEGACY_USB_DIR "/domains.txt",
                                    legacy_path, sizeof(legacy_path)) == ESP_OK) {
            file = fopen(legacy_path, "r");
            migrated = file != NULL;
        }
    }
    if (!file) return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    char line[DNS_ADBLOCK_MAX_DOMAIN_LEN + 24];
    while (fgets(line, sizeof(line), file)) {
        line[strcspn(line, "\r\n")] = '\0';
        char *domain = NULL;
        bool block = false;
        bool is_regex = false;
        if (strncmp(line, "block ", 6) == 0) { domain = line + 6; block = true; }
        else if (strncmp(line, "allow ", 6) == 0) { domain = line + 6; }
        else if (strncmp(line, "block-regex ", 12) == 0) { domain = line + 12; block = true; is_regex = true; }
        else if (strncmp(line, "allow-regex ", 12) == 0) { domain = line + 12; is_regex = true; }
        if (domain && domain[0]) {
            esp_err_t add_err = is_regex
                ? dns_adblock_add_regex(domain, block)
                : dns_adblock_add_domain(domain, block);
            if (add_err != ESP_OK) ESP_LOGW(TAG, "Ignoring invalid DNS rule: %s", domain);
        }
    }
    bool read_failed = ferror(file) != 0;
    fclose(file);
    if (read_failed) return ESP_FAIL;
    return migrated ? dns_adblock_save_rules_to_usb() : ESP_OK;
}

esp_err_t dns_adblock_get_config(dns_adblock_config_t *config) {
    if (!config) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(config, &s_config, sizeof(s_config));
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

esp_err_t dns_adblock_set_config(const dns_adblock_config_t *config) {
    if (!config || config->port == 0 || !config->upstream_dns[0] ||
        strnlen(config->upstream_dns, sizeof(config->upstream_dns)) >= sizeof(config->upstream_dns) ||
        config->default_action < DNS_ADBLOCK_ACTION_BLOCK ||
        config->default_action > DNS_ADBLOCK_ACTION_LOG_ONLY) return ESP_ERR_INVALID_ARG;
    struct in_addr upstream_address;
    if (inet_aton(config->upstream_dns, &upstream_address) == 0) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        memcpy(&s_config, config, sizeof(s_config));
        s_stats.running = s_running;
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

esp_err_t dns_adblock_set_fallback_dns(const char *address) {
    if (!address || strnlen(address, sizeof(s_fallback_dns)) >= sizeof(s_fallback_dns)) {
        return ESP_ERR_INVALID_ARG;
    }
    struct in_addr fallback_address;
    if (inet_aton(address, &fallback_address) == 0) return ESP_ERR_INVALID_ARG;
    if (!s_mutex || xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    strlcpy(s_fallback_dns, address, sizeof(s_fallback_dns));
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t dns_adblock_get_stats(dns_adblock_stats_t *stats) {
    if (!stats) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        s_stats.psram_used_bytes = s_cache_count * sizeof(dns_cache_entry_t);
        s_stats.psram_free_bytes = heap_caps_get_free_size(MALLOC_CAP_SPIRAM);
        s_stats.cached_entries = s_cache_count;
        s_stats.running = s_running;
        memcpy(stats, &s_stats, sizeof(s_stats));
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

bool dns_adblock_is_running(void) {
    return s_running;
}

const char *dns_adblock_get_version(void) {
    return "1.0.0";
}

static void dns_task_set_error(const char *operation, int error_code) {
    char message[sizeof(s_stats.last_error)];
    if (error_code != 0) {
        snprintf(message, sizeof(message), "%s (errno %d)", operation, error_code);
    } else {
        strlcpy(message, operation, sizeof(message));
    }

    if (s_mutex && xSemaphoreTake(s_mutex, portMAX_DELAY) == pdTRUE) {
        strlcpy(s_stats.last_error, message, sizeof(s_stats.last_error));
        s_running = false;
        s_stats.running = false;
        s_dns_task = NULL;
        xSemaphoreGive(s_mutex);
    }
    ESP_LOGE(TAG, "%s", message);
}

void dns_adblock_task(void *arg) {
    (void)arg;
    int server = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (server < 0) {
        dns_task_set_error("Unable to create DNS socket", errno);
        vTaskDelete(NULL);
        return;
    }
    struct sockaddr_in address = {0};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_ANY);
    address.sin_port = htons(s_config.port);
    if (bind(server, (struct sockaddr *)&address, sizeof(address)) != 0) {
        int bind_error = errno;
        close(server);
        char operation[64];
        snprintf(operation, sizeof(operation), "Unable to bind DNS UDP port %u", s_config.port);
        dns_task_set_error(operation, bind_error);
        vTaskDelete(NULL);
        return;
    }
    int upstream_sockets[2] = {-1, -1};
    upstream_sockets[0] = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (upstream_sockets[0] < 0) {
        int socket_error = errno;
        close(server);
        dns_task_set_error("Unable to create upstream DNS socket", socket_error);
        vTaskDelete(NULL);
        return;
    }
    upstream_sockets[1] = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    size_t next_upstream_socket = 0;
    uint16_t upstream_query_id = 0;

    uint8_t packet[1500];
    while (s_running) {
        fd_set read_set;
        FD_ZERO(&read_set);
        FD_SET(server, &read_set);
        struct timeval timeout = {.tv_sec = 1, .tv_usec = 0};
        if (select(server + 1, &read_set, NULL, NULL, &timeout) <= 0) continue;

        struct sockaddr_in client = {0};
        socklen_t client_length = sizeof(client);
        int received = recvfrom(server, packet, sizeof(packet), 0,
                                (struct sockaddr *)&client, &client_length);
        if (received < DNS_HEADER_SIZE) continue;

        char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
        size_t position = DNS_HEADER_SIZE;
        size_t output = 0;
        bool valid = true;
        while (position < (size_t)received) {
            uint8_t label_length = packet[position++];
            if (label_length == 0) break;
            if ((label_length & 0xc0) != 0 || label_length > 63 ||
                position + label_length > (size_t)received || output + label_length + 1 >= sizeof(domain)) {
                valid = false;
                break;
            }
            if (output != 0) domain[output++] = '.';
            for (uint8_t i = 0; i < label_length; i++) {
                domain[output++] = (char)tolower((unsigned char)packet[position++]);
            }
        }
        if (!valid || position + 4 > (size_t)received || output == 0) continue;
        domain[output] = '\0';
        size_t question_end = position + 4;

        bool blocked = s_config.enabled && dns_adblock_check_domain(domain);
        char client_ip[16];
        strlcpy(client_ip, inet_ntoa(client.sin_addr), sizeof(client_ip));

        if (blocked) {
            packet[2] = (uint8_t)((packet[2] & 0x01) | 0x80);
            packet[3] = 0x83;
            packet[4] = 0;
            packet[5] = 1;
            memset(packet + 6, 0, 6);
            int sent = sendto(server, packet, question_end, 0,
                              (struct sockaddr *)&client, client_length);
            record_query(domain, client_ip, true,
                         sent < 0 ? "Failed to send blocked DNS response" : NULL);
            continue;
        }

        dns_adblock_config_t config;
        if (dns_adblock_get_config(&config) != ESP_OK) {
            send_servfail(server, packet, question_end, &client, client_length);
            record_query(domain, client_ip, false, "Failed to read DNS configuration");
            continue;
        }
        struct in_addr upstream_address;
        if (inet_aton(config.upstream_dns, &upstream_address) == 0) {
            send_servfail(server, packet, question_end, &client, client_length);
            record_query(domain, client_ip, false, "Invalid upstream DNS address");
            continue;
        }
        struct sockaddr_in upstream_endpoint = {0};
        upstream_endpoint.sin_family = AF_INET;
        upstream_endpoint.sin_addr = upstream_address;
        upstream_endpoint.sin_port = htons(53);
        uint8_t upstream_packet[sizeof(packet)];
        memcpy(upstream_packet, packet, (size_t)received);
        upstream_query_id++;
        upstream_packet[0] = (uint8_t)(upstream_query_id >> 8);
        upstream_packet[1] = (uint8_t)upstream_query_id;
        uint8_t response[sizeof(packet)];
        int upstream = upstream_sockets[next_upstream_socket];
        if (upstream_sockets[1] >= 0) next_upstream_socket ^= 1U;
        int response_length = exchange_dns_query(upstream, &upstream_endpoint, upstream_packet,
                                                 (size_t)received, response, sizeof(response));
        struct in_addr fallback_address;
        if (response_length <= 0 && s_fallback_dns[0] &&
            inet_aton(s_fallback_dns, &fallback_address) != 0 &&
            fallback_address.s_addr != upstream_address.s_addr) {
            upstream_endpoint.sin_addr = fallback_address;
            response_length = exchange_dns_query(upstream, &upstream_endpoint, upstream_packet,
                                                 (size_t)received, response, sizeof(response));
        }
        const char *failure_reason = "Configured and router DNS upstreams failed";
        if (response_length > 0) {
            response[0] = packet[0];
            response[1] = packet[1];
            if (sendto(server, response, (size_t)response_length, 0,
                       (struct sockaddr *)&client, client_length) >= 0) {
                failure_reason = NULL;
            } else {
                failure_reason = "Failed to send upstream DNS response to client";
            }
        } else if (response_length < 0) {
            failure_reason = "Failed to send query to DNS upstreams";
        }
        if (failure_reason) send_servfail(server, packet, question_end, &client, client_length);
        record_query(domain, client_ip, false, failure_reason);
    }
    if (upstream_sockets[1] >= 0) close(upstream_sockets[1]);
    close(upstream_sockets[0]);
    close(server);
    s_dns_task = NULL;
    vTaskDelete(NULL);
}

static void dns_watchdog_task(void *arg) {
    (void)arg;
    while (true) {
        vTaskDelay(pdMS_TO_TICKS(5000));
        if (s_running && s_dns_task == NULL) {
            ESP_LOGW(TAG, "DNS task died, restarting...");
            init_stats();
            restore_daily_stats();
            s_stats.running = true;
            if (xTaskCreate(dns_adblock_task, "dns_adblock", DNS_ADBLOCK_TASK_STACK_SIZE,
                            NULL, 5, &s_dns_task) != pdPASS) {
                ESP_LOGE(TAG, "Failed to restart DNS task; internal heap free=%zu, largest block=%zu",
                         heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
                         heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
                s_running = false;
                s_stats.running = false;
            } else {
                ESP_LOGI(TAG, "DNS task restarted");
            }
        }
    }
}

esp_err_t dns_adblock_start(void) {
    if (s_running) return ESP_OK;
    if (!s_initialized) return ESP_ERR_INVALID_STATE;
    if (s_dns_task != NULL) return ESP_ERR_INVALID_STATE;
    esp_err_t storage_err = ensure_dns_storage_directory();
    if (storage_err != ESP_OK) {
        ESP_LOGE(TAG, "DNS resolver cannot start without internal LittleFS storage: %s",
                 esp_err_to_name(storage_err));
        return storage_err;
    }
    init_stats();
    restore_daily_stats();
    s_running = true;
    s_stats.running = true;
    if (xTaskCreate(dns_adblock_task, "dns_adblock", DNS_ADBLOCK_TASK_STACK_SIZE,
                    NULL, 5, &s_dns_task) != pdPASS) {
        if (xSemaphoreTake(s_mutex, portMAX_DELAY) == pdTRUE) {
            s_running = false;
            s_stats.running = false;
            s_dns_task = NULL;
            strlcpy(s_stats.last_error, "Unable to create DNS resolver task (insufficient internal heap)",
                    sizeof(s_stats.last_error));
            xSemaphoreGive(s_mutex);
        }
        ESP_LOGE(TAG, "Failed to create DNS resolver task with %u-byte stack; internal heap free=%zu, largest block=%zu",
             (unsigned)DNS_ADBLOCK_TASK_STACK_SIZE,
             heap_caps_get_free_size(MALLOC_CAP_INTERNAL),
             heap_caps_get_largest_free_block(MALLOC_CAP_INTERNAL));
        return ESP_ERR_NO_MEM;
    }
    if (s_dns_watchdog_task == NULL) {
        xTaskCreate(dns_watchdog_task, "dns_watchdog", 2048, NULL, 1, &s_dns_watchdog_task);
    }
    ESP_LOGI(TAG, "DNS Ad-blocker started (priority 5, watchdog enabled)");
    return ESP_OK;
}

esp_err_t dns_adblock_stop(void) {
    if (!s_running) return ESP_OK;
    s_running = false;
    s_stats.running = false;
    ESP_LOGI(TAG, "DNS Ad-blocker stopped");
    return ESP_OK;
}

esp_err_t dns_adblock_deinit(void) {
    dns_adblock_stop();
    if (s_mutex) {
        if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            for (uint32_t i = 0; i < s_cache_count; i++) {
                if (s_psram_cache[i].regex) regfree(&s_psram_cache[i].compiled_regex);
            }
            xSemaphoreGive(s_mutex);
        }
        vSemaphoreDelete(s_mutex);
        s_mutex = NULL;
    }
    if (s_log_storage_mutex) {
        vSemaphoreDelete(s_log_storage_mutex);
        s_log_storage_mutex = NULL;
    }
    if (s_daily_flush_task) {
        vTaskDeleteWithCaps(s_daily_flush_task);
        s_daily_flush_task = NULL;
    }
    if (s_dns_watchdog_task) {
        vTaskDelete(s_dns_watchdog_task);
        s_dns_watchdog_task = NULL;
    }
    if (s_psram_cache) {
        heap_caps_free(s_psram_cache);
        s_psram_cache = NULL;
    }
    s_cache_capacity = 0;
    s_initialized = false;
    return ESP_OK;
}

esp_err_t dns_adblock_add_blocklist(const char *url, dns_adblock_list_type_t type) {
    if (!url || strncmp(url, "https://", 8) != 0 ||
        strnlen(url, DNS_ADBLOCK_MAX_LIST_URL_LEN) >= DNS_ADBLOCK_MAX_LIST_URL_LEN ||
        type < DNS_ADBLOCK_LIST_TYPE_ADS || type > DNS_ADBLOCK_LIST_TYPE_CUSTOM) {
        return ESP_ERR_INVALID_ARG;
    }
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    for (size_t i = 0; i < s_list_count; i++) {
        if (strcmp(s_lists[i].url, url) == 0) {
            xSemaphoreGive(s_mutex);
            return ESP_OK;
        }
    }
    if (s_list_count >= DNS_ADBLOCK_MAX_LIST_URLS) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_NO_MEM;
    }
    dns_adblock_list_info_t *list = &s_lists[s_list_count++];
    memset(list, 0, sizeof(*list));
    strlcpy(list->url, url, sizeof(list->url));
    list->type = type;
    list->enabled = true;
    strlcpy(list->last_updated, "Never", sizeof(list->last_updated));
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t dns_adblock_get_blocklists(dns_adblock_list_info_t *lists, size_t max_lists, size_t *count) {
    if (!lists || !count) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
        *count = s_list_count < max_lists ? s_list_count : max_lists;
        memcpy(lists, s_lists, *count * sizeof(dns_adblock_list_info_t));
        xSemaphoreGive(s_mutex);
        return ESP_OK;
    }
    return ESP_ERR_TIMEOUT;
}

static esp_err_t add_blocklist_domain(const char *domain, size_t list_index) {
    if (!domain || !domain[0] || list_index >= DNS_ADBLOCK_MAX_LIST_URLS) return ESP_ERR_INVALID_ARG;
    return add_rule(domain, true, false, (int)list_index);
}

static bool blocklist_token_is_address(const char *token) {
    struct in_addr address;
    return inet_aton(token, &address) != 0 || strchr(token, ':') != NULL;
}

static esp_err_t process_blocklist_line(char *line, uint32_t *entry_count, size_t list_index) {
    char *comment = strchr(line, '#');
    if (comment) *comment = '\0';
    char *tokens[32];
    size_t token_count = 0;
    char *cursor = line;
    while (*cursor && token_count < sizeof(tokens) / sizeof(tokens[0])) {
        while (*cursor && isspace((unsigned char)*cursor)) cursor++;
        if (!*cursor) break;
        tokens[token_count++] = cursor;
        while (*cursor && !isspace((unsigned char)*cursor)) cursor++;
        if (*cursor) *cursor++ = '\0';
    }
    if (token_count == 0) return ESP_OK;
    size_t first_domain = blocklist_token_is_address(tokens[0]) ? 1 : 0;
    for (size_t i = first_domain; i < token_count; i++) {
        size_t length = strnlen(tokens[i], DNS_ADBLOCK_MAX_DOMAIN_LEN);
        if (length == 0 || length >= DNS_ADBLOCK_MAX_DOMAIN_LEN) continue;
        char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
        strlcpy(domain, tokens[i], sizeof(domain));
        for (char *p = domain; *p; p++) *p = (char)tolower((unsigned char)*p);
        if (domain[0] == '.' || domain[length - 1] == '.' || !strchr(domain, '.')) continue;
        bool valid = true;
        for (size_t j = 0; j < length; j++) {
            if (!is_valid_domain_char(domain[j])) { valid = false; break; }
        }
        if (!valid) continue;
        esp_err_t err = add_blocklist_domain(domain, list_index);
        if (err != ESP_OK) return err;
        (*entry_count)++;
    }
    return ESP_OK;
}

static esp_err_t download_blocklist(const char *url, size_t list_index, uint32_t *entry_count) {
    esp_http_client_config_t config = {
        .url = url,
        .timeout_ms = 20000,
        .buffer_size = 1024,
        .disable_auto_redirect = true,
        .crt_bundle_attach = esp_crt_bundle_attach,
    };
    esp_http_client_handle_t client = esp_http_client_init(&config);
    if (!client) return ESP_ERR_NO_MEM;
    esp_err_t err = esp_http_client_open(client, 0);
    if (err != ESP_OK) {
        esp_http_client_cleanup(client);
        return err;
    }
    esp_http_client_fetch_headers(client);
    if (esp_http_client_get_status_code(client) != 200) {
        esp_http_client_close(client);
        esp_http_client_cleanup(client);
        return ESP_ERR_INVALID_RESPONSE;
    }

    char buffer[1024];
    char line[512];
    size_t line_length = 0;
    bool line_overflow = false;
    while (true) {
        err = ESP_OK;
        int bytes_read = esp_http_client_read(client, buffer, sizeof(buffer));
        if (bytes_read < 0) { err = ESP_FAIL; break; }
        if (bytes_read == 0) break;
        for (int i = 0; i < bytes_read; i++) {
            char value = buffer[i];
            if (value == '\n') {
                if (!line_overflow) {
                    line[line_length] = '\0';
                    err = process_blocklist_line(line, entry_count, list_index);
                    if (err != ESP_OK) break;
                }
                line_length = 0;
                line_overflow = false;
            } else if (value != '\r') {
                if (line_length + 1 < sizeof(line)) line[line_length++] = value;
                else line_overflow = true;
            }
        }
        if (err != ESP_OK) break;
    }
    if (err == ESP_OK && !line_overflow && line_length > 0) {
        line[line_length] = '\0';
        err = process_blocklist_line(line, entry_count, list_index);
    }
    esp_http_client_close(client);
    esp_http_client_cleanup(client);
    return err;
}

esp_err_t dns_adblock_update_blocklists(void) {
    dns_adblock_list_info_t lists[DNS_ADBLOCK_MAX_LIST_URLS];
    size_t count = 0;
    esp_err_t err = dns_adblock_get_blocklists(lists, DNS_ADBLOCK_MAX_LIST_URLS, &count);
    if (err != ESP_OK) return err;
    bool any_enabled = false;
    bool any_success = false;
    esp_err_t update_result = ESP_OK;
    for (size_t i = 0; i < count; i++) {
        if (!lists[i].enabled) continue;
        any_enabled = true;
        uint32_t downloaded_entries = 0;
        err = download_blocklist(lists[i].url, i, &downloaded_entries);
        if (err != ESP_OK) {
            ESP_LOGW(TAG, "Unable to update adlist %s: %s", lists[i].url, esp_err_to_name(err));
            update_result = err;
            continue;
        }
        any_success = true;
        if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
            s_lists[i].entry_count = downloaded_entries;
            time_t now = time(NULL);
            struct tm utc_time;
            if (now >= 1704067200 && gmtime_r(&now, &utc_time)) {
                strftime(s_lists[i].last_updated, sizeof(s_lists[i].last_updated),
                         "%Y-%m-%d %H:%M UTC", &utc_time);
            } else {
                strlcpy(s_lists[i].last_updated, "Clock not synchronized",
                        sizeof(s_lists[i].last_updated));
            }
            xSemaphoreGive(s_mutex);
        }
    }
    if (!any_enabled) return ESP_ERR_INVALID_STATE;
    if (any_success) {
        esp_err_t save_err = dns_adblock_save_rules_to_usb();
        if (save_err != ESP_OK) update_result = save_err;
        save_err = dns_adblock_save_blocklists_to_usb();
        if (save_err != ESP_OK) update_result = save_err;
    }
    return update_result;
}

esp_err_t dns_adblock_save_blocklists_to_usb(void) {
    esp_err_t err = ensure_dns_storage_directory();
    if (err != ESP_OK) return err;
    dns_adblock_list_info_t lists[DNS_ADBLOCK_MAX_LIST_URLS];
    size_t count = 0;
    err = dns_adblock_get_blocklists(lists, DNS_ADBLOCK_MAX_LIST_URLS, &count);
    if (err != ESP_OK) return err;
    char temporary_path[sizeof(DNS_ADBLOCK_LISTS_PATH) + 8];
    int path_len = snprintf(temporary_path, sizeof(temporary_path), "%s.tmp",
                            DNS_ADBLOCK_LISTS_PATH);
    if (path_len <= 0 || (size_t)path_len >= sizeof(temporary_path)) return ESP_ERR_INVALID_SIZE;
    FILE *file = fopen(temporary_path, "w");
    if (!file) return ESP_FAIL;
    bool saved = true;
    for (size_t i = 0; i < count; i++) {
        if (fprintf(file, "%d\t%d\t%u\t%s\t%s\n", (int)lists[i].type,
                    lists[i].enabled ? 1 : 0, (unsigned)lists[i].entry_count,
                    lists[i].last_updated, lists[i].url) < 0) { saved = false; break; }
    }
    if (fclose(file) != 0) saved = false;
    if (!saved || rename(temporary_path, DNS_ADBLOCK_LISTS_PATH) != 0) {
        remove(temporary_path);
        return ESP_FAIL;
    }
    return ESP_OK;
}

esp_err_t dns_adblock_load_blocklists_from_usb(void) {
    esp_err_t err = ensure_dns_storage_directory();
    if (err != ESP_OK) return err;
    FILE *file = fopen(DNS_ADBLOCK_LISTS_PATH, "r");
    bool migrated = false;
    if (!file && errno == ENOENT && usb_host_msc_is_mounted()) {
        char legacy_path[MAP_PATH_MAX];
        if (usb_storage_map_resolve(DNS_ADBLOCK_LEGACY_USB_DIR "/adlists.txt",
                                    legacy_path, sizeof(legacy_path)) == ESP_OK) {
            file = fopen(legacy_path, "r");
            migrated = file != NULL;
        }
    }
    if (!file) return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
    char line[DNS_ADBLOCK_MAX_LIST_URL_LEN + 64];
    while (fgets(line, sizeof(line), file)) {
        int type;
        int enabled;
        uint32_t entry_count;
        char last_updated[32];
        char url[DNS_ADBLOCK_MAX_LIST_URL_LEN];
        if (sscanf(line, "%d\t%d\t%lu\t%31[^\t]\t%255[^\r\n]",
                   &type, &enabled, &entry_count, last_updated, url) != 5 ||
            type < DNS_ADBLOCK_LIST_TYPE_ADS || type > DNS_ADBLOCK_LIST_TYPE_CUSTOM) continue;
        err = dns_adblock_add_blocklist(url, (dns_adblock_list_type_t)type);
        if (err == ESP_OK) {
            dns_adblock_list_info_t lists[DNS_ADBLOCK_MAX_LIST_URLS];
            size_t count = 0;
            if (dns_adblock_get_blocklists(lists, DNS_ADBLOCK_MAX_LIST_URLS, &count) == ESP_OK) {
                for (size_t i = 0; i < count; i++) {
                    if (strcmp(lists[i].url, url) != 0) continue;
                    dns_adblock_enable_blocklist(i, enabled != 0);
                    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) == pdTRUE) {
                        s_lists[i].entry_count = entry_count;
                        strlcpy(s_lists[i].last_updated, last_updated, sizeof(s_lists[i].last_updated));
                        xSemaphoreGive(s_mutex);
                    }
                    break;
                }
            }
        }
    }
    bool read_failed = ferror(file) != 0;
    fclose(file);
    if (read_failed) return ESP_FAIL;
    return migrated ? dns_adblock_save_blocklists_to_usb() : ESP_OK;
}

esp_err_t dns_adblock_remove_blocklist(size_t index) {
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (index >= s_list_count) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_ARG;
    }
    uint16_t lower_mask = (uint16_t)((1U << index) - 1U);
    for (size_t rule_index = 0; rule_index < s_cache_count;) {
        dns_cache_entry_t *entry = &s_psram_cache[rule_index];
        uint16_t lower = entry->blocklist_mask & lower_mask;
        uint16_t upper = entry->blocklist_mask >> (index + 1);
        entry->blocklist_mask = (uint16_t)(lower | (upper << index));
        if (!entry->user_defined && entry->blocklist_mask == 0) {
            if (entry->regex) regfree(&entry->compiled_regex);
            for (size_t move = rule_index; move + 1 < s_cache_count; move++) {
                s_psram_cache[move] = s_psram_cache[move + 1];
            }
            s_cache_count--;
            continue;
        }
        rule_index++;
    }
        for (size_t i = index; i < s_list_count - 1; i++) {
            s_lists[i] = s_lists[i + 1];
        }
        s_list_count--;
        xSemaphoreGive(s_mutex);
        return ESP_OK;
}

esp_err_t dns_adblock_enable_blocklist(size_t index, bool enable) {
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    if (index >= s_list_count) {
        xSemaphoreGive(s_mutex);
        return ESP_ERR_INVALID_ARG;
    }
    s_lists[index].enabled = enable;
    if (!enable) {
        uint16_t list_mask = (uint16_t)(1U << index);
        for (size_t rule_index = 0; rule_index < s_cache_count;) {
            dns_cache_entry_t *entry = &s_psram_cache[rule_index];
            entry->blocklist_mask &= (uint16_t)~list_mask;
            if (!entry->user_defined && entry->blocklist_mask == 0) {
                if (entry->regex) regfree(&entry->compiled_regex);
                for (size_t move = rule_index; move + 1 < s_cache_count; move++) {
                    s_psram_cache[move] = s_psram_cache[move + 1];
                }
                s_cache_count--;
                continue;
            }
            rule_index++;
        }
    }
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t dns_adblock_remove_domain(const char *domain) {
    if (!domain || !s_psram_cache) return ESP_ERR_INVALID_ARG;
    char normalized[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    size_t length = strnlen(domain, sizeof(normalized));
    if (length == 0 || length >= sizeof(normalized)) return ESP_ERR_INVALID_ARG;
    strlcpy(normalized, domain, sizeof(normalized));
    for (char *p = normalized; *p; p++) *p = (char)tolower((unsigned char)*p);
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    bool found = false;
    for (uint32_t i = 0; i < s_cache_count; i++) {
        if (!s_psram_cache[i].regex && strcmp(s_psram_cache[i].domain, normalized) == 0) {
            for (uint32_t j = i; j + 1 < s_cache_count; j++) s_psram_cache[j] = s_psram_cache[j + 1];
            s_cache_count--;
            found = true;
            break;
        }
    }
    xSemaphoreGive(s_mutex);
    return found ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t dns_adblock_remove_regex(const char *pattern) {
    if (!pattern || !s_psram_cache) return ESP_ERR_INVALID_ARG;
    char normalized[DNS_ADBLOCK_MAX_DOMAIN_LEN];
    size_t length = strnlen(pattern, sizeof(normalized));
    if (length == 0 || length >= sizeof(normalized)) return ESP_ERR_INVALID_ARG;
    strlcpy(normalized, pattern, sizeof(normalized));
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    bool found = false;
    for (uint32_t i = 0; i < s_cache_count; i++) {
        if (!s_psram_cache[i].regex || strcmp(s_psram_cache[i].domain, normalized) != 0) continue;
        if (s_psram_cache[i].regex) regfree(&s_psram_cache[i].compiled_regex);
        for (uint32_t j = i; j + 1 < s_cache_count; j++) s_psram_cache[j] = s_psram_cache[j + 1];
        s_cache_count--;
        found = true;
        break;
    }
    xSemaphoreGive(s_mutex);
    return found ? ESP_OK : ESP_ERR_NOT_FOUND;
}

esp_err_t dns_adblock_list_domains(dns_adblock_domain_rule_t *rules, size_t max_rules,
                                   size_t *count, size_t *total) {
    return dns_adblock_list_domains_page(rules, max_rules, 0, -1, count, total);
}

esp_err_t dns_adblock_list_domains_page(dns_adblock_domain_rule_t *rules, size_t max_rules,
                                        size_t offset, int blocked_filter,
                                        size_t *count, size_t *total) {
    if ((max_rules > 0 && rules == NULL) || count == NULL || total == NULL) {
        return ESP_ERR_INVALID_ARG;
    }
    if (blocked_filter < -1 || blocked_filter > 1) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    *total = 0;
    *count = 0;
    for (size_t i = 0; i < s_cache_count; i++) {
        bool blocked = s_psram_cache[i].blocked;
        if (blocked_filter != -1 && blocked != (blocked_filter == 1)) continue;
        if (*total >= offset && *count < max_rules) {
            strlcpy(rules[*count].domain, s_psram_cache[i].domain, sizeof(rules[*count].domain));
            rules[*count].blocked = blocked;
            rules[*count].hit_count = s_psram_cache[i].hit_count;
            rules[*count].regex = s_psram_cache[i].regex;
            (*count)++;
        }
        (*total)++;
    }
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t dns_adblock_clear_stats(void) {
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    init_stats();
    s_stats.running = s_running;
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t dns_adblock_get_log(dns_adblock_log_entry_t *entries, size_t max_entries,
                              size_t *count) {
    if ((max_entries > 0 && entries == NULL) || !count) return ESP_ERR_INVALID_ARG;
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    *count = s_query_log_count < max_entries ? s_query_log_count : max_entries;
    for (size_t i = 0; i < *count; i++) {
        size_t index = (s_query_log_head + DNS_ADBLOCK_LOG_CAPACITY - 1 - i) %
            DNS_ADBLOCK_LOG_CAPACITY;
        entries[i] = s_query_log[index];
    }
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

static bool valid_history_date(const char *date) {
    if (!date || strlen(date) != 10 || date[4] != '-' || date[7] != '-') return false;
    for (size_t i = 0; i < 10; i++) {
        if (i == 4 || i == 7) continue;
        if (date[i] < '0' || date[i] > '9') return false;
    }
    int month = (date[5] - '0') * 10 + date[6] - '0';
    int day = (date[8] - '0') * 10 + date[9] - '0';
    return month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

esp_err_t dns_adblock_get_log_for_date(const char *date, dns_adblock_log_entry_t *entries,
                                       size_t max_entries, size_t *count) {
    if (!valid_history_date(date) || (max_entries > 0 && !entries) || !count) {
        return ESP_ERR_INVALID_ARG;
    }
    *count = 0;
    if (s_log_storage_mutex &&
        xSemaphoreTake(s_log_storage_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        FILE *file = open_history_file(date);
        if (file) {
                dns_adblock_log_entry_t *recent = heap_caps_malloc(
                    sizeof(*recent) * DNS_ADBLOCK_LOG_CAPACITY,
                    MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
                if (!recent) {
                    fclose(file);
                    xSemaphoreGive(s_log_storage_mutex);
                    return ESP_ERR_NO_MEM;
                }
                size_t stored = 0;
                char line[DNS_ADBLOCK_MAX_DOMAIN_LEN + 64];
                while (fgets(line, sizeof(line), file)) {
                    unsigned long long timestamp_seconds;
                    int status;
                    char client_ip[16];
                    char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
                    if (sscanf(line, "%llu\t%d\t%15[^\t]\t%252[^\n]",
                               &timestamp_seconds, &status, client_ip, domain) != 4 ||
                        status < DNS_ADBLOCK_LOG_ALLOWED || status > DNS_ADBLOCK_LOG_FAILED) continue;
                    dns_adblock_log_entry_t entry = {0};
                    entry.timestamp_ms = (uint64_t)timestamp_seconds * 1000ULL;
                    entry.timestamp_valid = true;
                    entry.status = (dns_adblock_log_status_t)status;
                    strlcpy(entry.client_ip, client_ip, sizeof(entry.client_ip));
                    strlcpy(entry.domain, domain, sizeof(entry.domain));
                    recent[stored % DNS_ADBLOCK_LOG_CAPACITY] = entry;
                    stored++;
                }
                fclose(file);
                size_t available = stored < DNS_ADBLOCK_LOG_CAPACITY ? stored : DNS_ADBLOCK_LOG_CAPACITY;
                *count = available < max_entries ? available : max_entries;
                for (size_t i = 0; i < *count; i++) {
                    size_t index = (stored - 1 - i) % DNS_ADBLOCK_LOG_CAPACITY;
                    entries[i] = recent[index];
                }
                heap_caps_free(recent);
                xSemaphoreGive(s_log_storage_mutex);
                return ESP_OK;
        }
        xSemaphoreGive(s_log_storage_mutex);
    }

    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    for (size_t i = 0; i < s_query_log_count && *count < max_entries; i++) {
        size_t index = (s_query_log_head + DNS_ADBLOCK_LOG_CAPACITY - 1 - i) %
            DNS_ADBLOCK_LOG_CAPACITY;
        dns_adblock_log_entry_t *entry = &s_query_log[index];
        if (!entry->timestamp_valid) continue;
        time_t seconds = (time_t)(entry->timestamp_ms / 1000ULL) + 8 * 3600;
        struct tm utc_time;
        char entry_date[11];
        if (!gmtime_r(&seconds, &utc_time) || strftime(entry_date, sizeof(entry_date), "%Y-%m-%d", &utc_time) != 10 ||
            strcmp(entry_date, date) != 0) continue;
        entries[(*count)++] = *entry;
    }
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

static void add_daily_summary_entry(dns_adblock_daily_summary_t *summary,
                                    const dns_adblock_log_entry_t *entry) {
    time_t seconds = (time_t)(entry->timestamp_ms / 1000ULL);
    struct tm utc_time;
    if (!gmtime_r(&seconds, &utc_time)) return;
    utc_time.tm_hour = (utc_time.tm_hour + 8) % 24;
    if (utc_time.tm_hour < 0 || utc_time.tm_hour >= 24) return;
    summary->total_queries++;
    if (entry->status == DNS_ADBLOCK_LOG_BLOCKED) {
        summary->blocked++;
        summary->hourly_blocked[utc_time.tm_hour]++;
    } else if (entry->status == DNS_ADBLOCK_LOG_FAILED) {
        summary->failed++;
        summary->hourly_failed[utc_time.tm_hour]++;
    } else {
        summary->allowed++;
        summary->hourly_allowed[utc_time.tm_hour]++;
    }
}

esp_err_t dns_adblock_get_daily_summary(const char *date, dns_adblock_daily_summary_t *summary) {
    if (!valid_history_date(date) || !summary) return ESP_ERR_INVALID_ARG;
    memset(summary, 0, sizeof(*summary));
    if (s_log_storage_mutex &&
        xSemaphoreTake(s_log_storage_mutex, pdMS_TO_TICKS(500)) == pdTRUE) {
        FILE *file = open_history_file(date);
        if (file) {
                char line[DNS_ADBLOCK_MAX_DOMAIN_LEN + 64];
                while (fgets(line, sizeof(line), file)) {
                    unsigned long long timestamp_seconds;
                    int status;
                    char client_ip[16];
                    char domain[DNS_ADBLOCK_MAX_DOMAIN_LEN];
                    if (sscanf(line, "%llu\t%d\t%15[^\t]\t%252[^\n]",
                               &timestamp_seconds, &status, client_ip, domain) != 4 ||
                        status < DNS_ADBLOCK_LOG_ALLOWED || status > DNS_ADBLOCK_LOG_FAILED) continue;
                    dns_adblock_log_entry_t entry = {
                        .timestamp_ms = (uint64_t)timestamp_seconds * 1000ULL,
                        .status = (dns_adblock_log_status_t)status,
                        .timestamp_valid = true,
                    };
                    time_t seconds = (time_t)timestamp_seconds + 8 * 3600;
                    struct tm utc_time;
                    char entry_date[11];
                    if (gmtime_r(&seconds, &utc_time) &&
                        strftime(entry_date, sizeof(entry_date), "%Y-%m-%d", &utc_time) == 10 &&
                        strcmp(entry_date, date) == 0) {
                        add_daily_summary_entry(summary, &entry);
                    }
                }
                fclose(file);
                xSemaphoreGive(s_log_storage_mutex);
                return ESP_OK;
        }
        xSemaphoreGive(s_log_storage_mutex);
    }

    dns_adblock_log_entry_t *recent = heap_caps_malloc(
        sizeof(*recent) * DNS_ADBLOCK_LOG_CAPACITY,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!recent) return ESP_ERR_NO_MEM;
    size_t count = 0;
    esp_err_t err = dns_adblock_get_log_for_date(date, recent, DNS_ADBLOCK_LOG_CAPACITY, &count);
    if (err != ESP_OK) {
        heap_caps_free(recent);
        return err;
    }
    for (size_t i = 0; i < count; i++) add_daily_summary_entry(summary, &recent[i]);
    heap_caps_free(recent);
    return ESP_OK;
}

esp_err_t dns_adblock_export_log(char *output, size_t max_len, int max_entries) {
    if (!output || max_len == 0) return ESP_ERR_INVALID_ARG;
    dns_adblock_log_entry_t *entries = heap_caps_malloc(
        sizeof(*entries) * DNS_ADBLOCK_LOG_CAPACITY,
        MALLOC_CAP_SPIRAM | MALLOC_CAP_8BIT);
    if (!entries) return ESP_ERR_NO_MEM;
    size_t count = 0;
    esp_err_t err = dns_adblock_get_log(entries, DNS_ADBLOCK_LOG_CAPACITY, &count);
    if (err != ESP_OK) {
        heap_caps_free(entries);
        return err;
    }
    size_t limit = max_entries < 0 || (size_t)max_entries > count ? count : (size_t)max_entries;
    size_t used = 0;
    output[0] = '\0';
    for (size_t i = 0; i < limit; i++) {
        int written = snprintf(output + used, max_len - used, "%llu %s %s %s\n",
            (unsigned long long)entries[i].timestamp_ms,
            entries[i].status == DNS_ADBLOCK_LOG_BLOCKED ? "BLOCKED" :
                entries[i].status == DNS_ADBLOCK_LOG_FAILED ? "FAILED" : "ALLOWED",
            entries[i].client_ip, entries[i].domain);
        if (written < 0 || (size_t)written >= max_len - used) break;
        used += (size_t)written;
    }
    heap_caps_free(entries);
    return ESP_OK;
}

esp_err_t dns_adblock_clear_log(void) {
    if (xSemaphoreTake(s_mutex, pdMS_TO_TICKS(100)) != pdTRUE) return ESP_ERR_TIMEOUT;
    memset(s_query_log, 0, sizeof(s_query_log));
    s_query_log_head = 0;
    s_query_log_count = 0;
    xSemaphoreGive(s_mutex);
    return ESP_OK;
}

esp_err_t dns_adblock_flush_daily_log_to_usb(void) {
    if (!usb_host_msc_is_ready() || !s_log_storage_mutex) {
        return ESP_ERR_INVALID_STATE;
    }
    if (xSemaphoreTake(s_log_storage_mutex, pdMS_TO_TICKS(500)) != pdTRUE) {
        return ESP_ERR_TIMEOUT;
    }

    time_t utc8_now = time(NULL) + 8 * 3600;
    struct tm utc8_time;
    char today[11];
    if (!gmtime_r(&utc8_now, &utc8_time) || strftime(today, sizeof(today), "%Y-%m-%d", &utc8_time) != 10) {
        xSemaphoreGive(s_log_storage_mutex);
        return ESP_FAIL;
    }

    esp_err_t err = ensure_dns_storage_directory();
    DIR *directory = err == ESP_OK ? opendir(DNS_ADBLOCK_STORAGE_DIR) : NULL;
    if (!directory) {
        xSemaphoreGive(s_log_storage_mutex);
        return err == ESP_OK ? ESP_FAIL : err;
    }
    char date[11] = {0};
    struct dirent *entry;
    while ((entry = readdir(directory)) != NULL) {
        if (strlen(entry->d_name) != 22 || strncmp(entry->d_name, "history-", 8) != 0 ||
            strcmp(entry->d_name + 18, ".tsv") != 0) continue;
        char candidate_date[11];
        memcpy(candidate_date, entry->d_name + 8, 10);
        candidate_date[10] = '\0';
        if (!valid_history_date(candidate_date) || strcmp(candidate_date, today) >= 0) continue;
        if (date[0] == '\0' || strcmp(candidate_date, date) < 0) {
            strlcpy(date, candidate_date, sizeof(date));
        }
    }
    closedir(directory);
    if (date[0] == '\0') {
        xSemaphoreGive(s_log_storage_mutex);
        return ESP_ERR_NOT_FOUND;
    }

    char source_path[128];
    int path_len = snprintf(source_path, sizeof(source_path),
                            DNS_ADBLOCK_HISTORY_FILE_FORMAT, date);
    if (path_len <= 0 || (size_t)path_len >= sizeof(source_path)) {
        xSemaphoreGive(s_log_storage_mutex);
        return ESP_ERR_INVALID_SIZE;
    }
    FILE *source = fopen(source_path, "rb");
    if (!source) {
        if (errno == ENOENT) {
            char archived_logical_path[160];
            char archived_path[MAP_PATH_MAX];
            int archived_len = snprintf(archived_logical_path, sizeof(archived_logical_path),
                                        DNS_ADBLOCK_LEGACY_HISTORY_FILE_FORMAT, date);
            bool already_archived = archived_len > 0 &&
                (size_t)archived_len < sizeof(archived_logical_path) &&
                usb_storage_map_resolve(archived_logical_path, archived_path,
                                        sizeof(archived_path)) == ESP_OK;
            if (!already_archived) {
                time_t legacy_utc = time(NULL);
                struct tm legacy_time;
                char legacy_date[11];
                if (gmtime_r(&legacy_utc, &legacy_time) &&
                    strftime(legacy_date, sizeof(legacy_date), "%Y-%m-%d", &legacy_time) == 10 &&
                    strcmp(legacy_date, date) == 0) {
                    strlcpy(date, legacy_date, sizeof(date));
                } else {
                    xSemaphoreGive(s_log_storage_mutex);
                    return ESP_ERR_NOT_FOUND;
                }
            }
            path_len = snprintf(source_path, sizeof(source_path),
                                DNS_ADBLOCK_HISTORY_FILE_FORMAT, date);
            if (path_len <= 0 || (size_t)path_len >= sizeof(source_path)) {
                xSemaphoreGive(s_log_storage_mutex);
                return ESP_ERR_INVALID_SIZE;
            }
            source = fopen(source_path, "rb");
            if (!source) {
                xSemaphoreGive(s_log_storage_mutex);
                return errno == ENOENT ? ESP_ERR_NOT_FOUND : ESP_FAIL;
            }
        }
        if (!source) {
            xSemaphoreGive(s_log_storage_mutex);
            return ESP_FAIL;
        }
    }

    err = usb_storage_map_mkdir("/usb/system");
    if (err == ESP_OK) err = usb_storage_map_mkdir(DNS_ADBLOCK_LEGACY_USB_DIR);
    char final_logical_path[160];
    char temporary_logical_path[168];
    char final_path[MAP_PATH_MAX];
    char temporary_path[MAP_PATH_MAX];
    if (err == ESP_OK) {
        int final_len = snprintf(final_logical_path, sizeof(final_logical_path),
                                 DNS_ADBLOCK_LEGACY_HISTORY_FILE_FORMAT, date);
        int temporary_len = snprintf(temporary_logical_path, sizeof(temporary_logical_path),
                                     DNS_ADBLOCK_LEGACY_HISTORY_FILE_FORMAT, date);
        if (final_len <= 0 || (size_t)final_len >= sizeof(final_logical_path) ||
            temporary_len <= 0 || (size_t)temporary_len >= sizeof(temporary_logical_path)) {
            err = ESP_ERR_INVALID_SIZE;
        } else {
            int suffix_len = snprintf(temporary_logical_path + temporary_len,
                                      sizeof(temporary_logical_path) - (size_t)temporary_len,
                                      ".tmp");
            if (suffix_len <= 0 ||
                (size_t)suffix_len >= sizeof(temporary_logical_path) - (size_t)temporary_len) {
                err = ESP_ERR_INVALID_SIZE;
            }
        }
    }
    if (err == ESP_OK) err = usb_storage_map_resolve(final_logical_path, final_path, sizeof(final_path));
    if (err == ESP_ERR_NOT_FOUND) {
        err = usb_storage_map_create_file(DNS_ADBLOCK_LEGACY_USB_DIR,
                                          strrchr(final_logical_path, '/') + 1,
                                          final_path, sizeof(final_path));
    }
    if (err == ESP_OK) err = usb_storage_map_resolve(temporary_logical_path, temporary_path,
                                                      sizeof(temporary_path));
    if (err == ESP_ERR_NOT_FOUND) {
        err = usb_storage_map_create_file(DNS_ADBLOCK_LEGACY_USB_DIR,
                                          strrchr(temporary_logical_path, '/') + 1,
                                          temporary_path, sizeof(temporary_path));
    }
    if (err == ESP_OK) {
        remove(temporary_path);
        FILE *destination = fopen(temporary_path, "wb");
        if (!destination) {
            err = ESP_FAIL;
        } else {
            char buffer[1024];
            size_t count;
            bool copy_ok = true;
            while ((count = fread(buffer, 1, sizeof(buffer), source)) > 0) {
                if (fwrite(buffer, 1, count, destination) != count) {
                    copy_ok = false;
                    break;
                }
            }
            copy_ok = copy_ok && ferror(source) == 0 && fflush(destination) == 0;
            bool destination_closed = fclose(destination) == 0;
            if (!copy_ok || !destination_closed) {
                remove(temporary_path);
                err = ESP_FAIL;
            } else {
                remove(final_path);
                if (rename(temporary_path, final_path) != 0) {
                    remove(temporary_path);
                    err = ESP_FAIL;
                } else if (remove(source_path) != 0) {
                    err = ESP_FAIL;
                }
            }
        }
    }
    if (fclose(source) != 0 && err == ESP_OK) err = ESP_FAIL;
    xSemaphoreGive(s_log_storage_mutex);
    return err;
}