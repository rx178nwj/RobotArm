const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { RobotArmTrendBuffer, METRICS } = require("../dist/renderer/trend-charts.js");

function axis(axisId, values = {}) {
  return {
    axisId,
    axisLabel: `J${axisId}`,
    motor: {
      boardId: "M", localAxis: axisId - 1, state: "IDLE", stepPos: 100, encoderPos: 98,
      deviation: 2, velocity: 10 * axisId, currentMa: 500 + axisId, voltageV: 24,
      ...values.motor
    },
    gearRelayed: { boardId: "M", angleDeg: 359, status: "OK", deviationDeg: null, ...values.gearRelayed },
    gearDirect: { boardId: "B", localChannel: axisId - 1, angleDeg: 1, ok: true, agc: 80, ...values.gearDirect },
    ...values.root
  };
}

function snapshot(seconds, axes) {
  return { axes, boards: [], controlAppConnected: true, timestamp: seconds * 1000 };
}

function main() {
  const buffer = new RobotArmTrendBuffer();
  assert.equal(buffer.push(snapshot(100, [axis(1, { root: { gearMismatch: { diffDeg: -2, exceeded: true } } })])), true);
  assert.equal(buffer.push(snapshot(120, [axis(1), axis(2)])), true);
  assert.equal(buffer.push(snapshot(140, [axis(2)])), true);
  assert.equal(buffer.push(snapshot(140, [axis(2)])), false, "duplicate timestamps are rejected");

  const axisOne = buffer.axisWindow(30, 1, ["velocity", "gearDiff", "gearExceeded"]);
  assert.deepEqual(axisOne[0], [120, 140]);
  assert.deepEqual(axisOne[1], [10, null], "disconnected axes retain aligned null samples");
  assert.deepEqual(axisOne[2], [-2, null], "gear difference uses the shortest circular distance");
  assert.deepEqual(axisOne[3], [null, null], "warning series only includes exceeded IDLE samples");

  const comparison = buffer.comparisonWindow(300, "velocity", buffer.axisIds());
  assert.equal(comparison.length, 3);
  assert.deepEqual(comparison[2], [null, 20, 20], "axes added later are backfilled with null");
  assert.deepEqual(METRICS.map(item => item.value), ["velocity", "deviation", "currentMa", "voltageV", "gearDiff"]);

  const html = fs.readFileSync(path.join(__dirname, "../dist/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../dist/renderer/renderer.js"), "utf8");
  const packageJson = require("../package.json");
  for (const id of ["trend-velocity", "trend-position", "trend-deviation", "trend-power", "trend-gear", "trend-comparison"]) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /data-dashboard-view="comparison"/);
  assert.match(html, /data-trend-window="300"/);
  assert.match(html, /uPlot\.iife\.min\.js/);
  assert.match(renderer, /setActiveViews/);
  assert.match(renderer, /setComparisonMetric/);
  assert.equal(packageJson.dependencies.uplot, "^1.6.32");
  console.log("PHASE9_TREND_CHARTS_SMOKE_OK");
}

main();
