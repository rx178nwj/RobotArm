import { EventEmitter } from "node:events";
import net from "node:net";
import type {
  CommandResult,
  ControlCommand,
  ControlEvent,
  EstopResult
} from "../../shared/types";

export const CONTROL_APP_PIPE_PATH = "\\\\.\\pipe\\robotarm-control-app";

export interface ControlAppClient extends EventEmitter {
  readonly connected: boolean;
  sendCommand(
    boardId: string,
    axis: number,
    command: string,
    args?: unknown[]
  ): Promise<CommandResult>;
  sendEstop(): Promise<EstopResult>;
  on(event: "connectionChanged", listener: (connected: boolean) => void): this;
  on(event: "controlEvent", listener: (event: ControlEvent) => void): this;
}

interface ClientOptions {
  pipePath?: string;
  reconnectIntervalMs?: number;
  requestTimeoutMs?: number;
  autoStart?: boolean;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

interface ResponseFrame {
  id?: unknown;
  type?: unknown;
  ok?: unknown;
  error?: unknown;
  message?: unknown;
  results?: unknown;
}

const COMMANDS = new Set<ControlCommand>([
  "ENABLE", "DISABLE", "STOP", "STOP_FREE", "CLEAR_FAULT",
  "HOME", "MOVE", "MOVETO", "VEL", "SYNC_MOVE"
]);

export class NamedPipeControlAppClient extends EventEmitter implements ControlAppClient {
  private socket?: net.Socket;
  private retryTimer?: NodeJS.Timeout;
  private receiveBuffer = "";
  private nextRequestId = 1;
  private connecting = false;
  private stopped = false;
  private connectedState = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly pipePath: string;
  private readonly reconnectIntervalMs: number;
  private readonly requestTimeoutMs: number;

  constructor(options: ClientOptions = {}) {
    super();
    this.pipePath = options.pipePath ?? CONTROL_APP_PIPE_PATH;
    this.reconnectIntervalMs = options.reconnectIntervalMs ?? 3000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 6000;
    if (options.autoStart !== false) this.start();
  }

  get connected(): boolean {
    return this.connectedState;
  }

  start(): void {
    if (!this.stopped && (this.connectedState || this.connecting)) return;
    this.stopped = false;
    this.clearRetry();
    this.connecting = true;
    const socket = net.connect({ path: this.pipePath });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      if (this.socket !== socket) return;
      this.connecting = false;
      this.receiveBuffer = "";
      this.setConnected(true);
    });
    socket.on("data", chunk => {
      if (this.socket === socket) this.handleData(String(chunk));
    });
    socket.on("error", () => {
      // A failed connection also emits close. The retry is scheduled there.
    });
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.connecting = false;
      this.receiveBuffer = "";
      this.setConnected(false);
      this.rejectPending(new Error("Control application IPC connection was closed"));
      this.scheduleRetry();
    });
  }

  close(): void {
    this.stopped = true;
    this.clearRetry();
    const socket = this.socket;
    this.socket = undefined;
    this.connecting = false;
    this.receiveBuffer = "";
    socket?.destroy();
    this.setConnected(false);
    this.rejectPending(new Error("Control application IPC client was closed"));
  }

  async sendCommand(
    boardId: string,
    axis: number,
    command: string,
    args?: unknown[]
  ): Promise<CommandResult> {
    if (!boardId.trim()) throw new Error("A board ID is required");
    if (!Number.isInteger(axis) || axis < 0 || axis > 2) throw new Error("Local axis must be 0-2");
    if (!COMMANDS.has(command as ControlCommand)) {
      throw new Error(`Unsupported control command: ${command}`);
    }
    if (args !== undefined && !Array.isArray(args)) throw new Error("Command args must be an array");
    const response = await this.request({
      type: "command",
      boardId,
      axis,
      command,
      ...(args === undefined ? {} : { args })
    }) as ResponseFrame;
    if (response.type !== "result" || typeof response.ok !== "boolean") {
      throw new Error("Invalid command response from control application");
    }
    return {
      ok: response.ok,
      ...(typeof response.error === "string" ? { error: response.error } : {}),
      ...(typeof response.message === "string" ? { message: response.message } : {})
    };
  }

  async sendEstop(): Promise<EstopResult> {
    const response = await this.request({ type: "estop" }) as ResponseFrame;
    if (response.type !== "estop_result" || !Array.isArray(response.results)) {
      throw new Error("Invalid ESTOP response from control application");
    }
    return {
      results: response.results.map((result, index) => {
        if (
          !result
          || typeof result !== "object"
          || typeof (result as { boardId?: unknown }).boardId !== "string"
          || typeof (result as { ok?: unknown }).ok !== "boolean"
        ) {
          throw new Error(`Invalid ESTOP board result at index ${index}`);
        }
        const value = result as { boardId: string; ok: boolean; error?: unknown; message?: unknown };
        return {
          boardId: value.boardId,
          ok: value.ok,
          ...(typeof value.error === "string" ? { error: value.error } : {}),
          ...(typeof value.message === "string" ? { message: value.message } : {})
        };
      })
    };
  }

  private request(frame: Record<string, unknown>): Promise<unknown> {
    const socket = this.socket;
    if (!this.connectedState || !socket || socket.destroyed || !socket.writable) {
      return Promise.reject(new Error("Control application is not connected"));
    }
    const id = this.nextRequestId++;
    if (this.nextRequestId > Number.MAX_SAFE_INTEGER) this.nextRequestId = 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("Control application IPC request timed out"));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.write(`${JSON.stringify({ id, ...frame })}\n`, error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  private handleData(chunk: string): void {
    this.receiveBuffer += chunk;
    let newline = this.receiveBuffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.receiveBuffer.slice(0, newline).trim();
      this.receiveBuffer = this.receiveBuffer.slice(newline + 1);
      if (line) this.handleFrame(line);
      newline = this.receiveBuffer.indexOf("\n");
    }
  }

  private handleFrame(line: string): void {
    let frame: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
      frame = parsed as Record<string, unknown>;
    } catch {
      return;
    }
    if (
      frame.type === "event"
      && typeof frame.boardId === "string"
      && typeof frame.event === "string"
      && (frame.axis === undefined || Number.isInteger(frame.axis))
    ) {
      this.emit("controlEvent", {
        boardId: frame.boardId,
        event: frame.event,
        ...(typeof frame.axis === "number" ? { axis: frame.axis } : {})
      } satisfies ControlEvent);
      return;
    }
    if (typeof frame.id !== "number" || !Number.isSafeInteger(frame.id)) return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(frame.id);
    pending.resolve(frame);
  }

  private setConnected(connected: boolean): void {
    if (this.connectedState === connected) return;
    this.connectedState = connected;
    this.emit("connectionChanged", connected);
  }

  private rejectPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      this.start();
    }, this.reconnectIntervalMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
  }
}
