#ifndef MULTI_I2C_BRIDGE_BOARD_H
#define MULTI_I2C_BRIDGE_BOARD_H

#define MULTI_I2C_BRIDGE_CHANNELS 6u
#define MULTI_I2C_BRIDGE_CHANNEL_MASK 0x3Fu
#define MULTI_I2C_BRIDGE_REG_COUNT 0x51u

#define UP_I2C i2c0
#define UP_SDA_GPIO 0
#define UP_SCL_GPIO 1
#define DS_I2C i2c1
#define DS_SDA_GPIO 2
#define DS_SCL_GPIO 3
#define MUX_RESET_GPIO 4
#define DIR_GPIO_CH0 5
#define DIR_GPIO_CH1 6
#define DIR_GPIO_CH2 7
#define DIR_GPIO_CH3 8
#define DIR_GPIO_CH4 9
#define DIR_GPIO_CH5 10

/* WisdPi Tiny RP2040 onboard indicators. */
#define BLUE_LED_GPIO 25
#define YELLOW_LED_GPIO 27
#define RED_LED_GPIO 28
#define WS281_GPIO 29

#define BRIDGE_ADDR 0x42
#define MUX_ADDR 0x70
#define AS5600_ADDR 0x36

#define I2C_BAUD_HZ 400000

#define WHO_AM_I_VAL 0xB6
#define VERSION_VAL 0x10
#define AS5600_CONF_DEFAULT 0x0A00

/* TODO(HW検証): RESCAN/MUX_RESET の実測 busy 時間を見て最終調整する。 */
#define WDT_TIMEOUT_MS 500
#define DS_XFER_TIMEOUT_US 1000
#define DS_FAIL_RECOVER_N 3
#define DS_MUXRESET_N 2
#define STATUS_DECIM_DEFAULT 9
#define POLL_PERIOD_DEFAULT 0
#define AS5600_T_PU_MS 10
/* TODO(HW検証): power-on から ready までの実測で見直す。 */
#define READY_BUDGET_MS 100

#endif
