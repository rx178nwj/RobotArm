#include "runtime.h"

#include "board.h"

#include "hardware/gpio.h"

bridge_regs_t g_regs;
bridge_config_t g_config;
sys_status_t g_status;
sensor_data_t g_sensor_data;
volatile uint8_t g_cmd_readback = CMD_RESULT_IDLE;
volatile uint8_t g_ch_present = 0u;
volatile cmd_mailbox_t g_cmd_mailbox = {0};

void runtime_apply_dir_gpio(uint8_t dir_mask) {
    gpio_put(DIR_GPIO_CH0, (dir_mask >> 0) & 0x01u);
    gpio_put(DIR_GPIO_CH1, (dir_mask >> 1) & 0x01u);
    gpio_put(DIR_GPIO_CH2, (dir_mask >> 2) & 0x01u);
    gpio_put(DIR_GPIO_CH3, (dir_mask >> 3) & 0x01u);
    gpio_put(DIR_GPIO_CH4, (dir_mask >> 4) & 0x01u);
    gpio_put(DIR_GPIO_CH5, (dir_mask >> 5) & 0x01u);
}
