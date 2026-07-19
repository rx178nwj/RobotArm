#include "status_led.h"

#include "board.h"

#include "hardware/gpio.h"
#include "pico/time.h"

enum { STATUS_LED_PERIOD_MS = 200u };

static volatile uint32_t s_last_upstream_ms;
static volatile uint32_t s_last_publish_ms;
static volatile bool s_upstream_seen;
static volatile bool s_publish_seen;
static uint32_t s_last_service_ms;
static bool s_blue_on;
static bool s_yellow_on;

static void init_led_gpio(uint gpio) {
    gpio_init(gpio);
    gpio_set_dir(gpio, GPIO_OUT);
    gpio_put(gpio, 0);
}

static uint32_t now_ms(void) {
    return to_ms_since_boot(get_absolute_time());
}

void status_led_init(void) {
    init_led_gpio(BLUE_LED_GPIO);
    init_led_gpio(YELLOW_LED_GPIO);
    init_led_gpio(RED_LED_GPIO);
    s_last_upstream_ms = 0u;
    s_last_publish_ms = 0u;
    s_upstream_seen = false;
    s_publish_seen = false;
    s_last_service_ms = now_ms();
    s_blue_on = false;
    s_yellow_on = false;
}

void status_led_note_upstream_activity(void) {
    s_last_upstream_ms = now_ms();
    s_upstream_seen = true;
}

void status_led_note_downstream_publish(void) {
    s_last_publish_ms = now_ms();
    s_publish_seen = true;
}

void status_led_service(const sys_status_t *status) {
    const uint32_t now = now_ms();

    gpio_put(RED_LED_GPIO, status->fault != 0u || status->ch_fault != 0u);
    if ((uint32_t)(now - s_last_service_ms) < STATUS_LED_PERIOD_MS) {
        return;
    }
    s_last_service_ms = now;

    if (s_upstream_seen && (uint32_t)(now - s_last_upstream_ms) <= STATUS_LED_PERIOD_MS) {
        s_blue_on = !s_blue_on;
    } else {
        s_blue_on = false;
    }
    if (s_publish_seen && (uint32_t)(now - s_last_publish_ms) <= STATUS_LED_PERIOD_MS) {
        s_yellow_on = !s_yellow_on;
    } else {
        s_yellow_on = false;
    }
    gpio_put(BLUE_LED_GPIO, s_blue_on);
    gpio_put(YELLOW_LED_GPIO, s_yellow_on);
}
