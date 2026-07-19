#include "core/fault.h"
#include "runtime.h"
#include "sampler.h"
#include "status_led.h"
#include "upstream_i2c.h"

#include "pico/multicore.h"
#include "pico/stdlib.h"

int main(void) {
    stdio_init_all();

    sys_status_init(&g_status);
    if (fault_watchdog_caused_reboot()) {
        sys_status_set_fault(&g_status, FAULT_WDT_RESET);
    }
    cfg_init(&g_config, 0u);
    sd_init(&g_sensor_data);
    regs_init(&g_regs);
    fault_init();
    status_led_init();
    sampler_bootstrap();

    upstream_i2c_init();
    multicore_launch_core1(sampler_run);
    fault_arm_watchdog();

    for (;;) {
        fault_note_core0_alive();
        fault_kick_watchdog();
        status_led_service(&g_status);
        sleep_ms(1);
    }
}
