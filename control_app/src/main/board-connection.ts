import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { SerialPort } from "serialport";
import type {
  BoardEvent,
  CommandResult,
  FaultTraceSample,
  MotorAxisTelemetry,
  MotorFaultTelemetry,
  MotorGearTelemetry,
  MotorJointAngleTelemetry,
  MotorPowerTelemetry,
  MotorTelemetrySnapshot
} from "../shared/types";

export const BOARD_BAUD_RATE = 115200;
export const COMMAND_TIMEOUT_MS = 5000;
export const TELEMETRY_POLL_INTERVAL_MS = 1000;

// SteppingMotorDriver boards expose 3 motor axes (local axis 0-2, see board-manager.ts).
const NUM_AXES = 3;

// Mirrors axis_state_t in SteppingMotorDriver/firmware/main/motor_ctrl.h — used to decode the
// numeric `state` field in GET FAULT_TRACE samples back into the same strings GET STATE returns.
const AXIS_STATE_NAMES = ["SLEEP", "IDLE", "ACCEL", "CRUISE", "DECEL", "HOMING", "FAULT"];

interface QueuedCommand {
  command: string;
  resolve: (result: CommandResult & { data?: string }) => void;
}

interface ActiveCommand extends QueuedCommand {
  timer: NodeJS.Timeout;
}

export class BoardConnectionError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code);
    this.name = "BoardConnectionError";
  }
}

/** One ordered request/response session with one SteppingMotorDriver board. */
export class BoardConnection extends EventEmitter {
  boardId = "";
  readonly path: string;
  private buffer = "";
  private active?: ActiveCommand;
  private readonly queue: QueuedCommand[] = [];
  private closed = false;
  private telemetryTimer?: NodeJS.Timeout;
  private telemetryStopped = true;

  constructor(
    private readonly stream: Duplex,
    path: string,
    private readonly timeoutMs = COMMAND_TIMEOUT_MS
  ) {
    super();
    this.path = path;
    stream.setEncoding("utf8");
    stream.on("data", chunk => this.handleData(String(chunk)));
    stream.on("close", () => this.handleClosed("Serial port closed"));
    stream.on("end", () => this.handleClosed("Serial port ended"));
    stream.on("error", error => {
      this.emit("log", `ERROR ${error.message}`);
      this.handleClosed(error.message);
      if (!stream.destroyed) stream.destroy();
    });
  }

