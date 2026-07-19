#ifndef MULTI_I2C_BRIDGE_DRIVERS_AS5600_H
#define MULTI_I2C_BRIDGE_DRIVERS_AS5600_H

#include <stdbool.h>
#include <stdint.h>

bool as5600_read_angle(uint8_t angle_src, uint16_t *angle_out);
bool as5600_read_status_agc(uint8_t *status_out, uint8_t *agc_out);
bool as5600_write_conf(uint16_t conf);

#endif
