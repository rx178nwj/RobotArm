#include "core/fault.h"

#include "board.h"
#include "downstream_i2c.h"

#include "hardware/gpio.h"
#include "hardware/watchdog.h"
#include "pico/time.h"

static volatile uint32_t s_core0_counter = 0u;
static volatile uint32_t s_core1_counter = 0u;
static uint32_t s_last_core0_counter = 0u;
static uint32_t s_last_core1_counter = 0u;

static void line_release(uint gpio) {
    gpio_set_dir(gpio, GPIO_IN);
    gpio_pull_up(gpio);
}

static void line_drive_low(uint gpio) {
    gpio_put(gpio, 0);
    gpio_set_dir(gpio, GPIO_OUT);
}

static void downstream_gpio_to_sio(void) {
    gpio_set_function(DS_SDA_GPIO, GPIO_FUNC_SIO);
    gpio_set_function(DS_SCL_GPIO, GPIO_FUNC_SIO);
    gpio_pull_up(DS_SDA_GPIO);
    gpio_pull_up(DS_SCL_GPIO);
}

static bool bus_lines_released(void) {
    return gpio_get(DS_SDA_GPIO) && gpio_get(DS_SCL_GPIO);
}

void fault_init(void) {
    watchdog_start_tick(12);
}

void fault_arm_watchdog(void) {
    watchdog_enable(WDT_TIMEOUT_MS, true);
}

bool fault_watchdog_caused_reboot(void) {
    return watchdog_enable_caused_reboot();
}

void fault_note_core0_alive(void) {
    ++s_core0_counter;
}

void fault_note_core1_alive(void) {
    ++s_core1_counter;
}

bool fault_bus_recover(sys_status_t *status) {
    sys_status_set_fault(status, FAULT_BUS_RECOVER);
    downstream_gpio_to_sio();
    line_release(DS_SDA_GPIO);
    line_release(DS_SCL_GPIO);
    sleep_us(4);

    for (uint8_t i = 0; i < 9u && !gpio_get(DS_SDA_GPIO); ++i) {
        line_drive_low(DS_SCL_GPIO);
        sleep_us(4);
        line_release(DS_SCL_GPIO);
        sleep_us(4);
    }

    line_drive_low(DS_SDA_GPIO);
    sleep_us(4);
    line_release(DS_SCL_GPIO);
    sleep_us(4);
    line_release(DS_SDA_GPIO);
    sleep_us(4);

    downstream_i2c_init();
    return bus_lines_released();
}

void fault_kick_watchdog(void) {
    const uint32_t core0_counter = s_core0_counter;
    const uint32_t core1_counter = s_core1_counter;

    if (core0_counter != s_last_core0_counter && core1_counter != s_last_core1_counter) {
        watchdog_update();
        s_last_core0_counter = core0_counter;
        s_last_core1_counter = core1_counter;
    }
}
