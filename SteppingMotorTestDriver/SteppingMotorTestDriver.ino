namespace {
// --- GPIO assignment (3ch board) ---
const uint8_t STEP_PIN   = 6;   // STEP0
const uint8_t DIR_PIN    = 7;   // DIR0
const uint8_t DRV_EN     = 12;  // active LOW  — LOW=enabled
const uint8_t DRV_RESET  = 13;  // active LOW  — HIGH=run, LOW=reset
const uint8_t DRV_SLEEP  = 14;  // active LOW  — HIGH=awake, LOW=sleep

// 17HS4401S: 1.8 deg/step = 200 full steps/rev.
const int STEPS_PER_REVOLUTION = 200;
const int TEST_REVOLUTIONS = 10;

const bool FORWARD_DIR_LEVEL = HIGH;

const unsigned int STEP_PULSE_US = 800;
const unsigned int STEP_INTERVAL_US = 800;
const unsigned long BETWEEN_MOVES_MS = 1500;
}

void setDriverEnabled(bool enabled) {
  // nENABLE is active-LOW on DRV8825
  digitalWrite(DRV_EN, enabled ? LOW : HIGH);
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

  pinMode(STEP_PIN,  OUTPUT);
  pinMode(DIR_PIN,   OUTPUT);
  pinMode(DRV_EN,    OUTPUT);
  pinMode(DRV_RESET, OUTPUT);
  pinMode(DRV_SLEEP, OUTPUT);

  // Wake up DRV8825 before enabling
  digitalWrite(DRV_SLEEP, HIGH);   // nSLEEP=HIGH : awake
  digitalWrite(DRV_RESET, HIGH);   // nRESET=HIGH : run mode
  delayMicroseconds(2000);         // t_wake >= 1.7 ms

  digitalWrite(STEP_PIN, LOW);
  digitalWrite(DIR_PIN,  FORWARD_DIR_LEVEL);
  setDriverEnabled(true);          // nEN=LOW : outputs enabled

  delay(1000);
  Serial.println("DRV8825 awake. Measure Vref now (trimpot wiper).");
  Serial.println("Stepper motor test started.");
}

void loop() {
  // stopped — DRV8825 remains awake for Vref measurement
  delay(1000);
}
