#include <assert.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include "bridge_regs.h"
#include "core/config.h"
#include "core/sensor_data.h"
#include "core/sys_status.h"

static regs_image_t make_image(void) {
    regs_image_t image;

    memset(&image, 0, sizeof(image));
    cfg_init(&image.config, MULTI_I2C_BRIDGE_CHANNEL_MASK);
    sys_status_init(&image.status);
    image.status.ch_ok_mask = MULTI_I2C_BRIDGE_CHANNEL_MASK;
    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        image.sensor.angle[ch] = (uint16_t)(0x0123u + ch * 0x0111u);
        image.sensor.agc[ch] = (uint8_t)(0x10u + ch);
    }
    image.sensor.ch_ok = MULTI_I2C_BRIDGE_CHANNEL_MASK;
    image.sensor.sample_count = 0x01020304u;
    image.ch_present = MULTI_I2C_BRIDGE_CHANNEL_MASK;
    image.cmd_readback = CMD_RESULT_IDLE;
    return image;
}

static void set_pointer(bridge_regs_t *regs, regs_image_t *image, uint8_t pointer) {
    regs_write_result_t result;
    regs_on_finish(regs);
    regs_on_write(regs, &image->config, &image->status, &image->cmd_readback, pointer, &result);
}

static void write_register(bridge_regs_t *regs, regs_image_t *image, uint8_t pointer, uint8_t value,
                           regs_write_result_t *result) {
    set_pointer(regs, image, pointer);
    regs_on_write(regs, &image->config, &image->status, &image->cmd_readback, value, result);
}

static void test_sensor_data_snapshot(void) {
    sensor_data_t data;
    sensor_snapshot_t next;
    sensor_snapshot_t snap;

    memset(&next, 0, sizeof(next));
    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        next.angle[ch] = ch;
        next.agc[ch] = (uint8_t)(0x20u + ch);
    }
    next.ch_ok = 0x2Du;
    next.sample_count = 7u;

    sd_init(&data);
    sd_publish(&data, &next);
    sd_snapshot(&data, &snap);

    assert(memcmp(&snap, &next, sizeof(next)) == 0);
}

static void test_exact_v1_map_and_hot_path(void) {
    bridge_regs_t regs;
    regs_image_t image = make_image();
    sys_status_t read_status;

    regs_init(&regs);
    regs_snapshot(&regs, &image);
    sys_status_init(&read_status);

    set_pointer(&regs, &image, 0x00u);
    assert(regs_on_read_byte(&regs, &read_status) == WHO_AM_I_VAL);
    assert(regs_on_read_byte(&regs, &read_status) == 0x10u);
    assert(regs_on_read_byte(&regs, &read_status) == 0x3Fu);
    assert(regs_on_read_byte(&regs, &read_status) == STATUS_HI_DATA_NEW);

    set_pointer(&regs, &image, 0x08u);
    assert(regs_on_read_byte(&regs, &read_status) == 0x04u);
    assert(regs_on_read_byte(&regs, &read_status) == 0x03u);
    assert(regs_on_read_byte(&regs, &read_status) == 0x02u);
    assert(regs_on_read_byte(&regs, &read_status) == 0x01u);

    set_pointer(&regs, &image, 0x10u);
    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        const uint16_t expected = image.sensor.angle[ch];
        assert(regs_on_read_byte(&regs, &read_status) == (uint8_t)expected);
        assert(regs_on_read_byte(&regs, &read_status) == (uint8_t)(expected >> 8));
    }
    assert(regs_on_read_byte(&regs, &read_status) == 0x3Fu);
    assert(regs_on_read_byte(&regs, &read_status) == STATUS_HI_DATA_NEW);
    assert(regs_on_read_byte(&regs, &read_status) == 0x04u);

    set_pointer(&regs, &image, 0x30u);
    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        assert(regs_on_read_byte(&regs, &read_status) == (uint8_t)(0x10u + ch));
    }
}

