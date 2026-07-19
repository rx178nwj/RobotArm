#include "core/config.h"

#include "board.h"

void cfg_init(bridge_config_t *config, uint8_t ch_present) {
    config->angle_src = 0u;
    config->poll_period_ms = POLL_PERIOD_DEFAULT;
    config->status_decim = STATUS_DECIM_DEFAULT;
    config->as5600_conf = AS5600_CONF_DEFAULT;
    config->dir_config = 0u;
    config->ch_enable = (uint8_t)(ch_present & MULTI_I2C_BRIDGE_CHANNEL_MASK);
    config->dirty = false;
}

void cfg_mark_clean(bridge_config_t *config) {
    config->dirty = false;
}

bool cfg_matches(const bridge_config_t *lhs, const bridge_config_t *rhs) {
    return lhs->angle_src == rhs->angle_src &&
           lhs->poll_period_ms == rhs->poll_period_ms &&
           lhs->status_decim == rhs->status_decim &&
           lhs->as5600_conf == rhs->as5600_conf &&
           lhs->dir_config == rhs->dir_config &&
           lhs->ch_enable == rhs->ch_enable;
}

void cfg_mark_clean_if_unchanged(bridge_config_t *shared, const bridge_config_t *applied) {
    if (cfg_matches(shared, applied)) {
        shared->dirty = false;
    }
}
