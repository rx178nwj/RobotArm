#include "sampler.h"

#include "board.h"
#include "core/config.h"
#include "core/fault.h"
#include "drivers/as5600.h"
#include "drivers/tca9548a.h"
#include "runtime.h"
#include "status_led.h"

#include <stdatomic.h>
#include <string.h>

#include "downstream_i2c.h"
#include "hardware/gpio.h"
#include "pico/stdlib.h"

enum { AS5600_STATUS_MD = 1u << 5 };

typedef struct {
    uint8_t status_cycle;
    uint8_t full_scan_failures;
    uint8_t magnet_ok_mask;
    uint8_t failure_streak[MULTI_I2C_BRIDGE_CHANNELS];
    uint16_t applied_conf;
    uint8_t applied_dir;
} sampler_state_t;

static sampler_state_t g_sampler_state;

static uint8_t bit_count(uint8_t value) {
    uint8_t count = 0u;
    for (; value != 0u; value >>= 1u) {
        count = (uint8_t)(count + (value & 0x01u));
    }
    return count;
}

static void seed_snapshot(sensor_snapshot_t *snapshot) {
    memset(snapshot, 0, sizeof(*snapshot));
    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        snapshot->angle[ch] = 0xFFFFu;
        snapshot->agc[ch] = 0xFFu;
    }
}

static void set_disabled_channel(sensor_snapshot_t *snapshot, uint8_t ch) {
    snapshot->angle[ch] = 0xFFFFu;
    snapshot->agc[ch] = 0xFFu;
}

static bool probe_channel(uint8_t ch, bool *magnet_ok) {
    uint16_t angle = 0u;
    uint8_t status_reg = 0u;
    uint8_t agc = 0u;

    if (!tca9548a_select(ch) || !as5600_read_angle(0u, &angle) ||
        !as5600_read_status_agc(&status_reg, &agc)) {
        return false;
    }
    *magnet_ok = (status_reg & AS5600_STATUS_MD) != 0u;
    return true;
}

static uint8_t probe_present_channels(void) {
    uint8_t present = 0u;
    uint8_t magnet_ok = 0u;

    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        bool channel_magnet_ok = false;
        if (probe_channel(ch, &channel_magnet_ok)) {
            present |= (uint8_t)(1u << ch);
            if (channel_magnet_ok) {
                magnet_ok |= (uint8_t)(1u << ch);
            }
        }
    }
    g_sampler_state.magnet_ok_mask = magnet_ok;
    return present;
}

static bool apply_conf_to_present(uint8_t present_mask, uint16_t conf, sys_status_t *status) {
    bool ok = true;

    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        if (((present_mask >> ch) & 0x01u) == 0u) {
            continue;
        }
        if (!tca9548a_select(ch) || !as5600_write_conf(conf)) {
            sys_status_set_ch_fault(status, (uint8_t)(1u << ch));
            status->degraded = true;
            ok = false;
        }
    }
    return ok;
}

static void execute_mailbox_command(void) {
    const uint32_t request_seq = g_cmd_mailbox.req_seq;
    uint8_t result = CMD_RESULT_IDLE;

    if (request_seq == g_cmd_mailbox.ack_seq) {
        return;
    }

    switch (g_cmd_mailbox.req_cmd) {
        case CMD_MUX_RESET:
            tca9548a_reset();
            break;
        case CMD_RESCAN:
            g_ch_present = probe_present_channels();
            break;
        default:
            sys_status_set_fault(&g_status, FAULT_CFG_REJECT);
            result = CMD_RESULT_FAIL;
            break;
    }

    g_cmd_readback = result;
    g_cmd_mailbox.result = result;
    atomic_thread_fence(memory_order_release);
    g_cmd_mailbox.ack_seq = request_seq;
}

static void note_comm_failure(sys_status_t *status, sensor_snapshot_t *snapshot, uint8_t ch) {
    sys_status_set_ch_fault(status, (uint8_t)(1u << ch));
    status->degraded = true;
    snapshot->agc[ch] = 0u;
    if (g_sampler_state.failure_streak[ch] != UINT8_MAX) {
        ++g_sampler_state.failure_streak[ch];
    }
}

