import { EventEmitter } from "node:events";
import net from "node:net";
import type {
  BoardStatus,
  ConnectionChangedFrame,
  EventFrame,
  FaultTraceCapture,
  FaultTraceFrame,
  MotorTelemetrySnapshot,
  TelemetryFrame
} from "../shared/types";
import { BoardManager } from "./board-manager";

export const CONTROL_APP_PIPE_PATH = "\\\\.\\pipe\\robotarm-control-app";

export class ControlIpcServer extends EventEmitter {
  private server?: net.Server;
  private client?: net.Socket;
  private receiveBuffer = "";

  constructor(
    private readonly manager: BoardManager,
    private readonly pipePath = CONTROL_APP_PIPE_PATH
  ) {
    super();
    manager.on("controlEvent", event => this.send({ type: "event", ...event } satisfies EventFrame));
    manager.on("connectionChanged", (boards: BoardStatus[]) => {
      this.send({ type: "connection_changed", boards } satisfies ConnectionChangedFrame);
    });
    manager.on("telemetry", (snapshot: MotorTelemetrySnapshot) => {
      this.send({ type: "telemetry", ...snapshot } satisfies TelemetryFrame);
    });
    manager.on("faultTrace", (capture: FaultTraceCapture) => {
      this.send({ type: "fault_trace", ...capture } satisfies FaultTraceFrame);
    });
  }

  get clientConnected(): boolean {
    return Boolean(this.client && !this.client.destroyed);
  }

  start(): Promise<void> {
    if (this.server) return Promise.resolve();
    const server = net.createServer(socket => this.accept(socket));
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = (error: Error) => {
        server.off("listening", onListening);
        if (this.server === server) this.server = undefined;
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        server.on("error", error => this.emit("log", `Server error: ${error.message}`));
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.pipePath);
    });
  }

  close(): Promise<void> {
    this.client?.destroy();
    this.client = undefined;
    this.receiveBuffer = "";
    const server = this.server;
    this.server = undefined;
    if (!server?.listening) return Promise.resolve();
    return new Promise(resolve => server.close(() => resolve()));
  }

  private accept(socket: net.Socket): void {
    if (this.client && !this.client.destroyed) {
      this.emit("log", "Rejected second IPC client");
      socket.destroy();
      return;
    }
    this.client = socket;
    this.receiveBuffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      if (this.client === socket) this.handleData(socket, String(chunk));
    });
    socket.on("error", error => this.emit("log", `Client error: ${error.message}`));
    socket.on("close", () => {
      if (this.client !== socket) return;
      this.client = undefined;
      this.receiveBuffer = "";
      this.emit("clientConnectionChanged", false);
      this.emit("log", "IPC client disconnected");
    });
    this.emit("clientConnectionChanged", true);
    this.emit("log", "IPC client connected");
  }

  private handleData(socket: net.Socket, chunk: string): void {
    this.receiveBuffer += chunk;
    if (this.receiveBuffer.length > 1024 * 1024) {
      this.emit("log", "IPC receive buffer limit exceeded");
      this.client?.destroy();
      return;
    }
    let newline = this.receiveBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline).trim();
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (line) void this.handleFrame(socket, line);
      newline = this.receiveBuffer.indexOf("\n");
    }
  }

  private async handleFrame(socket: net.Socket, line: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      this.emit("log", "Ignored malformed IPC JSON");
      return;
    }
    if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) return;
    const id = frame.id;
    if (frame.type === "estop") {
      this.emit("log", `RX #${id} ESTOP`);
      const result = await this.manager.estopAll();
      this.send({ id, type: "estop_result", ...result }, socket);
      return;
    }
    if (frame.type !== "command") {
      this.send({ id, type: "result", ok: false, error: "INVALID_REQUEST", message: "Unknown frame type" }, socket);
      return;
    }
    if (typeof frame.boardId !== "string" || typeof frame.axis !== "number"
      || typeof frame.command !== "string" || (frame.args !== undefined && !Array.isArray(frame.args))) {
      this.send({ id, type: "result", ok: false, error: "INVALID_REQUEST", message: "Invalid command frame" }, socket);
      return;
    }
    this.emit("log", `RX #${id} ${frame.boardId}/${frame.axis} ${frame.command}`);
    const result = await this.manager.execute(
      frame.boardId,
      frame.axis,
      frame.command,
      frame.args as unknown[] | undefined
    );
    this.send({ id, type: "result", ...result }, socket);
  }

  private send(frame: Record<string, unknown>, client = this.client): void {
    // Never deliver a delayed response from a disconnected client to its successor.
    if (!client || client !== this.client || client.destroyed || !client.writable) return;
    client.write(`${JSON.stringify(frame)}\n`);
  }
}
