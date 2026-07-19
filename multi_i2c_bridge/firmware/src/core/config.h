#ifndef MULTI_I2C_BRIDGE_CORE_CONFIG_H
#define MULTI_I2C_BRIDGE_CORE_CONFIG_H

#include <stdbool.h>
#include <stdint.h>

typedef struct {
    uint8_t angle_src;
    uint8_t poll_period_ms;
    uint8_t status_decim;
    uint16_t as5600_conf;
    uint8_t dir_config;
    uint8_t ch_enable;
    bool dirty;
} bridge_config_t;

void cfg_init(bridge_config_t *config, uint8_t ch_present);
void cfg_mark_clean(bridge_config_t *config);
bool cfg_matches(const bridge_config_t *lhs, const bridge_config_t *rhs);
void cfg_mark_clean_if_unchanged(bridge_config_t *shared, const bridge_config_t *applied);

#endif
