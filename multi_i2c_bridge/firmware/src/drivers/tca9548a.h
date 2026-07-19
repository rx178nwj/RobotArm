#ifndef MULTI_I2C_BRIDGE_DRIVERS_TCA9548A_H
#define MULTI_I2C_BRIDGE_DRIVERS_TCA9548A_H

#include <stdbool.h>
#include <stdint.h>

bool tca9548a_select(uint8_t channel);
void tca9548a_reset(void);

#endif
