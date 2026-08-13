const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const {
  CONTROL_APP_PIPE_PATH,
  NamedPipeControlAppClient
} = require("../dist/main/adapters/control-app-client.js");
const { DeviceManager } = require("../dist/main/device-manager.js");

const serverPath = path.join(__dirname, "mock-control-app-server.js");

async function main() {
  assert.equal(CONTROL_APP_PIPE_PATH, "\\\\.\\pipe\\robotarm-control-app");
  await assertLogicalAxisMapping();
  let server = await startServer();
  const client = new NamedPipeControlAppClient({
    reconnectIntervalMs: 100,
    requestTimeoutMs: 1000
  });
  await waitFor(() => client.connected, 3000, "initial IPC connection");

  assert.deepEqual(
    await client.sendCommand("AABBCCDDEEFF", 1, "ENABLE"),
    { ok: true }
  );
  assert.deepEqual(
    await client.sendCommand("AABBCCDDEEFF", 1, "MOVE_DEG", [1.25]),
    { ok: true }
  );
  assert.deepEqual(
    await client.sendCommand("AABBCCDDEEFF", 1, "POT_ZERO_CLEAR"),
    { ok: true }
  );
  assert.deepEqual(
    await client.sendCommand("AABBCCDDEEFF", 0, "SYNC_MOVE", [[0, 100], [2, -50]]),
    { ok: true }
  );
  assert.deepEqual(
    await client.sendCommand("AABBCCDDEEFF", 1, "MOVETO", [-999]),
    { ok: false, error: "E006", message: "SOFT_LIMIT" }
  );

  const eventPromise = new Promise(resolve => client.once("controlEvent", resolve));
  assert.deepEqual(await client.sendCommand("AABBCCDDEEFF", 2, "HOME"), { ok: true });
  assert.deepEqual(await eventPromise, {
    boardId: "AABBCCDDEEFF",
    event: "HOME_DONE",
    axis: 2
  });

  assert.deepEqual(await client.sendEstop(), {
    results: [
      { boardId: "AABBCCDDEEFF", ok: true },
      { boardId: "112233445566", ok: false, error: "NOT_CONNECTED" }
    ]
  });

  await stopServer(server);
  await waitFor(() => !client.connected, 3000, "IPC disconnection detection");
  await assert.rejects(
    client.sendCommand("AABBCCDDEEFF", 0, "STOP"),
    /not connected/
  );

  server = await startServer();
  await waitFor(() => client.connected, 3000, "automatic IPC reconnection");
  assert.deepEqual(
    await client.sendCommand("AABBCCDDEEFF", 0, "STOP"),
    { ok: true }
  );

  client.close();
  await stopServer(server);
  assertRendererContract();
  console.log("PHASE7_CONTROL_APP_IPC_SMOKE_OK");
}

async function assertLogicalAxisMapping() {
  const calls = [];
  const controlClient = {
    connected: true,
    sendCommand: async (boardId, axis, command, args) => {
      calls.push({ boardId, axis, command, args });
      return { ok: true };
    },
    sendEstop: async () => ({ results: [] }),
    on() { return this; }
  };
  const mappingStore = {
    get: () => ({
      axisMapping: [
        { axisId: 1, label: "J1", motorBoardId: "BOARD-A", motorLocalAxis: 2 },
        { axisId: 2, label: "J2", motorBoardId: "BOARD-A", motorLocalAxis: 0 },
        { axisId: 3, label: "J3", motorBoardId: "BOARD-B", motorLocalAxis: 1 }
      ],
      boardLabels: {}
    })
  };
  const manager = new DeviceManager(() => {}, controlClient, mappingStore);
  assert.deepEqual(
    await manager.executeControlCommand({ logicalAxis: 1, command: "MOVE", args: [123] }),
    { ok: true }
  );
  assert.deepEqual(calls.pop(), {
    boardId: "BOARD-A",
    axis: 2,
    command: "MOVE",
    args: [123]
  });
  await manager.executeControlCommand({ logicalAxis: 1, command: "MOVETO_DEG", args: [-12.5] });
  assert.deepEqual(calls.pop(), {
    boardId: "BOARD-A",
    axis: 2,
    command: "MOVETO_DEG",
    args: [-12.5]
  });
  await manager.executeControlCommand({ logicalAxis: 1, command: "POT_ZERO_SET" });
  assert.deepEqual(calls.pop(), {
    boardId: "BOARD-A",
    axis: 2,
    command: "POT_ZERO_SET",
    args: undefined
  });
  await manager.executeSyncMove([
    { logicalAxis: 1, steps: 100 },
    { logicalAxis: 2, steps: -50 }
  ]);
  assert.deepEqual(calls.pop(), {
    boardId: "BOARD-A",
    axis: 2,
    command: "SYNC_MOVE",
    args: [[2, 100], [0, -50]]
  });
  await assert.rejects(
    manager.executeSyncMove([
      { logicalAxis: 1, steps: 100 },
      { logicalAxis: 3, steps: 100 }
    ]),
    /same motor board/
  );
}

function assertRendererContract() {
  const html = fs.readFileSync(path.join(__dirname, "../dist/renderer/index.html"), "utf8");
  const renderer = fs.readFileSync(path.join(__dirname, "../dist/renderer/renderer.js"), "utf8");
  assert.match(html, /id="control-fieldset"[^>]*disabled/);
  assert.match(html, /id="control-estop"/);
  assert.match(html, /data-control-command="STOP_FREE"/);
  assert.match(html, /id="sync-move-groups"/);
  assert.match(html, /id="devices"[^>]*role="tablist"/);
  assert.match(html, /id="device-tab-panel"[^>]*role="tabpanel"/);
  assert.match(renderer, /sendControlCommand/);
  assert.match(renderer, /sendSyncMove/);
  assert.match(renderer, /sendEstop/);
  assert.match(renderer, /setInterval\(issueVel, 300\)/);
  assert.match(renderer, /aria-selected/);
  const updateHandler = renderer.slice(
    renderer.indexOf("function onDeviceUpdate"),
    renderer.indexOf("function renderDevices")
  );
  assert.match(updateHandler, /function onDeviceUpdate\(snapshot\) \{\s*let deviceSetChanged = false;/);
}

function startServer() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Mock server startup timed out: ${stderr}`));
    }, 3000);
    child.stderr.on("data", chunk => {
      stderr += chunk;
    });
    child.stdout.on("data", chunk => {
      if (!String(chunk).includes("MOCK_CONTROL_APP_READY")) return;
      clearTimeout(timer);
      resolve(child);
    });
    child.once("exit", code => {
      if (code !== null && code !== 0) {
        clearTimeout(timer);
        reject(new Error(`Mock server exited with ${code}: ${stderr}`));
      }
    });
  });
}

function stopServer(child) {
  return new Promise(resolve => {
    if (child.exitCode !== null) return resolve();
    child.once("exit", resolve);
    child.kill();
  });
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