  static async open(path: string, timeoutMs = COMMAND_TIMEOUT_MS): Promise<BoardConnection> {
    const port = new SerialPort({ path, baudRate: BOARD_BAUD_RATE, autoOpen: false });
    await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
    const connection = new BoardConnection(port, path, timeoutMs);
    try {
      await connection.initialize();
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  async initialize(): Promise<string> {
    const result = await this.request("GET BOARD_ID");
    if (!result.ok) throw new BoardConnectionError(result.error ?? "E012", result.message);
    const boardId = result.data?.trim() ?? "";
    if (!/^[0-9A-F]{12}$/.test(boardId)) {
      throw new BoardConnectionError("E012", "BOARD_ID_UNAVAILABLE");
    }
    this.boardId = boardId;
    return boardId;
  }

  request(command: string): Promise<CommandResult & { data?: string }> {
    if (this.closed) return Promise.resolve({ ok: false, error: "NOT_CONNECTED" });
    if (!command || /[\r\n]/.test(command)) {
      return Promise.resolve({ ok: false, error: "INVALID_REQUEST", message: "Invalid command" });
    }
    return new Promise(resolve => {
      this.queue.push({ command, resolve });
      this.dispatchNext();
    });
  }

  /** Periodically polls the GET commands equivalent to the (now unused) BLE telemetry service. */
  startTelemetryPolling(
    onSnapshot: (snapshot: MotorTelemetrySnapshot) => void,
    intervalMs = TELEMETRY_POLL_INTERVAL_MS
  ): void {
    if (!this.telemetryStopped) return;
    this.telemetryStopped = false;
    const loop = async (): Promise<void> => {
      if (this.telemetryStopped || this.closed) return;
      try {
        const snapshot = await this.pollTelemetry();
        if (snapshot && !this.telemetryStopped) onSnapshot(snapshot);
      } catch {
        // Best-effort; the next cycle retries.
      }
      if (!this.telemetryStopped && !this.closed) {
        this.telemetryTimer = setTimeout(() => void loop(), intervalMs);
      }
    };
    void loop();
  }

  stopTelemetryPolling(): void {
    this.telemetryStopped = true;
    if (this.telemetryTimer) clearTimeout(this.telemetryTimer);
    this.telemetryTimer = undefined;
  }

  private async pollTelemetry(): Promise<MotorTelemetrySnapshot | undefined> {
    const axes = await this.pollAxes();
    if (!axes) return undefined;
    const power = await this.pollPower();
    if (!power) return undefined;
    const fault = await this.pollFault();
    const jointAngle = await this.pollJointAngle();
    const gear = await this.pollGear();
    const bleStatus = await this.pollBleStatus();
    const holdCurrentPercent = await this.pollHoldCurrentPercent();
    return { boardId: this.boardId, axes, power, fault, gear, jointAngle, bleStatus, holdCurrentPercent };
  }

  private async pollAxes(): Promise<MotorAxisTelemetry[] | undefined> {
    const axes: MotorAxisTelemetry[] = [];
    for (let axis = 0; axis < NUM_AXES; axis++) {
      const state = await this.request(`GET STATE ${axis}`);
      const pos = await this.request(`GET POS ${axis}`);
      const vel = await this.request(`GET VEL ${axis}`);
      const enc = await this.request(`GET ENC ${axis}`);
      if (!state.ok || !pos.ok || !vel.ok) return undefined;
      // OPEN_LOOP axes have no encoder; firmware rejects GET ENC with E002 INVALID_PARAM
      // for them (comm.c). That's expected, not a poll failure — report 0 for that axis
      // instead of discarding the whole snapshot.
      if (!enc.ok && enc.error !== "E002") return undefined;
      axes.push({
        axis,
        state: (state.data ?? "").trim(),
        pos: Number(pos.data),
        vel: Number(vel.data),
        enc: enc.ok ? Number(enc.data) : 0
      });
    }
    return axes;
  }

  private async pollPower(): Promise<MotorPowerTelemetry | undefined> {
    const pot: number[] = [];
    for (let channel = 0; channel < 3; channel++) {
      const result = await this.request(`GET ADC ${channel}`);
      if (!result.ok) return undefined;
      pot.push(Number(result.data));
    }
    const voltage = await this.request("GET ADC 3");
    const current = await this.request("GET ADC 4");
    if (!voltage.ok || !current.ok) return undefined;
    return { pot, current_mA: Number(current.data), voltage_mV: Number(voltage.data) * 1000 };
  }

  private async pollFault(): Promise<MotorFaultTelemetry | undefined> {
    const result = await this.request("GET FAULT_INFO");
    if (!result.ok || !result.data) return undefined;
    const parts = result.data.trim().split(/\s+/);
    if (parts.length !== 3) return undefined;
    return { reason: parts[0], axis_mask: Number(parts[1]), timestamp_us: Number(parts[2]) };
  }

  private async pollBleStatus(): Promise<string | undefined> {
    const result = await this.request("GET BLE_STATUS");
    if (result.ok) return (result.data ?? "").trim() || undefined;
    return result.error === "E016" ? "ERROR" : undefined;
  }

  private async pollHoldCurrentPercent(): Promise<number | undefined> {
    const result = await this.request("GET HOLD_CURRENT_PERCENT");
    if (!result.ok || result.data === undefined) return undefined;
    const value = Number(result.data);
    return Number.isFinite(value) ? value : undefined;
  }

  /** GET FAULT_TRACE <axis> — the firmware's 10ms ring buffer of state/pos/enc/diff/vel/current. */
  async getFaultTrace(axis: number): Promise<{ intervalMs: number; samples: FaultTraceSample[] } | undefined> {
    const result = await this.request(`GET FAULT_TRACE ${axis}`);
    if (!result.ok || !result.data) return undefined;
    let parsed: { interval_ms?: unknown; samples?: unknown };
    try {
      parsed = JSON.parse(result.data) as { interval_ms?: unknown; samples?: unknown };
    } catch {
      return undefined;
    }
    if (typeof parsed.interval_ms !== "number" || !Array.isArray(parsed.samples)) return undefined;
    const samples: FaultTraceSample[] = [];
    for (const item of parsed.samples) {
      if (!Array.isArray(item) || item.length !== 6 || !item.every(value => typeof value === "number")) {
        return undefined;
      }
      const [state, stepPos, encSteps, diff, vel, currentMa] = item as number[];
      samples.push({ state: AXIS_STATE_NAMES[state] ?? String(state), stepPos, encSteps, diff, vel, currentMa });
    }
    return { intervalMs: parsed.interval_ms, samples };
  }

  private async pollJointAngle(): Promise<MotorJointAngleTelemetry[]> {
    const jointAngle: MotorJointAngleTelemetry[] = [];
    for (let axis = 0; axis < NUM_AXES; axis++) {
      const posDegResult = await this.request(`GET POS_DEG ${axis}`);
      const encDegResult = await this.request(`GET ENC_DEG ${axis}`);
      const potDegResult = await this.request(`GET POT_DEG ${axis}`);
      let potDegRaw: number | null = null;
      let potDegZeroed: number | null = null;
      if (potDegResult.ok && potDegResult.data) {
        const parts = potDegResult.data.trim().split(/\s+/);
        if (parts.length === 2) {
          potDegRaw = Number(parts[0]);
          potDegZeroed = Number(parts[1]);
        }
      }
      jointAngle.push({
        axis,
        posDeg: posDegResult.ok && posDegResult.data !== undefined ? Number(posDegResult.data) : null,
        encDeg: encDegResult.ok && encDegResult.data !== undefined ? Number(encDegResult.data) : null,
        potDegRaw,
        potDegZeroed
      });
    }
    return jointAngle;
  }

  private async pollGear(): Promise<MotorGearTelemetry[]> {
    const result = await this.request("GET GEAR_STATUS");
    if (!result.ok || !result.data) return [];
    let parsed: { axes?: unknown[] };
    try {
      parsed = JSON.parse(result.data) as { axes?: unknown[] };
    } catch {
      return [];
    }
    if (!Array.isArray(parsed.axes)) return [];
    return parsed.axes.map((item, axis) => {
      const entry = item as {
        ok?: unknown;
        enabled?: unknown;
        deg?: unknown;
        home_valid?: unknown;
        deviation?: unknown;
      };
      const available = entry.ok === true && entry.enabled === true;
      return {
        axis,
        angleDeg: available && typeof entry.deg === "number" ? entry.deg : null,
        state: available ? "OK" : "UNAVAILABLE",
        deviationDeg: entry.home_valid === true && typeof entry.deviation === "number"
          ? entry.deviation
          : null
      };
    });
  }

  close(): void {
    if (this.closed) return;
    this.handleClosed("Connection closed");
    if (!this.stream.destroyed) this.stream.destroy();
  }

  private dispatchNext(): void {
    if (this.active || this.closed) return;
    const queued = this.queue.shift();
    if (!queued) return;
    let active: ActiveCommand;
    const timer = setTimeout(() => {
      if (this.active !== active) return;
      this.active = undefined;
      queued.resolve({ ok: false, error: "TIMEOUT" });
      this.emit("log", `TIMEOUT ${queued.command}`);
      this.dispatchNext();
    }, this.timeoutMs);
    active = { ...queued, timer };
    this.active = active;
    this.emit("log", `TX ${queued.command}`);
    this.stream.write(`${queued.command}\n`, error => {
      if (!error || this.active !== active) return;
      clearTimeout(timer);
      this.active = undefined;
      queued.resolve({ ok: false, error: "NOT_CONNECTED", message: error.message });
      this.dispatchNext();
    });
  }

  private handleData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim().replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleLine(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleLine(line: string): void {
    this.emit("log", `RX ${line}`);
    if (line.startsWith("EVT ")) {
      const tokens = line.slice(4).trim().split(/\s+/);
      const event = tokens.shift();
      if (!event) return;
      const first = tokens[0];
      const axis = first !== undefined && /^-?\d+$/.test(first) ? Number(first) : undefined;
      this.emit("boardEvent", {
        event,
        ...(axis !== undefined ? { axis } : {}),
        data: tokens
      } satisfies BoardEvent);
      return;
    }
    const active = this.active;
    if (!active) return;
    let result: CommandResult & { data?: string };
    if (line === "OK") {
      result = { ok: true };
    } else if (line.startsWith("OK ")) {
      result = { ok: true, data: line.slice(3) };
    } else if (line.startsWith("ERR ")) {
      const match = /^ERR\s+(\S+)(?:\s+(.*))?$/.exec(line);
      if (!match) return;
      result = {
        ok: false,
        error: match[1],
        ...(match[2] ? { message: match[2] } : {})
      };
    } else {
      return;
    }
    clearTimeout(active.timer);
    this.active = undefined;
    active.resolve(result);
    this.dispatchNext();
  }

  private handleClosed(message: string): void {
    if (this.closed) return;
    this.closed = true;
    this.stopTelemetryPolling();
    if (this.active) {
      clearTimeout(this.active.timer);
      this.active.resolve({ ok: false, error: "NOT_CONNECTED", message });
      this.active = undefined;
    }
    for (const queued of this.queue.splice(0)) {
      queued.resolve({ ok: false, error: "NOT_CONNECTED", message });
    }
    this.emit("disconnected", message);
  }
}
