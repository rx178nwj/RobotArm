#ifndef MULTI_I2C_BRIDGE_CORE_SYS_STATUS_H
#define MULTI_I2C_BRIDGE_CORE_SYS_STATUS_H

#include <stdbool.h>
#include <stdint.h>

enum {
    STATUS_HI_DEGRADED = 1u << 0,
    STATUS_HI_DATA_NEW = 1u << 1,
    STATUS_HI_MUX_FAULT = 1u << 2,
    STATUS_HI_ERR = 1u << 7,
};

enum {
    FAULT_MUX_NORSP = 1u << 0,
    FAULT_BUS_RECOVER = 1u << 1,
    FAULT_CFG_REJECT = 1u << 2,
    FAULT_WDT_RESET = 1u << 3,
    FAULT_PTR_RANGE = 1u << 4,
};

typedef struct {
    uint8_t fault;
    uint8_t ch_fault;
    uint8_t ch_ok_mask;
    bool mux_fault;
    bool degraded;
} sys_status_t;

void sys_status_init(sys_status_t *status);
void sys_status_clear_faults(sys_status_t *status);
void sys_status_set_fault(sys_status_t *status, uint8_t bits);
void sys_status_set_ch_fault(sys_status_t *status, uint8_t bits);
uint8_t sys_status_compose_lo(const sys_status_t *status);
uint8_t sys_status_compose_hi(const sys_status_t *status, bool data_new);

#endif
