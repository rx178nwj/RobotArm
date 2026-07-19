cmake_minimum_required(VERSION 3.19)

set(CMAKE_C_STANDARD 11)
set(CMAKE_C_STANDARD_REQUIRED ON)
set(CMAKE_C_EXTENSIONS OFF)

option(MULTI_I2C_BRIDGE_HOST_TESTS_ONLY "Configure only the native host unit tests" OFF)
option(MULTI_I2C_BRIDGE_ENABLE_LOG "Enable stdio logging" OFF)

if(MULTI_I2C_BRIDGE_HOST_TESTS_ONLY)
    project(multi_i2c_bridge_host_tests C)
    enable_testing()

    add_executable(multi_i2c_bridge_tests
        test/test_main.c
        src/bridge_regs.c
        src/core/sensor_data.c
        src/core/config.c
        src/core/sys_status.c
    )
    target_include_directories(multi_i2c_bridge_tests PRIVATE
        ${CMAKE_CURRENT_LIST_DIR}/src
    )
    target_compile_options(multi_i2c_bridge_tests PRIVATE
        -Wall
        -Wextra
        -Werror
    )
    add_test(NAME multi_i2c_bridge_tests COMMAND multi_i2c_bridge_tests)
    return()
endif()

include(pico_sdk_import.cmake)

project(multi_i2c_bridge_firmware C CXX ASM)

pico_sdk_init()

set(MULTI_I2C_BRIDGE_SOURCES
    src/main.c
    src/runtime.c
    src/status_led.c
    src/upstream_i2c.c
    src/bridge_regs.c
    src/sampler.c
    src/downstream_i2c.c
    src/drivers/as5600.c
    src/drivers/tca9548a.c
    src/core/sensor_data.c
    src/core/config.c
    src/core/sys_status.c
    src/core/fault.c
)

add_executable(multi_i2c_bridge
    ${MULTI_I2C_BRIDGE_SOURCES}
)

target_include_directories(multi_i2c_bridge PRIVATE
    ${CMAKE_CURRENT_LIST_DIR}/src
)

target_compile_options(multi_i2c_bridge PRIVATE
    -Wall
    -Wextra
    -Werror
)

target_compile_definitions(multi_i2c_bridge PRIVATE
    $<$<BOOL:${MULTI_I2C_BRIDGE_ENABLE_LOG}>:MULTI_I2C_BRIDGE_ENABLE_LOG=1>
)

target_link_libraries(multi_i2c_bridge PRIVATE
    pico_stdlib
    pico_multicore
    hardware_i2c
    hardware_gpio
    hardware_watchdog
    pico_i2c_slave
)

pico_enable_stdio_uart(multi_i2c_bridge 0)
pico_enable_stdio_usb(multi_i2c_bridge 0)
pico_add_extra_outputs(multi_i2c_bridge)
