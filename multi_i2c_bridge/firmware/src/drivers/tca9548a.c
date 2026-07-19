#include "drivers/tca9548a.h"

#include "board.h"
#include "downstream_i2c.h"

#include "hardware/gpio.h"
#include "pico/time.h"

bool tca9548a_select(uint8_t channel) {
    const uint8_t value = (uint8_t)(1u << channel);
    return downstream_i2c_write(MUX_ADDR, &value, 1u);
}

void tca9548a_reset(void) {
    gpio_put(MUX_RESET_GPIO, 0);
    sleep_us(10);
    gpio_put(MUX_RESET_GPIO, 1);
    sleep_ms(1);
}
