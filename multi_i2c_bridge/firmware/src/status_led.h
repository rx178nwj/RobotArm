#ifndef MULTI_I2C_BRIDGE_STATUS_LED_H
#define MULTI_I2C_BRIDGE_STATUS_LED_H

#include "core/sys_status.h"

void status_led_init(void);
void status_led_note_upstream_activity(void);
void status_led_note_downstream_publish(void);
void status_led_service(const sys_status_t *status);

#endif
