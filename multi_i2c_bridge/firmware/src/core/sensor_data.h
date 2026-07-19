#ifndef MULTI_I2C_BRIDGE_CORE_SENSOR_DATA_H
#define MULTI_I2C_BRIDGE_CORE_SENSOR_DATA_H

#include <stdint.h>
#include <stdatomic.h>

#include "board.h"

typedef struct {
    uint16_t angle[MULTI_I2C_BRIDGE_CHANNELS];
    uint8_t agc[MULTI_I2C_BRIDGE_CHANNELS];
    uint8_t ch_ok;
    uint32_t sample_count;
} sensor_snapshot_t;

typedef struct {
    sensor_snapshot_t buffers[2];
    atomic_uint active_index;
} sensor_data_t;

void sd_init(sensor_data_t *data);
void sd_publish(sensor_data_t *data, const sensor_snapshot_t *next);
void sd_snapshot(const sensor_data_t *data, sensor_snapshot_t *out);

#endif
