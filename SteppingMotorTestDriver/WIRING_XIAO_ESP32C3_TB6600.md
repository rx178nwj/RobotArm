# XIAO ESP32C3 - Microstep Driver Wiring With NPN Transistors

This wiring is for a TB6600-compatible microstep driver with these control
inputs:

- `PUL+ / PUL-`
- `DIR+ / DIR-`
- `ENA+ / ENA-`

The XIAO ESP32C3 uses 3.3 V GPIO, so it should not drive the driver inputs
directly. Instead, use NPN transistors as low-side switches.

## Recommended parts

- 3 x NPN transistor
  - `2N3904`
  - `PN2222A`
  - `2SC1815`
- 3 x base resistor: `2.2k ohm`
- 3 x base pull-down resistor: `10k ohm`
- 3 x input current resistor: `330 ohm` to `470 ohm`
- 1 x 5 V supply for the control input side
- 1 x motor power supply for the driver main power input

## Wiring concept

The driver input side is powered from 5 V, and each NPN transistor pulls the
matching `-` terminal down to GND when the GPIO goes HIGH.

## Wiring diagram

```text
XIAO ESP32C3                               TB6600-compatible driver
-------------------------                  ------------------------------

5V -------------------------------------> PUL+ through 330-470 ohm
D6 --- 2.2k --- Base   Q1
               10k
                |
GND ------------+
Emitter(Q1) ----------------------------> GND
Collector(Q1) --------------------------> PUL-

5V -------------------------------------> DIR+ through 330-470 ohm
D5 --- 2.2k --- Base   Q2
               10k
                |
GND ------------+
Emitter(Q2) ----------------------------> GND
Collector(Q2) --------------------------> DIR-

5V -------------------------------------> ENA+ through 330-470 ohm
D4 --- 2.2k --- Base   Q3
               10k
                |
GND ------------+
Emitter(Q3) ----------------------------> GND
Collector(Q3) --------------------------> ENA-

XIAO GND -------------------------------- common GND
5V supply GND --------------------------- common GND

Motor PSU + -----------------------------> VCC
Motor PSU - -----------------------------> GND

Stepper coil A -------------------------> A+ / A-
Stepper coil B -------------------------> B+ / B-
```

## One-channel example

```text
XIAO D6 ---- 2.2k ---- Base(2N3904)
                    |
                   10k
                    |
GND ----------------+

Emitter(2N3904) --- GND
Collector(2N3904) - PUL-

5V ---- 330 to 470 ohm ---- PUL+
```

## How it works

- `PUL+`, `DIR+`, `ENA+` each receive 5 V through a resistor.
- The NPN transistor switches the matching `PUL-`, `DIR-`, `ENA-` line to GND.
- GPIO `HIGH` turns the transistor on, so input current flows and the driver
  sees an active signal.
- GPIO `LOW` turns the transistor off.

## Important notes

- A small NPN transistor is enough because the driver input current is usually
  in the mA range.
- `ENA` is optional for early testing. You can leave `ENA+` and `ENA-`
  disconnected at first and only wire `PUL` and `DIR`.
- Do not connect `5V` directly to the XIAO GPIO pins.
- Connect the XIAO GND and the driver control-side GND together.

## Example pin assignment

- `D6` -> `PUL`
- `D5` -> `DIR`
- `D4` -> `ENA`

## Bring-up recommendation

For first testing:

- wire only `PUL` and `DIR`
- leave `ENA` disconnected
- set the driver microstep switch to a known value
- match `STEPS_PER_REVOLUTION` in the sketch to that pulse-per-revolution value
- start with a slow pulse rate
