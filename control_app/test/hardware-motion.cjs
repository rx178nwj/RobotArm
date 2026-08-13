const assert = require("node:assert/strict");
const { BoardManager } = require("../dist/main/board-manager.js");
const { ControlIpcServer } = require("../dist/main/ipc-server.js");
const { createMockIpcClient } = require("./mock-ipc-client.cjs");

const port = process.env.ROBOTARM_PORT;
const axis = Number(process.env.ROBOTARM_AXIS);
const degrees = Number(process.env.ROBOTARM_TEST_DEG);
const testGearRatio = Number(process.env.ROBOTARM_TEST_GEAR_RATIO ?? "1");
const confirmed = process.env.ROBOTARM_MOTION_CONFIRMED === "YES";

if (!port || !confirmed || !Number.isInteger(axis) || axis < 0 || axis > 2
  || !Number.isFinite(degrees) || degrees <= 0 || degrees > 10
  || !Number.isFinite(testGearRatio) || testGearRatio < 1 || testGearRatio > 100
  || degrees * testGearRatio > 360) {
  console.error(
    "Set ROBOTARM_PORT, ROBOTARM_AXIS (0-2), ROBOTARM_TEST_DEG (>0 and <=10), "
    + "ROBOTARM_TEST_GEAR_RATIO (1-100, motor command <=360 deg), "
    + "and ROBOTARM_MOTION_CONFIRMED=YES."
  );
  process.exit(2);
}

const pipePath = `\\\\.\\pipe\\robotarm-control-app-motion-${process.pid}`;

async function main() {
  const manager = new BoardManager();
  const server = new ControlIpcServer(manager, pipePath);
  let client;
  let boardId;
  let completed = false;
  const commandDegrees = degrees * testGearRatio;

  manager.on("log", message => console.log(`[board] ${message}`));
  try {
    boardId = await manager.connectPath(port);
    console.log(`Connected ${port}: ${boardId}`);
    await server.start();
    client = createMockIpcClient(pipePath);
    await client.connected;

    assert.deepEqual(await client.command(boardId, axis, "ENABLE"), {
      id: 1,
      type: "result",
      ok: true
    });
    console.log(`ENABLE axis ${axis}: OK`);

    const forwardDone = client.waitForEvent(
      frame => frame.type === "event" && frame.event === "MOVE_DONE" && frame.axis === axis,
      20000
    );
    const forward = await client.command(boardId, axis, "MOVE_DEG", [commandDegrees]);
    assert.equal(forward.ok, true);
    console.log(`MOVE_DEG axis ${axis} +${commandDegrees}: accepted (output +${degrees} deg)`);
    console.log("Forward event:", await forwardDone);

    let moveDoneOccurrences = 0;
    const returnDone = client.waitForEvent(frame => {
      if (frame.type !== "event" || frame.event !== "MOVE_DONE" || frame.axis !== axis) return false;
      moveDoneOccurrences += 1;
      return moveDoneOccurrences >= 2;
    }, 20000);
    const backward = await client.command(boardId, axis, "MOVE_DEG", [-commandDegrees]);
    assert.equal(backward.ok, true);
    console.log(`MOVE_DEG axis ${axis} -${commandDegrees}: accepted (output -${degrees} deg)`);
    console.log("Return event:", await returnDone);
    completed = true;
    console.log(
      `Hardware command-path PASS: axis ${axis}, output ±${degrees} deg, `
      + `test gear ratio ${testGearRatio}`
    );
  } catch (error) {
    if (client && boardId) {
      try {
        console.error("Motion test failed; issuing ESTOP");
        console.error("ESTOP result:", await client.estop());
      } catch (estopError) {
        console.error("ESTOP request failed:", estopError);
      }
    }
    throw error;
  } finally {
    if (client && boardId) {
      try {
        console.log("STOP result:", await client.command(boardId, axis, "STOP"));
      } catch (error) {
        console.error("STOP cleanup failed:", error);
      }
      try {
        console.log("DISABLE result:", await client.command(boardId, axis, "DISABLE"));
      } catch (error) {
        console.error("DISABLE cleanup failed:", error);
      }
    }
    client?.close();
    await server.close();
    manager.closeAll();
    if (!completed) console.error("Motion test did not complete the return move.");
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
