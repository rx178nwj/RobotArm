#ifndef MULTI_I2C_BRIDGE_BRIDGE_REGS_H
#define MULTI_I2C_BRIDGE_BRIDGE_REGS_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#include "board.h"
#include "core/config.h"
#include "core/sensor_data.h"
#include "core/sys_status.h"

enum {
    CMD_RESULT_IDLE = 0x00,
    CMD_RESULT_BUSY = 0x01,
    CMD_RESULT_FAIL = 0xFF,
};

enum {
    CMD_NOP = 0x00,
    CMD_CLEAR_FAULT = 0x01,
    CMD_MUX_RESET = 0x02,
    CMD_RESCAN = 0x03,
    CMD_SOFT_RESET = 0xA5,
};

typedef struct {
    bridge_config_t config;
    sys_status_t status;
    sensor_snapshot_t sensor;
    uint8_t ch_present;
    uint8_t cmd_readback;
} regs_image_t;

typedef struct {
    bool clear_fault;
    bool soft_reset;
    bool cmd_dispatch;
    bool dir_apply_now;
    uint8_t cmd_opcode;
    uint8_t dir_gpio_mask;
} regs_write_result_t;

typedef struct {
    uint8_t current_ptr;
    bool expect_ptr;
    uint32_t last_read_sample_count;
    uint8_t tx_staging[MULTI_I2C_BRIDGE_REG_COUNT];
} bridge_regs_t;

void regs_init(bridge_regs_t *regs);
void regs_snapshot(bridge_regs_t *regs, const regs_image_t *image);
void regs_on_write(
    bridge_regs_t *regs,
    bridge_config_t *config,
    sys_status_t *status,
    uint8_t *cmd_readback,
    uint8_t value,
    regs_write_result_t *result);
uint8_t regs_on_read_byte(bridge_regs_t *regs, sys_status_t *status);
void regs_on_finish(bridge_regs_t *regs);

#endif
