const assert = require("node:assert/strict");
const { once } = require("node:events");
const { BoardManager } = require("../dist/main/board-manager.js");
const { ControlIpcServer } = require("../dist/main/ipc-server.js");
const {
  NamedPipeControlAppClient
} = require("../../robot_arm_monitor/dist/main/adapters/control-app-client.js");
const { MockSteppingMotorDriver } = require("./mock-stepping-motor-driver.cjs");

const BOARD_ID = "AABBCCDDEEFF";
const pipePath = `\\\\.\\pipe\\robotarm-control-app-integration-${process.pid}`;

async function waitUntil(predicate, timeoutMs = 1000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Condition timed out");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function main() {
  const manager = new BoardManager();
  const board = new MockSteppingMotorDriver(BOARD_ID);
  await manager.connectStream("MONITOR-INTEGRATION-MOCK", board, 100);

  const server = new ControlIpcServer(manager, pipePath);
  await server.start();
  const client = new NamedPipeControlAppClient({
    pipePath,
    reconnectIntervalMs: 30,
    requestTimeoutMs: 500
  });

  try {
    await waitUntil(() => client.connected);

    assert.deepEqual(await client.sendCommand(BOARD_ID, 0, "ENABLE"), { ok: true });
    assert.deepEqual(await client.sendCommand(BOARD_ID, 0, "MOVE", [1000]), { ok: true });

    const eventPromise = once(client, "controlEvent");
    assert.deepEqual(await client.sendCommand(BOARD_ID, 0, "HOME"), { ok: true });
    assert.deepEqual((await eventPromise)[0], {
      boardId: BOARD_ID,
      event: "HOME_DONE",
      axis: 0
    });

    assert.deepEqual(await client.sendCommand(BOARD_ID, 0, "MOVETO", [-999]), {
      ok: false,
      error: "E006",
      message: "SOFT_LIMIT"
    });
    assert.deepEqual(await client.sendCommand("FFFFFFFFFFFF", 0, "STOP"), {
      ok: false,
      error: "NOT_CONNECTED"
    });
    assert.deepEqual(await client.sendEstop(), {
      results: [{ boardId: BOARD_ID, ok: true }]
    });

    const disconnected = once(client, "connectionChanged");
    await server.close();
    assert.deepEqual(await disconnected, [false]);
    assert.equal(client.connected, false);

    console.log("robot_arm_monitor integration PASS: command, error, event, ESTOP, disconnect");
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
