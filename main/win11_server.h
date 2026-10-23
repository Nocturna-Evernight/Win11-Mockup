/*
 * Win11 Web Server Header
 */
#ifndef WIN11_SERVER_H
#define WIN11_SERVER_H

#include <stdbool.h>
#include "esp_err.h"

#ifdef __cplusplus
extern "C" {
#endif

void win11_server_start(void);
bool win11_server_is_running(void);
esp_err_t win11_server_stop(void);

#ifdef __cplusplus
}
#endif

#endif // WIN11_SERVER_H
