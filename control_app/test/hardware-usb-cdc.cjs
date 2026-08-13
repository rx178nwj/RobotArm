const assert = require("node:assert/strict");
const { BoardManager } = require("../dist/main/board-manager.js");
const { ControlIpcServer } = require("../dist/main/ipc-server.js");
const {
  NamedPipeControlAppClient
} = require("../../robot_arm_monitor/dist/main/adapters/control-app-client.js");

const port = process.env.ROBOTARM_PORT;
if (!port) {
  console.error("Set ROBOTARM_PORT to the SteppingMotorDriver COM port (for example COM41).");
  process.exit(2);
}

const pipePath = `\\\\.\\pipe\\robotarm-control-app-hardware-${process.pid}`;

async function waitUntil(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("IPC connection timed out");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

async function main() {
  const manager = new BoardManager();
  const server = new ControlIpcServer(manager, pipePath);
  let client;

  manager.on("log", message => console.log(`[board] ${message}`));
  try {
    const boardId = await manager.connectPath(port);
    console.log(`Connected ${port}: ${boardId}`);

    await server.start();
    client = new NamedPipeControlAppClient({
      pipePath,
      reconnectIntervalMs: 50,
      requestTimeoutMs: 6000
    });
    await waitUntil(() => client.connected);

    // STOP cannot initiate motion and is the default hardware-safe command-path check.
    for (const axis of [0, 1, 2]) {
      const result = await client.sendCommand(boardId, axis, "STOP");
      assert.deepEqual(result, { ok: true });
      console.log(`STOP axis ${axis}: OK`);
    }

    console.log(`USB-CDC hardware PASS: ${boardId} via ${port}`);
  } finally {
    client?.close();
    await server.close();
    manager.closeAll();
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
