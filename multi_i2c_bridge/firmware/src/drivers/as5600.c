#include "drivers/as5600.h"

#include "downstream_i2c.h"

enum {
    AS5600_REG_CONF_HI = 0x07,
    AS5600_REG_STATUS = 0x0B,
    AS5600_REG_RAW_ANGLE_HI = 0x0C,
    AS5600_REG_ANGLE_HI = 0x0E,
    AS5600_REG_AGC = 0x1A,
};

bool as5600_read_angle(uint8_t angle_src, uint16_t *angle_out) {
    /* TODO(HW検証): RAW_ANGLE/SF/FTH の実効差分を実機で確認する。 */
    const uint8_t reg = angle_src ? AS5600_REG_ANGLE_HI : AS5600_REG_RAW_ANGLE_HI;
    uint8_t rx[2];

    if (!downstream_i2c_write_read(AS5600_ADDR, &reg, 1u, rx, sizeof(rx))) {
        return false;
    }

    *angle_out = (uint16_t)(((uint16_t)rx[0] << 8) | rx[1]) & 0x0FFFu;
    return true;
}

bool as5600_read_status_agc(uint8_t *status_out, uint8_t *agc_out) {
    const uint8_t status_reg = AS5600_REG_STATUS;
    const uint8_t agc_reg = AS5600_REG_AGC;

    if (!downstream_i2c_write_read(AS5600_ADDR, &status_reg, 1u, status_out, 1u)) {
        return false;
    }
    if (!downstream_i2c_write_read(AS5600_ADDR, &agc_reg, 1u, agc_out, 1u)) {
        return false;
    }
    return true;
}

bool as5600_write_conf(uint16_t conf) {
    const uint8_t tx[3] = {
        AS5600_REG_CONF_HI,
        (uint8_t)((conf >> 8) & 0xFFu),
        (uint8_t)(conf & 0xFFu),
    };
    return downstream_i2c_write(AS5600_ADDR, tx, sizeof(tx));
}