static void sample_once(void) {
    const bridge_config_t config = g_config;
    sensor_snapshot_t next;
    sys_status_t loop_status = g_status;
    const uint8_t enabled_mask = (uint8_t)(config.ch_enable & MULTI_I2C_BRIDGE_CHANNEL_MASK);
    uint8_t round_failures = 0u;
    bool recovery_needed = false;
    bool read_status_agc = false;

    sd_snapshot(&g_sensor_data, &next);
    next.ch_ok = 0u;
    loop_status.ch_ok_mask = 0u;
    loop_status.degraded = false;
    loop_status.mux_fault = false;

    g_sampler_state.status_cycle = (uint8_t)(g_sampler_state.status_cycle + 1u);
    if (g_sampler_state.status_cycle >= config.status_decim) {
        g_sampler_state.status_cycle = 0u;
        read_status_agc = true;
    }

    for (uint8_t ch = 0; ch < MULTI_I2C_BRIDGE_CHANNELS; ++ch) {
        uint16_t angle = 0u;
        uint8_t status_reg = 0u;
        uint8_t agc = next.agc[ch];
        const uint8_t channel_bit = (uint8_t)(1u << ch);

        if ((enabled_mask & channel_bit) == 0u) {
            set_disabled_channel(&next, ch);
            g_sampler_state.failure_streak[ch] = 0u;
            continue;
        }

        if (!tca9548a_select(ch) || !as5600_read_angle(config.angle_src, &angle)) {
            note_comm_failure(&loop_status, &next, ch);
            recovery_needed = recovery_needed ||
                              g_sampler_state.failure_streak[ch] >= DS_FAIL_RECOVER_N;
            ++round_failures;
            continue;
        }

        next.angle[ch] = angle;
        g_sampler_state.failure_streak[ch] = 0u;

        if (read_status_agc) {
            if (!as5600_read_status_agc(&status_reg, &agc)) {
                note_comm_failure(&loop_status, &next, ch);
                ++round_failures;
                continue;
            }
            next.agc[ch] = agc;
            if ((status_reg & AS5600_STATUS_MD) != 0u) {
                g_sampler_state.magnet_ok_mask |= channel_bit;
            } else {
                g_sampler_state.magnet_ok_mask &= (uint8_t)~channel_bit;
            }
        }

        if ((g_sampler_state.magnet_ok_mask & channel_bit) != 0u) {
            next.ch_ok |= channel_bit;
        } else {
            loop_status.degraded = true;
        }
    }

    if (recovery_needed) {
        if (!fault_bus_recover(&loop_status)) {
            loop_status.mux_fault = true;
            sys_status_set_fault(&loop_status, FAULT_MUX_NORSP);
        }
        memset(g_sampler_state.failure_streak, 0, sizeof(g_sampler_state.failure_streak));
    }

    if (enabled_mask != 0u && round_failures == bit_count(enabled_mask)) {
        ++g_sampler_state.full_scan_failures;
        if (g_sampler_state.full_scan_failures >= DS_MUXRESET_N) {
            tca9548a_reset();
            loop_status.mux_fault = true;
            sys_status_set_fault(&loop_status, FAULT_MUX_NORSP);
            g_sampler_state.full_scan_failures = 0u;
        }
    } else {
        g_sampler_state.full_scan_failures = 0u;
    }

    loop_status.ch_ok_mask = next.ch_ok;
    loop_status.degraded = loop_status.degraded || ((next.ch_ok & enabled_mask) != enabled_mask);
    next.sample_count += 1u;
    sd_publish(&g_sensor_data, &next);
    status_led_note_downstream_publish();
    g_status = loop_status;
}

static void apply_config_if_needed(void) {
    const bridge_config_t snapshot = g_config;

    if (!snapshot.dirty) {
        return;
    }
    if (g_sampler_state.applied_dir != snapshot.dir_config) {
        runtime_apply_dir_gpio(snapshot.dir_config);
        g_sampler_state.applied_dir = snapshot.dir_config;
    }
    if (g_sampler_state.applied_conf != snapshot.as5600_conf) {
        (void)apply_conf_to_present(
            (uint8_t)(g_ch_present & MULTI_I2C_BRIDGE_CHANNEL_MASK),
            snapshot.as5600_conf,
            &g_status);
        g_sampler_state.applied_conf = snapshot.as5600_conf;
    }
    cfg_mark_clean_if_unchanged(&g_config, &snapshot);
}

static void init_dir_gpio(uint gpio) {
    gpio_init(gpio);
    gpio_set_dir(gpio, GPIO_OUT);
}

void sampler_bootstrap(void) {
    sensor_snapshot_t initial;

    memset(&g_sampler_state, 0, sizeof(g_sampler_state));
    init_dir_gpio(DIR_GPIO_CH0);
    init_dir_gpio(DIR_GPIO_CH1);
    init_dir_gpio(DIR_GPIO_CH2);
    init_dir_gpio(DIR_GPIO_CH3);
    init_dir_gpio(DIR_GPIO_CH4);
    init_dir_gpio(DIR_GPIO_CH5);
    runtime_apply_dir_gpio(g_config.dir_config);
    downstream_i2c_init();
    sleep_ms(AS5600_T_PU_MS);

    g_ch_present = probe_present_channels();
    g_config.ch_enable = (uint8_t)(g_ch_present & MULTI_I2C_BRIDGE_CHANNEL_MASK);
    g_sampler_state.applied_dir = g_config.dir_config;
    g_sampler_state.applied_conf = g_config.as5600_conf;

    /* TODO(HW検証): 0ch 検出時も ready を有効化する方針を実機で確認する。 */
    if (g_config.ch_enable == 0u) {
        g_status.degraded = true;
    }
    (void)apply_conf_to_present(g_config.ch_enable, g_config.as5600_conf, &g_status);

    seed_snapshot(&initial);
    sd_publish(&g_sensor_data, &initial);
    g_sampler_state.status_cycle = (uint8_t)(g_config.status_decim - 1u);
    sample_once();
}

void sampler_run(void) {
    for (;;) {
        const absolute_time_t cycle_start = get_absolute_time();
        execute_mailbox_command();
        sample_once();
        apply_config_if_needed();
        fault_note_core1_alive();
        if (g_config.poll_period_ms != 0u) {
            sleep_until(delayed_by_ms(cycle_start, g_config.poll_period_ms));
        }
    }
}
