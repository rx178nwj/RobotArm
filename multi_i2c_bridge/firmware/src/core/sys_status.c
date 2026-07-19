#include "core/sys_status.h"

void sys_status_init(sys_status_t *status) {
    status->fault = 0u;
    status->ch_fault = 0u;
    status->ch_ok_mask = 0u;
    status->mux_fault = false;
    status->degraded = false;
}

void sys_status_clear_faults(sys_status_t *status) {
    status->fault = 0u;
    status->ch_fault = 0u;
    status->mux_fault = false;
}

void sys_status_set_fault(sys_status_t *status, uint8_t bits) {
    status->fault = (uint8_t)(status->fault | bits);
}

void sys_status_set_ch_fault(sys_status_t *status, uint8_t bits) {
    status->ch_fault = (uint8_t)(status->ch_fault | (bits & 0x3Fu));
}

uint8_t sys_status_compose_lo(const sys_status_t *status) {
    return (uint8_t)(status->ch_ok_mask & 0x3Fu);
}

uint8_t sys_status_compose_hi(const sys_status_t *status, bool data_new) {
    uint8_t value = 0u;
    if (status->degraded) {
        value |= STATUS_HI_DEGRADED;
    }
    if (data_new) {
        value |= STATUS_HI_DATA_NEW;
    }
    if (status->mux_fault) {
        value |= STATUS_HI_MUX_FAULT;
    }
    if (status->fault != 0u || status->ch_fault != 0u) {
        value |= STATUS_HI_ERR;
    }
    return value;
}
