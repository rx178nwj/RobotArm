#ifndef MULTI_I2C_BRIDGE_CORE_FAULT_H
#define MULTI_I2C_BRIDGE_CORE_FAULT_H

#include <stdbool.h>

#include "core/sys_status.h"

void fault_init(void);
void fault_arm_watchdog(void);
bool fault_watchdog_caused_reboot(void);
void fault_note_core0_alive(void);
void fault_note_core1_alive(void);
void fault_kick_watchdog(void);
bool fault_bus_recover(sys_status_t *status);

#endif
