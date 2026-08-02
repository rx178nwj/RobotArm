const net = require("node:net");

const PIPE_PATH = "\\\\.\\pipe\\robotarm-control-app";
const clients = new Set();

const server = net.createServer(socket => {
  clients.add(socket);
  socket.setEncoding("utf8");
  let buffer = "";
  socket.on("data", chunk => {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line) handleRequest(socket, line);
      newline = buffer.indexOf("\n");
    }
  });
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
});

function handleRequest(socket, line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  if (!Number.isSafeInteger(request.id)) return;
  if (request.type === "estop") {
    write(socket, {
      id: request.id,
      type: "estop_result",
      results: [
        { boardId: "AABBCCDDEEFF", ok: true },
        { boardId: "112233445566", ok: false, error: "NOT_CONNECTED" }
      ]
    });
    return;
  }
  if (request.type !== "command") return;
  if (request.command === "MOVETO" && request.args?.[0] === -999) {
    write(socket, {
      id: request.id,
      type: "result",
      ok: false,
      error: "E006",
      message: "SOFT_LIMIT"
    });
    return;
  }
  write(socket, { id: request.id, type: "result", ok: true });
  if (request.command === "HOME") {
    setTimeout(() => write(socket, {
      type: "event",
      boardId: request.boardId,
      event: "HOME_DONE",
      axis: request.axis
    }), 20);
  }
}

function write(socket, frame) {
  if (!socket.destroyed) socket.write(`${JSON.stringify(frame)}\n`);
}

function shutdown() {
  for (const socket of clients) socket.destroy();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 500).unref();
}

server.on("error", error => {
  console.error(error);
  process.exit(1);
});
server.listen(PIPE_PATH, () => console.log("MOCK_CONTROL_APP_READY"));
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

