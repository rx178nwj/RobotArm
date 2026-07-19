#include "core/sensor_data.h"

#include <string.h>

void sd_init(sensor_data_t *data) {
    memset(data, 0, sizeof(*data));
    atomic_init(&data->active_index, 0u);
}

void sd_publish(sensor_data_t *data, const sensor_snapshot_t *next) {
    const unsigned int current = atomic_load_explicit(&data->active_index, memory_order_relaxed);
    const unsigned int next_index = current ^ 1u;

    data->buffers[next_index] = *next;
    atomic_store_explicit(&data->active_index, next_index, memory_order_release);
}

void sd_snapshot(const sensor_data_t *data, sensor_snapshot_t *out) {
    const unsigned int index = atomic_load_explicit(&data->active_index, memory_order_acquire);
    *out = data->buffers[index];
}