static void test_fault_layout_and_reserved_reads(void) {
    bridge_regs_t regs;
    regs_image_t image = make_image();
    sys_status_t read_status;

    image.status.fault = FAULT_BUS_RECOVER;
    image.status.ch_fault = 0x20u;
    image.status.degraded = true;
    regs_init(&regs);
    regs_snapshot(&regs, &image);
    sys_status_init(&read_status);

    set_pointer(&regs, &image, 0x03u);
    assert(regs_on_read_byte(&regs, &read_status) ==
           (STATUS_HI_DEGRADED | STATUS_HI_DATA_NEW | STATUS_HI_ERR));
    assert(regs_on_read_byte(&regs, &read_status) == FAULT_BUS_RECOVER);
    assert(regs_on_read_byte(&regs, &read_status) == 0x20u);
    assert(regs_on_read_byte(&regs, &read_status) == 0xFFu);
    assert((read_status.fault & FAULT_PTR_RANGE) != 0u);

    regs_snapshot(&regs, &image);
    set_pointer(&regs, &image, 0x03u);
    assert(regs_on_read_byte(&regs, &read_status) ==
           (STATUS_HI_DEGRADED | STATUS_HI_ERR));
}

static void test_config_validation_and_six_channel_masks(void) {
    bridge_regs_t regs;
    regs_image_t image = make_image();
    regs_write_result_t result;

    regs_init(&regs);
    write_register(&regs, &image, 0x43u, 0x00u, &result);
    assert((image.status.fault & FAULT_CFG_REJECT) != 0u);
    assert(image.config.status_decim == STATUS_DECIM_DEFAULT);

    image.status.fault = 0u;
    write_register(&regs, &image, 0x47u, 0x20u, &result);
    assert(image.config.ch_enable == 0x20u);
    assert(image.config.dirty);

    image.config.dirty = false;
    write_register(&regs, &image, 0x47u, 0x40u, &result);
    assert((image.status.fault & FAULT_CFG_REJECT) != 0u);
    assert(image.config.ch_enable == 0x20u);

    image.status.fault = 0u;
    write_register(&regs, &image, 0x42u, 0xA1u, &result);
    assert(image.config.dir_config == 0x21u);
    assert(result.dir_apply_now);
    assert(result.dir_gpio_mask == 0x21u);
}

static void test_disabled_channel_markers(void) {
    bridge_regs_t regs;
    regs_image_t image = make_image();
    sys_status_t read_status;

    image.config.ch_enable = 0x01u;
    regs_init(&regs);
    regs_snapshot(&regs, &image);
    sys_status_init(&read_status);

    set_pointer(&regs, &image, 0x12u);
    assert(regs_on_read_byte(&regs, &read_status) == 0xFFu);
    assert(regs_on_read_byte(&regs, &read_status) == 0xFFu);
    set_pointer(&regs, &image, 0x31u);
    assert(regs_on_read_byte(&regs, &read_status) == 0xFFu);
}

static void test_read_only_write_and_cmd_busy_reject(void) {
    bridge_regs_t regs;
    regs_image_t image = make_image();
    regs_write_result_t result;

    regs_init(&regs);
    write_register(&regs, &image, 0x00u, 0x12u, &result);
    assert((image.status.fault & FAULT_CFG_REJECT) != 0u);

    image.status.fault = 0u;
    write_register(&regs, &image, 0x50u, CMD_RESCAN, &result);
    assert(result.cmd_dispatch);
    assert(image.cmd_readback == CMD_RESULT_BUSY);

    write_register(&regs, &image, 0x50u, CMD_MUX_RESET, &result);
    assert(!result.cmd_dispatch);
    assert((image.status.fault & FAULT_CFG_REJECT) != 0u);
}

int main(void) {
    test_sensor_data_snapshot();
    test_exact_v1_map_and_hot_path();
    test_fault_layout_and_reserved_reads();
    test_config_validation_and_six_channel_masks();
    test_disabled_channel_markers();
    test_read_only_write_and_cmd_busy_reject();
    return 0;
}
