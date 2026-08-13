const assert = require("node:assert/strict");
const net = require("node:net");
const { BoardManager } = require("../dist/main/board-manager.js");
const { ControlIpcServer } = require("../dist/main/ipc-server.js");
const { createMockIpcClient } = require("./mock-ipc-client.cjs");
const { MockSteppingMotorDriver } = require("./mock-stepping-motor-driver.cjs");

const BOARD_A = "AABBCCDDEEFF";
const BOARD_B = "112233445566";
const pipePath = `\\\\.\\pipe\\robotarm-control-app-test-${process.pid}`;

async function main() {
  const manager = new BoardManager();
  const boardA = new MockSteppingMotorDriver(BOARD_A);
  const boardB = new MockSteppingMotorDriver(BOARD_B, { ignoreEstop: true });
  await Promise.all([
    manager.connectStream("MOCK-A", boardA, 80, { telemetry: false }),
    manager.connectStream("MOCK-B", boardB, 80, { telemetry: false })
  ]);
  const server = new ControlIpcServer(manager, pipePath);
  await server.start();
  const client = createMockIpcClient(pipePath);

  try {
    await client.connected;
    assert.deepEqual(await client.command(BOARD_A, 0, "ENABLE"), { id: 1, type: "result", ok: true });
    assert.equal((await client.command(BOARD_A, 0, "MOVE", [1000])).ok, true);
    assert.equal((await client.command(BOARD_A, 0, "DISABLE")).ok, true);
    assert.equal((await client.command(BOARD_A, 0, "STOP")).ok, true);
    assert.equal((await client.command(BOARD_A, 0, "STOP_FREE")).ok, true);
    assert.equal((await client.command(BOARD_A, 2, "CLEAR_FAULT")).ok, true);
    assert.equal((await client.command(BOARD_A, 2, "MOVETO", [2048])).ok, true);
    assert.equal((await client.command(BOARD_A, 2, "VEL", [-250])).ok, true);
    assert.equal((await client.command(BOARD_A, 0, "SYNC_MOVE", [[[0, 100], [2, -200]]])).ok, true);
    assert.equal((await client.command(BOARD_A, 1, "MOVE_DEG", [-12.5])).ok, true);
    assert.equal((await client.command(BOARD_A, 2, "MOVETO_DEG", [45.25])).ok, true);
    assert.equal((await client.command(BOARD_A, 1, "POT_ZERO_SET")).ok, true);
    assert.equal((await client.command(BOARD_A, 1, "POT_ZERO_CLEAR")).ok, true);
    assert.deepEqual(
      boardA.commands.slice(1).map(item => item.command),
      [
        "ENABLE 0", "MOVE 0 1000", "DISABLE 0", "STOP 0", "STOP_FREE 0", "CLEAR_FAULT",
        "MOVETO 2 2048", "VEL 2 -250", "SYNC_MOVE 2 0 100 2 -200",
        "MOVE_DEG 1 -12.5", "MOVETO_DEG 2 45.25", "SET POT_ZERO 1", "CLEAR POT_ZERO 1"
      ]
    );

    const invalidDeg = await client.command(BOARD_A, 0, "MOVE_DEG", ["12.5"]);
    assert.equal(invalidDeg.ok, false);
    assert.equal(invalidDeg.error, "INVALID_REQUEST");
    const invalidPotZero = await client.command(BOARD_A, 0, "POT_ZERO_SET", [1]);
    assert.equal(invalidPotZero.ok, false);
    assert.equal(invalidPotZero.error, "INVALID_REQUEST");

    const eventPromise = client.waitForEvent(frame => frame.type === "event" && frame.event === "HOME_DONE");
    assert.equal((await client.command(BOARD_A, 0, "HOME")).ok, true);
    assert.deepEqual(await eventPromise, { type: "event", boardId: BOARD_A, event: "HOME_DONE", axis: 0 });

    const firmwareError = await client.command(BOARD_A, 0, "MOVETO", [-999]);
    assert.equal(firmwareError.ok, false);
    assert.equal(firmwareError.error, "E006");
    assert.equal(firmwareError.message, "SOFT_LIMIT");

    const missing = await client.command("FFFFFFFFFFFF", 0, "STOP");
    assert.deepEqual(
      { type: missing.type, ok: missing.ok, error: missing.error },
      { type: "result", ok: false, error: "NOT_CONNECTED" }
    );

    const timeout = await client.command(BOARD_A, 0, "VEL", [777]);
    assert.equal(timeout.ok, false);
    assert.equal(timeout.error, "TIMEOUT");
    assert.equal((await client.command(BOARD_A, 0, "ENABLE")).ok, true, "queue must continue after timeout");

    const estop = await client.estop();
    assert.equal(estop.type, "estop_result");
    const resultA = estop.results.find(result => result.boardId === BOARD_A);
    const resultB = estop.results.find(result => result.boardId === BOARD_B);
    assert.equal(resultA.ok, true);
    assert.equal(resultB.ok, false);
    assert.equal(resultB.error, "TIMEOUT");
    const estopA = boardA.commands.findLast(item => item.command === "ESTOP");
    const estopB = boardB.commands.findLast(item => item.command === "ESTOP");
    assert.ok(Math.abs(estopA.timestamp - estopB.timestamp) < 50, "ESTOP writes must begin in parallel");

    const second = net.connect({ path: pipePath });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("second IPC client was not rejected")), 500);
      second.on("close", () => { clearTimeout(timer); resolve(); });
      second.on("error", () => {});
    });

    client.close();
    await new Promise(resolve => server.once("clientConnectionChanged", connected => {
      if (!connected) resolve();
    }));

    const oldClient = createMockIpcClient(pipePath);
    await oldClient.connected;
    oldClient.socket.write(`${JSON.stringify({
      id: 500,
      type: "command",
      boardId: BOARD_A,
      axis: 0,
      command: "VEL",
      args: [777]
    })}\n`);
    await new Promise(resolve => setTimeout(resolve, 10));
    oldClient.close();
    await new Promise(resolve => server.once("clientConnectionChanged", connected => {
      if (!connected) resolve();
    }));

    const replacementClient = createMockIpcClient(pipePath);
    await replacementClient.connected;
    let leakedResponse = false;
    replacementClient.socket.on("data", chunk => {
      leakedResponse ||= String(chunk).includes('"id":500');
    });
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(leakedResponse, false, "a delayed response must not leak to a replacement client");
    replacementClient.close();

    console.log("Phase 1 E2E PASS: command mappings, errors, timeout, event, ESTOP, client isolation");
  } finally {
    client.close();
    manager.closeAll();
    await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
