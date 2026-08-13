import { EventEmitter } from "node:events";
import net from "node:net";
import type {
  BoardStatus,
  CommandResult,
  ControlCommand,
  ControlEvent,
  EstopResult,
  FaultTraceSample,
  MotorAxisStatus,
  MotorFaultInfo,
  MotorGearStatus,
  MotorJointAngle,
  MotorPower,
  MotorSnapshot
} from "../../shared/types";

/** A FAULT_TRACE capture as received from control_app, before axis-label resolution. */
export interface RawFaultTraceCapture {
  boardId: string;
  localAxis: number;
  intervalMs: number;
  capturedAt: number;
  reason?: string;
  samples: FaultTraceSample[];
}

export const CONTROL_APP_PIPE_PATH = "\\\\.\\pipe\\robotarm-control-app";

export interface ControlAppClient extends EventEmitter {
  readonly connected: boolean;
  readonly boards: BoardStatus[];
  sendCommand(
    boardId: string,
    axis: number,
    command: string,
    args?: unknown[]
  ): Promise<CommandResult>;
  sendEstop(): Promise<EstopResult>;
  on(event: "connectionChanged", listener: (connected: boolean) => void): this;
  on(event: "controlEvent", listener: (event: ControlEvent) => void): this;
  on(event: "boardsChanged", listener: (boards: BoardStatus[]) => void): this;
  on(event: "telemetry", listener: (snapshot: MotorSnapshot) => void): this;
  on(event: "faultTrace", listener: (capture: RawFaultTraceCapture) => void): this;
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
  "HOME", "MOVE", "MOVETO", "VEL", "MOVE_DEG", "MOVETO_DEG",
  "POT_ZERO_SET", "POT_ZERO_CLEAR", "SYNC_MOVE",
  "SET_GEAR_RATIO", "GET_GEAR_RATIO",
  "SET_STALL_FAULT", "GET_STALL_FAULT", "SET_CURRENT_LIMIT", "GET_CURRENT_LIMIT",
  "SET_MICROSTEP", "GET_MICROSTEP",
  "SET_VMAX", "GET_VMAX", "SET_ACCEL", "GET_ACCEL", "SET_DECEL", "GET_DECEL",
  "SAVE", "RECOVER"
]);

export class NamedPipeControlAppClient extends EventEmitter implements ControlAppClient {
  private socket?: net.Socket;
  private retryTimer?: NodeJS.Timeout;
  private receiveBuffer = "";
  private nextRequestId = 1;
  private connecting = false;
  private stopped = false;
  private connectedState = false;
  private boardsState: BoardStatus[] = [];
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

