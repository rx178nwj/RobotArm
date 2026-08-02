const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { composeRobotArmSnapshot, shortestAngleDifference } = require("../dist/main/device-manager.js");
const {
  SMD_GEAR_ANGLE_UUID,
  stopSteppingMotorBleCentral
} = require("../dist/main/adapters/stepping-motor-ble-adapter.js");

function motorSnapshot() {
  return {
    kind: "stepping_motor_driver", boardId: "MOTOR-A", path: "ble-a", state: "monitoring",
    lastUpdate: 100, metrics: [], rawLog: [],
    axes: [
      { axis: 0, state: "IDLE", pos: 100, vel: 0, enc: 98 },
      { axis: 1, state: "CRUISE", pos: 200, vel: 50, enc: 190 },
      { axis: 2, state: "IDLE", pos: 300, vel: 0, enc: 300 }
    ],
    power: { pot: [0, 0, 0], current_mA: 750, voltage_mV: 24100 },
    gear: [
      { axis: 0, angleDeg: 359, state: "OK" },
      { axis: 1, angleDeg: 20, state: "OK" }
    ]
  };
}

function bridgeSnapshot() {
  const channelDefaults = {
    dirConfig: false, dirOutput: false, angle: 0, magnetRaw: 0, md: true, ml: false, mh: false,
    readOk: 1, readErr: 0, lastOkMs: 1, lastErrMs: 0
  };
  return {
    kind: "multi_i2c_bridge", boardId: "BRIDGE-A", path: "COM8", state: "monitoring",
    lastUpdate: 100, metrics: [], rawLog: [],
    channels: [
      { ...channelDefaults, channel: 0, present: true, enable: true, ok: true, degrees: 1, agc: 88 },
      { ...channelDefaults, channel: 1, present: true, enable: true, ok: true, degrees: 25, agc: 90 },
      { ...channelDefaults, channel: 2, present: true, enable: true, ok: true, degrees: 90, agc: 91 }
    ],
    master: { active: true, writeTx: 0, writeBytes: 0, readReq: 0, readBytes: 0, lastActivityMs: 0, logSeq: 0 }
  };
}

function main() {
  assert.equal(SMD_GEAR_ANGLE_UUID, "7c9e10056a3d4b89a7125f4e8d2c0100");
  assert.equal(shortestAngleDifference(359, 1), -2);
  assert.equal(shortestAngleDifference(1, 359), 2);
  const settings = {
    axisMapping: [
      { axisId: 1, label: "J1", motorBoardId: "MOTOR-A", motorLocalAxis: 0, bridgeBoardId: "BRIDGE-A", bridgeLocalChannel: 0 },
      { axisId: 2, label: "J2", motorBoardId: "MOTOR-A", motorLocalAxis: 1, bridgeBoardId: "BRIDGE-A", bridgeLocalChannel: 1 },
      { axisId: 3, label: "J3", motorBoardId: "MISSING", motorLocalAxis: 0 },
      { axisId: 4, label: "J4", bridgeBoardId: "BRIDGE-A", bridgeLocalChannel: 2, gearDirSign: -1, gearAngleOffset: 10 }
    ],
    boardLabels: { "MOTOR-A": "Motor A", "BRIDGE-A": "Bridge A" }
  };
  const snapshot = composeRobotArmSnapshot([motorSnapshot(), bridgeSnapshot()], settings, true, 1234);
  assert.equal(snapshot.timestamp, 1234);
  assert.equal(snapshot.controlAppConnected, true);
  assert.equal(snapshot.boards.length, 2);
  assert.equal(snapshot.boards[0].label, "Motor A");
  assert.deepEqual(snapshot.axes[0].gearMismatch, { diffDeg: -2, exceeded: true });
  assert.equal(snapshot.axes[0].motor.deviation, 2);
  assert.equal(snapshot.axes[0].motor.voltageV, 24.1);
  assert.equal(snapshot.axes[1].gearMismatch, undefined, "moving axes must not be compared");
  assert.equal(snapshot.axes[2].motor, undefined, "configured offline axes remain visible");
  assert.equal(snapshot.axes[3].gearDirect.angleDeg, 260, "direct angle receives motor-side correction");
  assert.equal(snapshot.axes[4].axisId, null, "unassigned physical motor axis is explicit");
  assert.ok(snapshot.axes.length <= 12);

  const html = fs.readFileSync(path.join(__dirname, "../dist/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../dist/renderer/renderer.js"), "utf8");
  assert.match(html, /id="dashboard-axis-rows"/);
  assert.match(html, /id="axis-detail-content"/);
  assert.match(html, /id="board-raw-cards"/);
  assert.match(html, /id="control-estop"[^>]*disabled/);
  assert.match(renderer, /onRobotArmUpdate/);
  assert.match(renderer, /判定停止中/);
  console.log("PHASE8_DASHBOARD_SMOKE_OK");
  stopSteppingMotorBleCentral();
}

main();
