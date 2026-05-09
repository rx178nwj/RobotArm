#include <Arduino.h>
#line 1 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
#ifndef D4
#define D4 6
#endif

#ifndef D5
#define D5 7
#endif

#ifndef D6
#define D6 21
#endif

namespace {
const uint8_t STEP_PIN = D6;
const uint8_t DIR_PIN = D5;
const uint8_t ENABLE_PIN = D4;

// 17HS4401S is typically 1.8 deg/step = 200 full steps/rev.
// If the driver is set to microstepping, change this value to match
// the driver's pulse setting (for example 1600, 3200, etc.).
const int STEPS_PER_REVOLUTION = 200;
const int TEST_REVOLUTIONS = 10;

const bool ENABLE_ACTIVE_LOW = false;
const bool FORWARD_DIR_LEVEL = HIGH;

const unsigned int STEP_PULSE_US = 800;
const unsigned int STEP_INTERVAL_US = 800;
const unsigned long BETWEEN_MOVES_MS = 1500;
}

#line 32 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
void setDriverEnabled(bool enabled);
#line 37 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
void stepMotor(long steps, bool forward);
#line 49 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
void runRotationTest(bool forward, int revolutions);
#line 62 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
void setup();
#line 77 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
void loop();
#line 32 "H:\\OneDrive\\CraftWork\\RobotArm2\\SteppingMotorTestDriver\\SteppingMotorTestDriver.ino"
void setDriverEnabled(bool enabled) {
  const bool level = ENABLE_ACTIVE_LOW ? !enabled : enabled;
  digitalWrite(ENABLE_PIN, level ? HIGH : LOW);
}

void stepMotor(long steps, bool forward) {
  digitalWrite(DIR_PIN, forward ? FORWARD_DIR_LEVEL : !FORWARD_DIR_LEVEL);
  delayMicroseconds(20);

  for (long i = 0; i < steps; ++i) {
    digitalWrite(STEP_PIN, HIGH);
    delayMicroseconds(STEP_PULSE_US);
    digitalWrite(STEP_PIN, LOW);
    delayMicroseconds(STEP_INTERVAL_US);
  }
}

void runRotationTest(bool forward, int revolutions) {
  const long steps = (long)STEPS_PER_REVOLUTION * revolutions;

  Serial.print(forward ? "+" : "-");
  Serial.print(revolutions);
  Serial.print(" rotations (");
  Serial.print(steps);
  Serial.println(" pulses)");

  stepMotor(steps, forward);
  Serial.println("Move complete");
}

void setup() {
  Serial.begin(115200);

  pinMode(STEP_PIN, OUTPUT);
  pinMode(DIR_PIN, OUTPUT);
  pinMode(ENABLE_PIN, OUTPUT);

  digitalWrite(STEP_PIN, LOW);
  digitalWrite(DIR_PIN, FORWARD_DIR_LEVEL);
  setDriverEnabled(true);

  delay(1000);
  Serial.println("Stepper motor test started");
}

void loop() {
  runRotationTest(true, TEST_REVOLUTIONS);
  delay(BETWEEN_MOVES_MS);

  runRotationTest(false, TEST_REVOLUTIONS);
  delay(BETWEEN_MOVES_MS);
}

