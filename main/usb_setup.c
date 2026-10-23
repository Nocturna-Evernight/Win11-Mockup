/*
 * USB Setup Utility
 * Creates default directory structure, profiles, wallpapers, and assets on USB flash drive
 * Called from usb_host_msc.c when USB is first mounted
 */

#include "usb_setup.h"
#include <stdio.h>
#include <string.h>
#include "esp_log.h"
#include "esp_timer.h"
#include "usb_host_msc.h"
#include "usb_storage_map.h"
#include "auth_uac.h"
#include "profile_manager.h"
#include "dns_adblock.h"

static const char *TAG = "USB_SETUP";

#define PROFILES_DIR "/usb/profiles"
#define SYSTEM_DIR "/usb/system"
#define DNS_DIR "/usb/system/dns"
#define WWW_DIR "/usb/www"
#define ASSETS_DIR "/usb/assets"
#define WALLPAPER_DIR "/usb/wallpaper"

static const char *default_dirs[] = {
    PROFILES_DIR,
    PROFILES_DIR "/Default",
    PROFILES_DIR "/Default/wallpaper",
    PROFILES_DIR "/Default/assets",
    PROFILES_DIR "/Default/settings",
    SYSTEM_DIR,
    DNS_DIR,
    WWW_DIR,
    WWW_DIR "/assets",
    WWW_DIR "/assets/css",
    WWW_DIR "/assets/js",
    WWW_DIR "/assets/img",
    ASSETS_DIR,
    WALLPAPER_DIR,
};

esp_err_t usb_setup_create_default_dirs(void) {
    ESP_LOGI(TAG, "Creating default USB directory structure...");
    
    for (size_t i = 0; i < sizeof(default_dirs) / sizeof(default_dirs[0]); i++) {
        esp_err_t err = usb_storage_map_mkdir(default_dirs[i]);
        if (err != ESP_OK && err != ESP_ERR_INVALID_STATE) {
            ESP_LOGW(TAG, "Could not create directory %s: %s", default_dirs[i], esp_err_to_name(err));
        }
    }
    return ESP_OK;
}

esp_err_t usb_setup_create_default_profile(void) {
    ESP_LOGI(TAG, "Setting up default profile...");
    
    // Create Default profile if it doesn't exist
    if (!profile_manager_profile_exists("Default")) {
        esp_err_t err = profile_manager_create_profile("Default", "Default User", false);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to create default profile: %s", esp_err_to_name(err));
            return err;
        }
    }
    
    // Create Administrator profile if it doesn't exist
    if (!profile_manager_profile_exists("Administrator")) {
        esp_err_t err = profile_manager_create_profile("Administrator", "System Administrator", true);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to create admin profile: %s", esp_err_to_name(err));
        }
    }
    
    // Create Guest profile if it doesn't exist
    if (!profile_manager_profile_exists("Guest")) {
        esp_err_t err = profile_manager_create_profile("Guest", "Guest User", false);
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Failed to create guest profile: %s", esp_err_to_name(err));
        }
    }
    
    return ESP_OK;
}

esp_err_t usb_setup_create_dns_config(void) {
    ESP_LOGI(TAG, "Setting up DNS ad-blocker configuration...");
    
    dns_adblock_config_t config;
    esp_err_t err = dns_adblock_get_config(&config);
    if (err != ESP_OK) return err;
    
    // Load persistent internal DNS settings, importing legacy USB data if needed.
    err = dns_adblock_load_config_from_usb();
    if (err == ESP_ERR_NOT_FOUND) {
        ESP_LOGI(TAG, "No persistent DNS config found, saving defaults");
        err = dns_adblock_save_config_to_usb();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not persist DNS configuration: %s", esp_err_to_name(err));
        return err;
    }

    err = dns_adblock_load_rules_from_usb();
    if (err == ESP_ERR_NOT_FOUND) {
        err = dns_adblock_save_rules_to_usb();
    }
    if (err != ESP_OK) {
        ESP_LOGE(TAG, "Could not load or persist DNS rules: %s", esp_err_to_name(err));
        return err;
    }

    err = dns_adblock_load_blocklists_from_usb();
    if (err != ESP_OK && err != ESP_ERR_NOT_FOUND) {
        ESP_LOGW(TAG, "Could not load saved DNS adlists: %s", esp_err_to_name(err));
    }

    // Add default blocklist URLs if none exist
    dns_adblock_list_info_t lists[DNS_ADBLOCK_MAX_LIST_URLS];
    size_t count = 0;
    dns_adblock_get_blocklists(lists, DNS_ADBLOCK_MAX_LIST_URLS, &count);
    
    if (count == 0) {
        // Prefer the compact Peter Lowe feed; keep larger alternatives opt-in.
        dns_adblock_add_blocklist("https://pgl.yoyo.org/adservers/serverlist.php?hostformat=hosts&showintro=0&mimetype=plaintext", DNS_ADBLOCK_LIST_TYPE_ADS);
        dns_adblock_add_blocklist("https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts", DNS_ADBLOCK_LIST_TYPE_ADS);
        dns_adblock_add_blocklist("https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/fakenews-gambling-porn-social/hosts", DNS_ADBLOCK_LIST_TYPE_TRACKING);
        dns_adblock_add_blocklist("https://raw.githubusercontent.com/StevenBlack/hosts/master/alternates/malware/hosts", DNS_ADBLOCK_LIST_TYPE_MALWARE);
        dns_adblock_enable_blocklist(1, false);
        dns_adblock_enable_blocklist(2, false);
        dns_adblock_enable_blocklist(3, false);
        err = dns_adblock_save_blocklists_to_usb();
        if (err != ESP_OK) {
            ESP_LOGE(TAG, "Could not persist default DNS blocklists: %s", esp_err_to_name(err));
            return err;
        }
        ESP_LOGI(TAG, "Added default blocklists");
    }
    
    return ESP_OK;
}

esp_err_t usb_setup_copy_web_assets(void) {
    ESP_LOGI(TAG, "Web assets are served from /usb/www (copied during build)");
    // The web assets (index.html, assets/css/, assets/js/) should be pre-copied
    // to the USB drive's /www directory during manufacturing or first boot
    // For now, we just ensure the directory exists
    return ESP_OK;
}

esp_err_t usb_setup_init_all(void) {
    if (!usb_host_msc_is_mounted()) {
        ESP_LOGW(TAG, "USB not mounted, skipping setup");
        return ESP_ERR_INVALID_STATE;
    }
    
    ESP_LOGI(TAG, "=== USB First-Time Setup ===");
    
    esp_err_t err = ESP_OK;
    
    // 1. Create directory structure
    err = usb_setup_create_default_dirs();
    if (err != ESP_OK) return err;
    
    // 2. Create default profiles
    err = usb_setup_create_default_profile();
    if (err != ESP_OK) return err;
    
    // 3. Setup DNS ad-blocker
    err = usb_setup_create_dns_config();
    if (err != ESP_OK) return err;
    
    // 4. Copy web assets (placeholder)
    err = usb_setup_copy_web_assets();
    if (err != ESP_OK) return err;
    
    ESP_LOGI(TAG, "=== USB Setup Complete ===");
    return ESP_OK;
}