const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { composeRobotArmSnapshot } = require("../dist/main/device-manager.js");
const { parseJointAngle } = require("../dist/main/adapters/control-app-client.js");

function main() {
  assert.deepEqual(parseJointAngle([{
    axis: 0,
    posDeg: 45.23,
    encDeg: 45.18,
    potDegRaw: 45.56,
    potDegZeroed: null
  }]), [{
    axis: 0,
    posDeg: 45.23,
    encDeg: 45.18,
    potDegRaw: 45.56,
    potDegZeroed: null
  }]);
  assert.throws(() => parseJointAngle({}), /配列/);

  const motor = {
    kind: "stepping_motor_driver", boardId: "MOTOR-A", path: "control_app (IPC)", state: "monitoring",
    lastUpdate: 100, metrics: [], rawLog: [], power: undefined, fault: undefined, gear: [],
    axes: [{ axis: 0, state: "IDLE", pos: 100, vel: 0, enc: 98 }],
    jointAngle: [{ axis: 0, posDeg: 11.25, encDeg: 11.2, potDegRaw: 12.1, potDegZeroed: 0.4 }]
  };
  const settings = {
    axisMapping: [
      { axisId: 1, label: "J1", motorBoardId: "MOTOR-A", motorLocalAxis: 0 },
      { axisId: 2, label: "J2", motorBoardId: "MOTOR-A", motorLocalAxis: 1 }
    ],
    boardLabels: {}
  };
  const snapshot = composeRobotArmSnapshot([motor], settings, false, 1234);
  assert.deepEqual(snapshot.axes[0].jointAngle, {
    boardId: "MOTOR-A", localAxis: 0,
    posDeg: 11.25, encDeg: 11.2, potDegRaw: 12.1, potDegZeroed: 0.4
  });
  assert.equal(snapshot.axes[1].jointAngle, undefined, "missing Joint Angle data remains optional");

  const html = fs.readFileSync(path.join(__dirname, "../dist/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../dist/renderer/renderer.js"), "utf8");
  const css = fs.readFileSync(path.join(__dirname, "../dist/renderer/styles.css"), "utf8");
  assert.match(html, /id="joint-verify-grid"/);
  assert.match(renderer, /Array\.from\(\{ length: 12 \}/);
  for (const command of ["MOVE_DEG", "MOVETO_DEG", "VEL", "STOP", "POT_ZERO_SET", "POT_ZERO_CLEAR"]) {
    assert.match(renderer, new RegExp(`"${command}"`));
  }
  assert.match(renderer, /verificationJogs = new Map/);
  assert.match(renderer, /value === null \|\| value === undefined \? "未対応"/);
  assert.match(css, /\.joint-verify-card\.unassigned/);
  assert.match(renderer, /SteppingMotorDriver · 制御アプリで接続/);
  assert.match(renderer, /kindHint === "stepping_motor_driver"/);
  console.log("PHASE11_JOINT_VERIFY_SMOKE_OK");
}

main();