  get boards(): BoardStatus[] {
    return this.boardsState;
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
    if (frame.type === "connection_changed") {
      const boards = parseBoardStatusList(frame.boards);
      if (boards) this.setBoards(boards);
      return;
    }
    if (frame.type === "telemetry" && typeof frame.boardId === "string") {
      const snapshot = parseTelemetryFrame(frame);
      if (snapshot) this.emit("telemetry", snapshot);
      return;
    }
    if (frame.type === "fault_trace" && typeof frame.boardId === "string") {
      const capture = parseFaultTraceFrame(frame);
      if (capture) this.emit("faultTrace", capture);
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
    if (!connected && this.boardsState.length > 0) this.setBoards([]);
    if (this.connectedState === connected) return;
    this.connectedState = connected;
    this.emit("connectionChanged", connected);
  }

  private setBoards(boards: BoardStatus[]): void {
    this.boardsState = boards;
    this.emit("boardsChanged", boards);
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

function parseBoardStatusList(value: unknown): BoardStatus[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const boards: BoardStatus[] = [];
  for (const item of value) {
    if (
      !item
      || typeof item !== "object"
      || typeof (item as { boardId?: unknown }).boardId !== "string"
      || typeof (item as { path?: unknown }).path !== "string"
      || !["connected", "disconnected", "error"].includes((item as { state?: unknown }).state as string)
    ) {
      return undefined;
    }
    const entry = item as { boardId: string; path: string; state: BoardStatus["state"] };
    boards.push({ boardId: entry.boardId, path: entry.path, state: entry.state });
  }
  return boards;
}

export function parseTelemetryFrame(frame: Record<string, unknown>): MotorSnapshot | undefined {
  try {
    const axes = parseAxes(frame.axes);
    const power = frame.power === undefined ? undefined : parsePower(frame.power);
    const fault = frame.fault === undefined ? undefined : parseFault(frame.fault);
    const gear = parseGear(frame.gear);
    const jointAngle = parseJointAngle(frame.jointAngle);
    const bleStatus = typeof frame.bleStatus === "string" ? frame.bleStatus : undefined;
    const holdCurrentPercent = frame.holdCurrentPercent === undefined
      ? undefined
      : finiteNumber(frame.holdCurrentPercent, "holdCurrentPercent");
    const metrics: MotorSnapshot["metrics"] = [
      { label: "Axes", value: axes.length },
      { label: "Current", value: power ? `${power.current_mA} mA` : "—" },
      { label: "Voltage", value: power ? `${(power.voltage_mV / 1000).toFixed(2)} V` : "—" },
      { label: "Fault", value: fault?.reason ?? "—" }
    ];
    return {
      kind: "stepping_motor_driver",
      boardId: frame.boardId as string,
      path: "control_app (IPC)",
      state: "monitoring",
      lastUpdate: Date.now(),
      metrics,
      rawLog: [],
      axes,
      power,
      fault,
      gear,
      jointAngle,
      bleStatus,
      holdCurrentPercent
    };
  } catch {
    return undefined;
  }
}

export function parseFaultTraceFrame(frame: Record<string, unknown>): RawFaultTraceCapture | undefined {
  try {
    if (typeof frame.axis !== "number" || typeof frame.intervalMs !== "number") return undefined;
    if (!Array.isArray(frame.samples)) return undefined;
    const samples: FaultTraceSample[] = frame.samples.map((item, index) => {
      if (!isRecord(item)) throw new Error(`samples[${index}]がオブジェクトではありません`);
      return {
        state: String(item.state ?? ""),
        stepPos: finiteNumber(item.stepPos, "stepPos"),
        encSteps: finiteNumber(item.encSteps, "encSteps"),
        diff: finiteNumber(item.diff, "diff"),
        vel: finiteNumber(item.vel, "vel"),
        currentMa: finiteNumber(item.currentMa, "currentMa")
      };
    });
    return {
      boardId: frame.boardId as string,
      localAxis: frame.axis,
      intervalMs: frame.intervalMs,
      capturedAt: typeof frame.capturedAt === "number" ? frame.capturedAt : Date.now(),
      ...(typeof frame.reason === "string" ? { reason: frame.reason } : {}),
      samples
    };
  } catch {
    return undefined;
  }
}

export function parseAxes(value: unknown): MotorAxisStatus[] {
  if (!Array.isArray(value)) throw new Error("axesは配列ではありません");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`axes[${index}]がオブジェクトではありません`);
    return {
      axis: finiteNumber(item.axis, "axis"),
      state: String(item.state ?? ""),
      pos: finiteNumber(item.pos, "pos"),
      vel: finiteNumber(item.vel, "vel"),
      enc: finiteNumber(item.enc, "enc")
    };
  });
}

export function parsePower(value: unknown): MotorPower {
  if (!isRecord(value) || !Array.isArray(value.pot)) throw new Error("power形式が不正です");
  return {
    pot: value.pot.map(item => finiteNumber(item, "pot")),
    current_mA: finiteNumber(value.current_mA, "current_mA"),
    voltage_mV: finiteNumber(value.voltage_mV, "voltage_mV")
  };
}

export function parseFault(value: unknown): MotorFaultInfo {
  if (!isRecord(value)) throw new Error("fault形式が不正です");
  return {
    reason: String(value.reason ?? ""),
    axis_mask: finiteNumber(value.axis_mask, "axis_mask"),
    timestamp_us: finiteNumber(value.timestamp_us, "timestamp_us")
  };
}

export function parseGear(value: unknown): MotorGearStatus[] {
  if (isRecord(value) && value.state === "UNAVAILABLE") return [];
  if (!Array.isArray(value)) throw new Error("gearは配列ではありません");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`gear[${index}]がオブジェクトではありません`);
    const state = String(item.state ?? "UNAVAILABLE");
    if (state !== "OK" && state !== "DEGRADED" && state !== "UNAVAILABLE") {
      throw new Error(`gear[${index}]のstateが不正です`);
    }
    return {
      axis: finiteNumber(item.axis, "axis"),
      angleDeg: state === "UNAVAILABLE" ? null : finiteNumber(item.angleDeg, "angleDeg"),
      state,
      deviationDeg: item.deviationDeg === undefined || item.deviationDeg === null
        ? null
        : finiteNumber(item.deviationDeg, "deviationDeg")
    };
  });
}

export function parseJointAngle(value: unknown): MotorJointAngle[] {
  if (!Array.isArray(value)) throw new Error("jointAngleは配列ではありません");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`jointAngle[${index}]がオブジェクトではありません`);
    return {
      axis: finiteNumber(item.axis, "axis"),
      posDeg: nullableFiniteNumber(item.posDeg, "posDeg"),
      encDeg: nullableFiniteNumber(item.encDeg, "encDeg"),
      potDegRaw: nullableFiniteNumber(item.potDegRaw, "potDegRaw"),
      potDegZeroed: nullableFiniteNumber(item.potDegZeroed, "potDegZeroed")
    };
  });
}

function finiteNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field}が数値ではありません`);
  return number;
}

function nullableFiniteNumber(value: unknown, field: string): number | null {
  return value === null || value === undefined ? null : finiteNumber(value, field);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
