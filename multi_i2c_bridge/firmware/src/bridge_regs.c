#include "bridge_regs.h"

#include <string.h>

enum {
    REG_WHO_AM_I = 0x00,
    REG_VERSION = 0x01,
    REG_STATUS_LO = 0x02,
    REG_STATUS_HI = 0x03,
    REG_FAULT = 0x04,
    REG_CH_FAULT = 0x05,
    REG_SAMPLE_COUNT = 0x08,
    REG_CH0_ANGLE = 0x10,
    REG_STATUS_LO_M = 0x1C,
    REG_STATUS_HI_M = 0x1D,
    REG_SAMPLE_LO = 0x1E,
    REG_CH0_AGC = 0x30,
    REG_CONFIG = 0x40,
    REG_POLL_PERIOD = 0x41,
    REG_DIR_CONFIG = 0x42,
    REG_STATUS_DECIM = 0x43,
    REG_AS5600_CONF_LO = 0x44,
    REG_AS5600_CONF_HI = 0x45,
    REG_CH_PRESENT = 0x46,
    REG_CH_ENABLE = 0x47,
    REG_CMD = 0x50,
};

static void set_le16(uint8_t *dst, uint16_t value) {
    dst[0] = (uint8_t)(value & 0xFFu);
    dst[1] = (uint8_t)((value >> 8) & 0xFFu);
}

static void set_le32(uint8_t *dst, uint32_t value) {
    dst[0] = (uint8_t)(value & 0xFFu);
    dst[1] = (uint8_t)((value >> 8) & 0xFFu);
    dst[2] = (uint8_t)((value >> 16) & 0xFFu);
    dst[3] = (uint8_t)((value >> 24) & 0xFFu);
}

static bool is_as5600_conf_valid(uint16_t candidate) {
    const uint16_t mutable_mask = (uint16_t)((0x3u << 8) | (0x7u << 10));
    return (candidate & (uint16_t)~mutable_mask) ==
           (AS5600_CONF_DEFAULT & (uint16_t)~mutable_mask);
}

static bool is_defined_read_offset(uint8_t offset) {
    if (offset <= REG_CH_FAULT ||
        (offset >= REG_SAMPLE_COUNT && offset <= (REG_SAMPLE_COUNT + 3u)) ||
        (offset >= REG_CH0_ANGLE && offset <= REG_SAMPLE_LO) ||
        (offset >= REG_CH0_AGC && offset < (REG_CH0_AGC + MULTI_I2C_BRIDGE_CHANNELS)) ||
        (offset >= REG_CONFIG && offset <= REG_CH_ENABLE) ||
        offset == REG_CMD) {
        return true;
    }
    return false;
}

static void reject_write(sys_status_t *status) {
    sys_status_set_fault(status, FAULT_CFG_REJECT);
}

static void write_sensor_slots(bridge_regs_t *regs, const regs_image_t *image) {
    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        const bool enabled = ((image->config.ch_enable >> ch) & 0x01u) != 0u;
        const uint16_t angle = enabled ? (uint16_t)(image->sensor.angle[ch] & 0x0FFFu) : 0xFFFFu;
        const uint8_t agc = enabled ? image->sensor.agc[ch] : 0xFFu;
        set_le16(&regs->tx_staging[REG_CH0_ANGLE + (ch * 2u)], angle);
        regs->tx_staging[REG_CH0_AGC + ch] = agc;
    }
}

void regs_init(bridge_regs_t *regs) {
    memset(regs, 0, sizeof(*regs));
    memset(regs->tx_staging, 0xFF, sizeof(regs->tx_staging));
    regs->expect_ptr = true;
}

void regs_snapshot(bridge_regs_t *regs, const regs_image_t *image) {
    const bool data_new = image->sensor.sample_count != regs->last_read_sample_count;
    const uint8_t status_lo = sys_status_compose_lo(&image->status);
    const uint8_t status_hi = sys_status_compose_hi(&image->status, data_new);

    regs->last_read_sample_count = image->sensor.sample_count;

    memset(regs->tx_staging, 0xFF, sizeof(regs->tx_staging));
    regs->tx_staging[REG_WHO_AM_I] = WHO_AM_I_VAL;
    regs->tx_staging[REG_VERSION] = VERSION_VAL;
    regs->tx_staging[REG_STATUS_LO] = status_lo;
    regs->tx_staging[REG_STATUS_HI] = status_hi;
    regs->tx_staging[REG_FAULT] = image->status.fault;
    regs->tx_staging[REG_CH_FAULT] = image->status.ch_fault;
    set_le32(&regs->tx_staging[REG_SAMPLE_COUNT], image->sensor.sample_count);
    write_sensor_slots(regs, image);
    regs->tx_staging[REG_STATUS_LO_M] = status_lo;
    regs->tx_staging[REG_STATUS_HI_M] = status_hi;
    regs->tx_staging[REG_SAMPLE_LO] = (uint8_t)(image->sensor.sample_count & 0xFFu);
    regs->tx_staging[REG_CONFIG] = (uint8_t)(image->config.angle_src & 0x01u);
    regs->tx_staging[REG_POLL_PERIOD] = image->config.poll_period_ms;
    regs->tx_staging[REG_DIR_CONFIG] = (uint8_t)(image->config.dir_config & MULTI_I2C_BRIDGE_CHANNEL_MASK);
    regs->tx_staging[REG_STATUS_DECIM] = image->config.status_decim;
    set_le16(&regs->tx_staging[REG_AS5600_CONF_LO], image->config.as5600_conf);
    regs->tx_staging[REG_CH_PRESENT] = (uint8_t)(image->ch_present & MULTI_I2C_BRIDGE_CHANNEL_MASK);
    regs->tx_staging[REG_CH_ENABLE] = (uint8_t)(image->config.ch_enable & MULTI_I2C_BRIDGE_CHANNEL_MASK);
    regs->tx_staging[REG_CMD] = image->cmd_readback;
}

