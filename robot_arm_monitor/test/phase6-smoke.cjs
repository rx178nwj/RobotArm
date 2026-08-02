const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  SMD_AXIS_STATUS_UUID,
  SMD_DEVICE_INFO_UUID,
  SMD_FAULT_UUID,
  SMD_POWER_UUID,
  SMD_TELEMETRY_SERVICE_UUID,
  SteppingMotorBleAdapter,
  stopSteppingMotorBleCentral
} = require("../dist/main/adapters/stepping-motor-ble-adapter.js");

async function main() {
  assert.equal(SMD_TELEMETRY_SERVICE_UUID, "7c9e10006a3d4b89a7125f4e8d2c0100");
  assert.equal(SMD_DEVICE_INFO_UUID, "7c9e10016a3d4b89a7125f4e8d2c0100");
  assert.equal(SMD_AXIS_STATUS_UUID, "7c9e10026a3d4b89a7125f4e8d2c0100");
  assert.equal(SMD_POWER_UUID, "7c9e10036a3d4b89a7125f4e8d2c0100");
  assert.equal(SMD_FAULT_UUID, "7c9e10046a3d4b89a7125f4e8d2c0100");

  const adapter = new SteppingMotorBleAdapter();
  assert.equal(adapter.kind, "stepping_motor_driver");
  assert.throws(() => adapter.sendCommand("ENABLE 0"), /read-only/);

  const source = fs.readFileSync(
    path.join(__dirname, "../src/main/adapters/stepping-motor-ble-adapter.ts"),
    "utf8"
  );
  assert.doesNotMatch(source, /\.writeAsync\s*\(/);
  assert.doesNotMatch(source, /\.writeHandleAsync\s*\(/);
  assert.match(source, /\.subscribeAsync\s*\(/);
  assert.match(source, /product !== "stepping_motor_driver"/);
  assert.match(source, /startScanningAsync\(\[\], true\)/);
  assert.match(source, /serviceUuids\.includes\(SMD_TELEMETRY_SERVICE_UUID\)/);
  await assert.rejects(adapter.executeCommand("MOVE 0 100"), /read-only/);
  console.log("PHASE6_BLE_READ_ONLY_SMOKE_OK");
}

main().then(
  () => {
    stopSteppingMotorBleCentral();
    process.exit(0);
  },
  error => {
    console.error(error);
    stopSteppingMotorBleCentral();
    process.exit(1);
  }
);
