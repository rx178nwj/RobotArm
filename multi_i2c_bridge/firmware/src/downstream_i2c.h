#ifndef MULTI_I2C_BRIDGE_DOWNSTREAM_I2C_H
#define MULTI_I2C_BRIDGE_DOWNSTREAM_I2C_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

void downstream_i2c_init(void);
bool downstream_i2c_write(uint8_t addr, const uint8_t *data, size_t len);
bool downstream_i2c_write_read(uint8_t addr, const uint8_t *tx, size_t tx_len, uint8_t *rx, size_t rx_len);

#endif
