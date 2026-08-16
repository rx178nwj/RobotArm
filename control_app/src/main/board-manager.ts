import { EventEmitter } from "node:events";
import type { Duplex } from "node:stream";
import { SerialPort } from "serialport";
import type {
  BoardEvent,
  BoardStatus,
  CommandResult,
  ControlCommand,
  ControlEvent,
  EstopResult,
  FaultTraceCapture,
  MotorTelemetrySnapshot,
  PortInfo
} from "../shared/types";
import { BoardConnection, COMMAND_TIMEOUT_MS } from "./board-connection";

const COMMANDS = new Set<ControlCommand>([
  "ENABLE", "DISABLE", "STOP", "STOP_FREE", "CLEAR_FAULT",
  "HOME", "MOVE", "MOVETO", "MOVE_DEG", "MOVETO_DEG", "VEL", "SYNC_MOVE",
  "POT_ZERO_SET", "POT_ZERO_CLEAR", "SET_GEAR_RATIO", "GET_GEAR_RATIO",
  "SET_MOTOR_TYPE", "GET_MOTOR_TYPE",
  "SET_DRIVER_TYPE", "GET_DRIVER_TYPE",
  "SET_STALL_FAULT", "GET_STALL_FAULT", "SET_CURRENT_LIMIT", "GET_CURRENT_LIMIT",
  "SET_MICROSTEP", "GET_MICROSTEP",
  "SET_VMAX", "GET_VMAX", "SET_ACCEL", "GET_ACCEL", "SET_DECEL", "GET_DECEL",
  "SAVE", "RECOVER"
]);
const ONE_VALUE_COMMANDS = new Set<ControlCommand>([
  "MOVE", "MOVETO", "VEL", "SET_STALL_FAULT", "SET_VMAX", "SET_ACCEL", "SET_DECEL", "SET_MOTOR_TYPE",
  "SET_DRIVER_TYPE"
]);
const ONE_FINITE_NUMBER_COMMANDS = new Set<ControlCommand>([
  "MOVE_DEG", "MOVETO_DEG", "SET_GEAR_RATIO", "SET_CURRENT_LIMIT"
]);
const VALID_MICROSTEPS = new Set([1, 2, 4, 8, 16, 32]);
const FIRMWARE_COMMANDS: Partial<Record<ControlCommand, string>> = {
  POT_ZERO_SET: "SET POT_ZERO",
  POT_ZERO_CLEAR: "CLEAR POT_ZERO",
  SET_GEAR_RATIO: "SET GEAR_RATIO",
  GET_GEAR_RATIO: "GET GEAR_RATIO",
  SET_MOTOR_TYPE: "SET MOTOR_TYPE",
  GET_MOTOR_TYPE: "GET MOTOR_TYPE",
  SET_DRIVER_TYPE: "SET DRIVER_TYPE",
  GET_DRIVER_TYPE: "GET DRIVER_TYPE",
  SET_STALL_FAULT: "SET STALL_FAULT",
  GET_STALL_FAULT: "GET STALL_FAULT",
  SET_CURRENT_LIMIT: "SET CURRENT_LIMIT",
  SET_VMAX: "SET VMAX",
  GET_VMAX: "GET VMAX",
  SET_ACCEL: "SET ACCEL",
  GET_ACCEL: "GET ACCEL",
  SET_DECEL: "SET DECEL",
  GET_DECEL: "GET DECEL"
};

// SteppingMotorDriver boards enumerate with Espressif's ESP32-S3 USB Serial/JTAG default VID.
// Other USB-serial devices (e.g. multi_i2c_bridge, VID 2e8a) must not be probed here: opening
// them holds the OS-level port handle for up to COMMAND_TIMEOUT_MS while waiting for a
// GET BOARD_ID reply that will never come, starving other apps (robot_arm_monitor) that need
// that same port.
const MOTOR_BOARD_VENDOR_ID = "303a";

export class BoardManager extends EventEmitter {
  private readonly boards = new Map<string, BoardConnection>();
  private readonly connectingPaths = new Set<string>();
  private scanTimer?: NodeJS.Timeout;

  async listPorts(): Promise<PortInfo[]> {
    return (await SerialPort.list()).map(port => ({
      path: port.path,
      ...(port.manufacturer ? { manufacturer: port.manufacturer } : {}),
      ...(port.serialNumber ? { serialNumber: port.serialNumber } : {}),
      ...(port.vendorId ? { vendorId: port.vendorId } : {}),
      ...(port.productId ? { productId: port.productId } : {})
    }));
  }

  async connectPath(path: string): Promise<string> {
    if (this.connectingPaths.has(path) || this.findByPath(path)) {
      throw new Error(`Port is already connected: ${path}`);
    }
    this.connectingPaths.add(path);
    try {
      const connection = await BoardConnection.open(path);
      return this.addInitializedConnection(connection);
    } finally {
      this.connectingPaths.delete(path);
    }
  }

