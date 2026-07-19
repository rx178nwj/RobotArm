#include "upstream_i2c.h"

#include "board.h"
#include "runtime.h"
#include "status_led.h"

#include <stdatomic.h>

#include "hardware/gpio.h"
#include "hardware/i2c.h"
#include "hardware/watchdog.h"
#include "pico/i2c_slave.h"

static bool s_read_active;

static void upstream_snapshot_regs(void) {
    regs_image_t image;

    image.config = g_config;
    image.status = g_status;
    sd_snapshot(&g_sensor_data, &image.sensor);
    image.status.ch_ok_mask = image.sensor.ch_ok;
    image.ch_present = g_ch_present;
    image.cmd_readback = g_cmd_readback;
    regs_snapshot(&g_regs, &image);
}

static void upstream_handle_result(const regs_write_result_t *result) {
    if (result->clear_fault) {
        sys_status_clear_faults(&g_status);
    }
    if (result->dir_apply_now) {
        runtime_apply_dir_gpio(result->dir_gpio_mask);
    }
    if (result->cmd_dispatch) {
        g_cmd_mailbox.req_cmd = result->cmd_opcode;
        atomic_thread_fence(memory_order_seq_cst);
        g_cmd_mailbox.req_seq = g_cmd_mailbox.req_seq + 1u;
    }
    if (result->soft_reset) {
        watchdog_reboot(0u, 0u, 0u);
    }
}

static void upstream_i2c_handler(i2c_inst_t *i2c, i2c_slave_event_t event) {
    regs_write_result_t result;

    switch (event) {
        case I2C_SLAVE_RECEIVE:
            status_led_note_upstream_activity();
            s_read_active = false;
            regs_on_write(&g_regs, &g_config, &g_status, (uint8_t *)&g_cmd_readback, i2c_read_byte_raw(i2c), &result);
            upstream_handle_result(&result);
            break;
        case I2C_SLAVE_REQUEST:
            status_led_note_upstream_activity();
            if (!s_read_active) {
                upstream_snapshot_regs();
                s_read_active = true;
            }
            i2c_write_byte_raw(i2c, regs_on_read_byte(&g_regs, &g_status));
            break;
        case I2C_SLAVE_FINISH:
            s_read_active = false;
            regs_on_finish(&g_regs);
            break;
        default:
            break;
    }
}

void upstream_i2c_init(void) {
    s_read_active = false;
    gpio_set_function(UP_SDA_GPIO, GPIO_FUNC_I2C);
    gpio_set_function(UP_SCL_GPIO, GPIO_FUNC_I2C);
    gpio_pull_up(UP_SDA_GPIO);
    gpio_pull_up(UP_SCL_GPIO);
    (void)i2c_init(UP_I2C, I2C_BAUD_HZ);
    i2c_slave_init(UP_I2C, BRIDGE_ADDR, upstream_i2c_handler);
}