void regs_on_write(
    bridge_regs_t *regs,
    bridge_config_t *config,
    sys_status_t *status,
    uint8_t *cmd_readback,
    uint8_t value,
    regs_write_result_t *result) {
    memset(result, 0, sizeof(*result));

    if (regs->expect_ptr) {
        regs->current_ptr = value;
        regs->expect_ptr = false;
        return;
    }

    switch (regs->current_ptr) {
        case REG_CONFIG:
            if ((value & 0xFEu) != 0u) {
                reject_write(status);
            } else {
                config->angle_src = value;
                config->dirty = true;
            }
            break;
        case REG_POLL_PERIOD:
            config->poll_period_ms = value;
            config->dirty = true;
            break;
        case REG_DIR_CONFIG:
            if ((value & 0x40u) != 0u) {
                reject_write(status);
            } else {
                config->dir_config = (uint8_t)(value & MULTI_I2C_BRIDGE_CHANNEL_MASK);
                config->dirty = true;
                if ((value & 0x80u) != 0u) {
                    result->dir_apply_now = true;
                    result->dir_gpio_mask = config->dir_config;
                }
            }
            break;
        case REG_STATUS_DECIM:
            if (value == 0u) {
                reject_write(status);
            } else {
                config->status_decim = value;
                config->dirty = true;
            }
            break;
        case REG_AS5600_CONF_LO:
        case REG_AS5600_CONF_HI: {
            uint16_t candidate = config->as5600_conf;
            if (regs->current_ptr == REG_AS5600_CONF_LO) {
                candidate = (uint16_t)((candidate & 0xFF00u) | value);
            } else {
                candidate = (uint16_t)((candidate & 0x00FFu) | ((uint16_t)value << 8));
            }
            if (!is_as5600_conf_valid(candidate)) {
                reject_write(status);
            } else {
                config->as5600_conf = candidate;
                config->dirty = true;
            }
            break;
        }
        case REG_CH_ENABLE:
            if ((value & (uint8_t)~MULTI_I2C_BRIDGE_CHANNEL_MASK) != 0u ||
                (value & MULTI_I2C_BRIDGE_CHANNEL_MASK) == 0u) {
                reject_write(status);
            } else {
                config->ch_enable = value;
                config->dirty = true;
            }
            break;
        case REG_CMD:
            switch (value) {
                case CMD_NOP:
                    *cmd_readback = CMD_RESULT_IDLE;
                    break;
                case CMD_CLEAR_FAULT:
                    result->clear_fault = true;
                    *cmd_readback = CMD_RESULT_IDLE;
                    break;
                case CMD_MUX_RESET:
                case CMD_RESCAN:
                    if (*cmd_readback == CMD_RESULT_BUSY) {
                        reject_write(status);
                    } else {
                        result->cmd_dispatch = true;
                        result->cmd_opcode = value;
                        *cmd_readback = CMD_RESULT_BUSY;
                    }
                    break;
                case CMD_SOFT_RESET:
                    result->soft_reset = true;
                    *cmd_readback = CMD_RESULT_IDLE;
                    break;
                default:
                    reject_write(status);
                    break;
            }
            break;
        default:
            reject_write(status);
            break;
    }

    regs->current_ptr = (uint8_t)(regs->current_ptr + 1u);
}

uint8_t regs_on_read_byte(bridge_regs_t *regs, sys_status_t *status) {
    uint8_t value = 0xFFu;

    if (regs->current_ptr < MULTI_I2C_BRIDGE_REG_COUNT &&
        is_defined_read_offset(regs->current_ptr)) {
        value = regs->tx_staging[regs->current_ptr];
    } else if (!is_defined_read_offset(regs->current_ptr)) {
        sys_status_set_fault(status, FAULT_PTR_RANGE);
    }
    regs->current_ptr = (uint8_t)(regs->current_ptr + 1u);
    return value;
}

void regs_on_finish(bridge_regs_t *regs) {
    regs->expect_ptr = true;
}