  /** Test hook: add an already-open Duplex implementing the firmware text protocol. */
  async connectStream(
    path: string,
    stream: Duplex,
    timeoutMs = COMMAND_TIMEOUT_MS,
    options: { telemetry?: boolean } = {}
  ): Promise<string> {
    const connection = new BoardConnection(stream, path, timeoutMs);
    await connection.initialize();
    return this.addInitializedConnection(connection, options.telemetry ?? true);
  }

  async discoverAndConnect(): Promise<void> {
    const ports = await this.listPorts();
    const candidates = ports.filter(port => port.vendorId?.toLowerCase() === MOTOR_BOARD_VENDOR_ID);
    await Promise.allSettled(candidates.map(async port => {
      if (this.findByPath(port.path) || this.connectingPaths.has(port.path)) return;
      try {
        await this.connectPath(port.path);
      } catch (error) {
        this.emit("log", `Probe ${port.path} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
    }));
  }

  startDiscovery(intervalMs = 3000): void {
    if (this.scanTimer) return;
    void this.discoverAndConnect();
    this.scanTimer = setInterval(() => void this.discoverAndConnect(), intervalMs);
  }

  stopDiscovery(): void {
    if (this.scanTimer) clearInterval(this.scanTimer);
    this.scanTimer = undefined;
  }

  getBoards(): BoardStatus[] {
    return [...this.boards.values()].map(board => ({
      boardId: board.boardId,
      path: board.path,
      state: "connected"
    }));
  }

  async execute(
    boardId: string,
    axis: number,
    command: string,
    args?: unknown[]
  ): Promise<CommandResult> {
    const connection = this.boards.get(boardId);
    if (!connection) return { ok: false, error: "NOT_CONNECTED" };
    const firmwareCommand = this.mapCommand(axis, command, args);
    if (!firmwareCommand.ok) return firmwareCommand;
    const result = await connection.request(firmwareCommand.value);
    // GET commands return their value in `data` (the "OK <rest>" payload); fold it into
    // `message` so it survives the CommandResult shape sent back over the IPC pipe.
    if (result.data !== undefined && result.message === undefined) {
      return {
        ok: result.ok,
        ...(result.error !== undefined ? { error: result.error } : {}),
        message: result.data
      };
    }
    return result;
  }

  async estopAll(): Promise<EstopResult> {
    const requests = [...this.boards.entries()].map(async ([boardId, connection]) => {
      const result = await connection.request("ESTOP");
      return { boardId, ...result };
    });
    return { results: await Promise.all(requests) };
  }

  disconnect(boardId: string): void {
    this.boards.get(boardId)?.close();
  }

  closeAll(): void {
    this.stopDiscovery();
    for (const board of [...this.boards.values()]) board.close();
  }

  private addInitializedConnection(connection: BoardConnection, enableTelemetry = true): string {
    if (!connection.boardId) throw new Error("Board connection is not initialized");
    if (this.boards.has(connection.boardId)) {
      connection.close();
      throw new Error(`Board ${connection.boardId} is already connected`);
    }
    this.boards.set(connection.boardId, connection);
    connection.on("boardEvent", (event: BoardEvent) => {
      this.emit("controlEvent", {
        boardId: connection.boardId,
        event: event.event,
        ...(event.axis !== undefined ? { axis: event.axis } : {})
      } satisfies ControlEvent);
      if (event.event === "FAULT") {
        void this.captureFaultTrace(connection, event.data[0]);
      }
    });
    connection.on("log", message => this.emit("log", `${connection.boardId || connection.path}: ${message}`));
    connection.once("disconnected", () => {
      connection.stopTelemetryPolling();
      if (this.boards.get(connection.boardId) !== connection) return;
      this.boards.delete(connection.boardId);
      this.emit("connectionChanged", this.getBoards());
    });
    if (enableTelemetry) {
      connection.startTelemetryPolling((snapshot: MotorTelemetrySnapshot) => this.emit("telemetry", snapshot));
    }
    this.emit("connectionChanged", this.getBoards());
    return connection.boardId;
  }

  /**
   * Pulls the firmware's FAULT_TRACE ring buffer for all 3 axes right after an EVT FAULT, so a
   * later analysis panel can show what led up to the stop. Best-effort: a failed axis is skipped
   * rather than aborting the others.
   */
  private async captureFaultTrace(connection: BoardConnection, reason?: string): Promise<void> {
    const capturedAt = Date.now();
    for (let axis = 0; axis < 3; axis++) {
      try {
        const trace = await connection.getFaultTrace(axis);
        if (!trace) continue;
        this.emit("faultTrace", {
          boardId: connection.boardId,
          axis,
          intervalMs: trace.intervalMs,
          capturedAt,
          ...(reason ? { reason } : {}),
          samples: trace.samples
        } satisfies FaultTraceCapture);
      } catch {
        // Best-effort capture; a disconnect mid-capture just skips the remaining axes.
      }
    }
  }

  private findByPath(path: string): BoardConnection | undefined {
    return [...this.boards.values()].find(board => board.path === path);
  }

  private mapCommand(
    axis: number,
    commandValue: string,
    args?: unknown[]
  ): { ok: true; value: string } | ({ ok: false } & CommandResult) {
    if (!Number.isInteger(axis) || axis < 0 || axis > 2) {
      return { ok: false, error: "INVALID_REQUEST", message: "axis must be an integer from 0 to 2" };
    }
    if (!COMMANDS.has(commandValue as ControlCommand)) {
      return { ok: false, error: "INVALID_REQUEST", message: "Unsupported command" };
    }
    const command = commandValue as ControlCommand;
    const values = args ?? [];
    if (command === "CLEAR_FAULT") {
      return values.length === 0
        ? { ok: true, value: "CLEAR_FAULT" }
        : { ok: false, error: "INVALID_REQUEST", message: "CLEAR_FAULT takes no args" };
    }
    if (command === "RECOVER") {
      // CLEAR_FAULT + ENABLE combined; board-wide like CLEAR_FAULT, no per-axis form.
      return values.length === 0
        ? { ok: true, value: "RECOVER" }
        : { ok: false, error: "INVALID_REQUEST", message: "RECOVER takes no args" };
    }
    if (command === "SAVE") {
      // Persists all axes' F-MOT-10 parameters at once; the board has no per-axis SAVE.
      return values.length === 0
        ? { ok: true, value: "SAVE" }
        : { ok: false, error: "INVALID_REQUEST", message: "SAVE takes no args" };
    }
    if (command === "GET_CURRENT_LIMIT") {
      // Board-wide (single ADC current sensor shared by all 3 axes), so no axis suffix.
      return values.length === 0
        ? { ok: true, value: "GET CURRENT_LIMIT" }
        : { ok: false, error: "INVALID_REQUEST", message: "GET_CURRENT_LIMIT takes no args" };
    }
    if (command === "GET_MICROSTEP") {
      // Board-wide (M0/M1/M2 are shared GPIOs across all 3 axes), so no axis suffix.
      return values.length === 0
        ? { ok: true, value: "GET MICROSTEP" }
        : { ok: false, error: "INVALID_REQUEST", message: "GET_MICROSTEP takes no args" };
    }
    if (command === "SET_MICROSTEP") {
      // Board-wide, no axis suffix; firmware only accepts 1/2/4/8/16/32.
      if (values.length !== 1 || !VALID_MICROSTEPS.has(values[0] as number)) {
        return { ok: false, error: "INVALID_REQUEST", message: "SET_MICROSTEP requires one of 1,2,4,8,16,32" };
      }
      return { ok: true, value: `SET MICROSTEP ${values[0]}` };
    }
    if (command === "SYNC_MOVE") return this.mapSyncMove(values);
    if (ONE_VALUE_COMMANDS.has(command)) {
      if (values.length !== 1 || !this.isInt32(values[0])) {
        return { ok: false, error: "INVALID_REQUEST", message: `${command} requires one int32 argument` };
      }
      return { ok: true, value: `${FIRMWARE_COMMANDS[command] ?? command} ${axis} ${values[0]}` };
    }
    if (ONE_FINITE_NUMBER_COMMANDS.has(command)) {
      if (values.length !== 1 || typeof values[0] !== "number" || !Number.isFinite(values[0])) {
        return { ok: false, error: "INVALID_REQUEST", message: `${command} requires one finite number argument` };
      }
      return { ok: true, value: `${FIRMWARE_COMMANDS[command] ?? command} ${axis} ${values[0]}` };
    }
    if (values.length !== 0) {
      return { ok: false, error: "INVALID_REQUEST", message: `${command} takes no args` };
    }
    return { ok: true, value: `${FIRMWARE_COMMANDS[command] ?? command} ${axis}` };
  }

  private mapSyncMove(args: unknown[]): { ok: true; value: string } | ({ ok: false } & CommandResult) {
    if (args.length !== 1 || !Array.isArray(args[0])) {
      return { ok: false, error: "INVALID_REQUEST", message: "SYNC_MOVE requires an array of axis/steps pairs" };
    }
    const pairs = args[0] as unknown[];
    if (pairs.length < 2 || pairs.length > 3) {
      return { ok: false, error: "INVALID_REQUEST", message: "SYNC_MOVE requires 2 or 3 pairs" };
    }
    const flattened: number[] = [];
    const axes = new Set<number>();
    for (const pair of pairs) {
      if (!Array.isArray(pair) || pair.length !== 2 || !Number.isInteger(pair[0])
        || (pair[0] as number) < 0 || (pair[0] as number) > 2 || !this.isInt32(pair[1])) {
        return { ok: false, error: "INVALID_REQUEST", message: "Invalid SYNC_MOVE pair" };
      }
      const pairAxis = pair[0] as number;
      if (axes.has(pairAxis)) {
        return { ok: false, error: "INVALID_REQUEST", message: "Duplicate SYNC_MOVE axis" };
      }
      axes.add(pairAxis);
      flattened.push(pairAxis, pair[1] as number);
    }
    return { ok: true, value: `SYNC_MOVE ${pairs.length} ${flattened.join(" ")}` };
  }

  private isInt32(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= -2147483648 && (value as number) <= 2147483647;
  }
}
