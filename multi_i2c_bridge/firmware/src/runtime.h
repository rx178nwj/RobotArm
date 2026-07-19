#ifndef MULTI_I2C_BRIDGE_RUNTIME_H
#define MULTI_I2C_BRIDGE_RUNTIME_H

#include <stdint.h>

#include "bridge_regs.h"
#include "core/config.h"
#include "core/sensor_data.h"
#include "core/sys_status.h"

typedef struct {
    volatile uint8_t req_cmd;
    volatile uint32_t req_seq;
    volatile uint32_t ack_seq;
    volatile uint8_t result;
} cmd_mailbox_t;

extern bridge_regs_t g_regs;
extern bridge_config_t g_config;
extern sys_status_t g_status;
extern sensor_data_t g_sensor_data;
extern volatile uint8_t g_cmd_readback;
extern volatile uint8_t g_ch_present;
extern volatile cmd_mailbox_t g_cmd_mailbox;

void runtime_apply_dir_gpio(uint8_t dir_mask);

#endif
