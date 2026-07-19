#include "downstream_i2c.h"

#include "board.h"

#include "hardware/gpio.h"
#include "hardware/i2c.h"

void downstream_i2c_init(void) {
    gpio_set_function(DS_SDA_GPIO, GPIO_FUNC_I2C);
    gpio_set_function(DS_SCL_GPIO, GPIO_FUNC_I2C);
    gpio_pull_up(DS_SDA_GPIO);
    gpio_pull_up(DS_SCL_GPIO);
    gpio_init(MUX_RESET_GPIO);
    gpio_set_dir(MUX_RESET_GPIO, GPIO_OUT);
    gpio_put(MUX_RESET_GPIO, 1);
    (void)i2c_init(DS_I2C, I2C_BAUD_HZ);
}

bool downstream_i2c_write(uint8_t addr, const uint8_t *data, size_t len) {
    return i2c_write_timeout_us(DS_I2C, addr, data, len, false, DS_XFER_TIMEOUT_US) == (int)len;
}

bool downstream_i2c_write_read(uint8_t addr, const uint8_t *tx, size_t tx_len, uint8_t *rx, size_t rx_len) {
    if (i2c_write_timeout_us(DS_I2C, addr, tx, tx_len, rx_len != 0u, DS_XFER_TIMEOUT_US) != (int)tx_len) {
        return false;
    }
    if (rx_len == 0u) {
        return true;
    }
    return i2c_read_timeout_us(DS_I2C, addr, rx, rx_len, false, DS_XFER_TIMEOUT_US) == (int)rx_len;
}
