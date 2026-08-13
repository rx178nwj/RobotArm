const net = require("node:net");

const DEFAULT_PIPE_PATH = "\\\\.\\pipe\\robotarm-control-app";

function createMockIpcClient(pipePath = DEFAULT_PIPE_PATH) {
  const socket = net.connect({ path: pipePath });
  socket.setEncoding("utf8");
  let buffer = "";
  let nextId = 1;
  const pending = new Map();
  const events = [];
  const waiters = [];

  socket.on("data", chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleFrame(JSON.parse(line));
      newline = buffer.indexOf("\n");
    }
  });

  function handleFrame(frame) {
    if (frame.type === "event" || frame.type === "connection_changed") {
      events.push(frame);
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (!waiters[i].predicate(frame)) continue;
        const waiter = waiters.splice(i, 1)[0];
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      }
      return;
    }
    const request = pending.get(frame.id);
    if (!request) return;
    clearTimeout(request.timer);
    pending.delete(frame.id);
    request.resolve(frame);
  }

  function request(frame, timeoutMs = 1000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`IPC request ${id} timed out`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, ...frame })}\n`);
    });
  }

  function waitForEvent(predicate, timeoutMs = 1000) {
    const existing = events.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, reject };
      waiter.timer = setTimeout(() => {
        const index = waiters.indexOf(waiter);
        if (index >= 0) waiters.splice(index, 1);
        reject(new Error("IPC event timed out"));
      }, timeoutMs);
      waiters.push(waiter);
    });
  }

  return {
    socket,
    connected: new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    }),
    command: (boardId, axis, command, args) => request({
      type: "command", boardId, axis, command, ...(args === undefined ? {} : { args })
    }, 7000),
    estop: () => request({ type: "estop" }, 7000),
    waitForEvent,
    close: () => socket.destroy()
  };
}

module.exports = { createMockIpcClient, DEFAULT_PIPE_PATH };

if (require.main === module) {
  const boardId = process.env.ROBOTARM_BOARD_ID;
  const client = createMockIpcClient();
  client.connected.then(async () => {
    console.log("Connected to Robot Arm Control IPC server");
    if (!boardId) {
      console.log("Set ROBOTARM_BOARD_ID to exercise ENABLE/MOVE/HOME/ESTOP.");
      client.close();
      return;
    }
    for (const [command, args] of [["ENABLE"], ["MOVE", [100]], ["HOME"]]) {
      console.log(command, await client.command(boardId, 0, command, args));
    }
    console.log("ESTOP", await client.estop());
    client.close();
  }).catch(error => {
    console.error(error);
    process.exitCode = 1;
  });
}
