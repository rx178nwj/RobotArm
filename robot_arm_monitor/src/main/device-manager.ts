import { SerialPort } from "serialport";
import type {
  BoardStatus,
  BridgeConfigRefreshResult,
  BridgeMaintenanceRequest,
  BridgeMaintenanceResult,
  BridgeSnapshot,
  CommandResult,
  ConnectResult,
  ControlCommandRequest,
  DeviceSnapshot,
  EstopResult,
  AxisSnapshot,
  FaultTraceCapture,
  GearRelayState,
  MotorAxisStatus,
  MotorSnapshot,
  RobotArmSnapshot,
  PortInfo,
  RawLogEntry,
  SyncMoveAxisRequest
} from "../shared/types";
import type { AxisMappingStore } from "./axis-mapping";
import type { ControlAppClient, RawFaultTraceCapture } from "./adapters/control-app-client";
import { MultiI2cBridgeAdapter } from "./adapters/multi-i2c-bridge-adapter";
import type { DeviceAdapter } from "./adapters/device-adapter";
import { VID_HINT } from "./adapters/device-adapter";
import { identifyPort, makeProbeLog } from "./adapters/port-identity";

export class DeviceManager {
  private readonly adapters = new Map<string, DeviceAdapter>();
  private readonly boardByPath = new Map<string, string>();
  private readonly connectingPaths = new Set<string>();
  private readonly latestSnapshots = new Map<string, DeviceSnapshot>();
  private loggingPeriodMs?: number;
  private loggingSnapshot?: (snapshot: BridgeSnapshot) => void;
  private loggingError?: (message: string) => void;
  private readonly loggingErrorBoards = new Set<string>();
  private controlAppBoards: BoardStatus[] = [];

  constructor(
    private readonly onUpdate: (snapshot: DeviceSnapshot) => void,
    private readonly controlClient: ControlAppClient,
    private readonly mappingStore: AxisMappingStore,
    private readonly onRobotArmUpdate?: (snapshot: RobotArmSnapshot) => void,
    private readonly onFaultTrace?: (capture: FaultTraceCapture) => void
  ) {
    this.controlAppBoards = controlClient.boards;
    controlClient.on("boardsChanged", boards => {
      this.controlAppBoards = boards;
      const connected = new Set(boards.filter(board => board.state === "connected").map(board => board.boardId));
      for (const [boardId, snapshot] of this.latestSnapshots) {
        if (snapshot.kind !== "stepping_motor_driver" || snapshot.state === "disconnected") continue;
        if (!connected.has(boardId)) this.latestSnapshots.set(boardId, { ...snapshot, state: "disconnected" });
      }
      this.publishRobotArmSnapshot();
    });
    controlClient.on("telemetry", snapshot => {
      this.latestSnapshots.set(snapshot.boardId, snapshot);
      this.onUpdate(snapshot);
      this.publishRobotArmSnapshot();
    });
    controlClient.on("faultTrace", raw => this.onFaultTrace?.(this.resolveFaultTrace(raw)));
  }

  getControlAppBoards(): BoardStatus[] {
    return this.controlAppBoards;
  }

  getRobotArmSnapshot(): RobotArmSnapshot {
    return composeRobotArmSnapshot(
      [...this.latestSnapshots.values()],
      this.mappingStore.get(),
      this.controlClient.connected
    );
  }

  publishRobotArmSnapshot(): void {
    this.onRobotArmUpdate?.(this.getRobotArmSnapshot());
  }

  get controlAppConnected(): boolean {
    return this.controlClient.connected;
  }

  async executeControlCommand(request: ControlCommandRequest): Promise<CommandResult> {
    if (!this.controlClient.connected) throw new Error("Control application is not connected");
    if (!request || typeof request !== "object") throw new Error("Invalid control command request");
    const target = this.resolveMotorAxis(request.logicalAxis);
    const args = validateControlArgs(request.command, request.args);
    return this.controlClient.sendCommand(
      target.motorBoardId,
      target.motorLocalAxis,
      request.command,
      args
    );
  }

  async executeSyncMove(requests: SyncMoveAxisRequest[]): Promise<CommandResult> {
    if (!this.controlClient.connected) throw new Error("Control application is not connected");
    if (!Array.isArray(requests) || requests.length < 2 || requests.length > 3) {
      throw new Error("SYNC_MOVE requires 2-3 logical axes");
    }
    const seen = new Set<number>();
    const targets = requests.map(request => {
      if (!request || typeof request !== "object") throw new Error("Invalid SYNC_MOVE axis request");
      const logicalAxis = validLogicalAxis(request.logicalAxis);
      if (seen.has(logicalAxis)) throw new Error(`Logical axis ${logicalAxis} is duplicated`);
      seen.add(logicalAxis);
      const steps = validMotionValue(request.steps, "SYNC_MOVE steps");
      return { ...this.resolveMotorAxis(logicalAxis), steps };
    });
    const boardId = targets[0].motorBoardId;
    if (targets.some(target => target.motorBoardId !== boardId)) {
      throw new Error("SYNC_MOVE axes must belong to the same motor board");
    }
    return this.controlClient.sendCommand(
      boardId,
      targets[0].motorLocalAxis,
      "SYNC_MOVE",
      targets.map(target => [target.motorLocalAxis, target.steps])
    );
  }

  sendEstop(): Promise<EstopResult> {
    if (!this.controlClient.connected) {
      return Promise.reject(new Error("Control application is not connected"));
    }
    return this.controlClient.sendEstop();
  }

  async listPorts(): Promise<PortInfo[]> {
    return (await SerialPort.list()).map(port => {
      const vendorId = port.vendorId?.toLowerCase();
      const kindHint = vendorId ? VID_HINT[vendorId] : undefined;
      return {
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId,
        productId: port.productId,
        friendlyName: [port.manufacturer, port.path].filter(Boolean).join(" · ") || port.path,
        candidate: kindHint === "multi_i2c_bridge",
        kindHint
      };
    });
  }

  async connect(info: PortInfo, periodMs = 100): Promise<ConnectResult> {
    if (this.boardByPath.has(info.path) || this.connectingPaths.has(info.path)) {
      throw new Error(`${info.path} is already connected or connecting`);
    }
    this.connectingPaths.add(info.path);

    const probe = makeProbeLog();
    let identity;
    try {
      identity = await identifyPort(info, 1500, probe.logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rawLog: RawLogEntry[] = [
        ...probe.entries,
        { timestamp: Date.now(), direction: "system", text: `Identity verification failed: ${message}` }
      ];
      this.onUpdate({
        kind: "multi_i2c_bridge",
        boardId: "unidentified",
        path: info.path,
        state: "disconnected",
        error: message,
        lastUpdate: Date.now(),
        metrics: [],
        rawLog
      });
      this.connectingPaths.delete(info.path);
      throw error;
    }
    try {
      if (this.adapters.has(identity.id)) {
        throw new Error(`Board ${identity.id} is already connected`);
      }
      const adapter = new MultiI2cBridgeAdapter(identity.id, String(identity.protocol), probe.entries);
      adapter.on("update", snapshot => {
        this.latestSnapshots.set(snapshot.boardId, snapshot);
        if (
          this.loggingPeriodMs !== undefined
          && (snapshot.state === "disconnected" || snapshot.state === "error")
          && !this.loggingErrorBoards.has(snapshot.boardId)
        ) {
          this.loggingErrorBoards.add(snapshot.boardId);
          this.loggingError?.(
            `Bridge ${snapshot.boardId} のログ記録を停止しました: ${snapshot.error ?? snapshot.state}`
          );
        }
        if (snapshot.state === "disconnected") {
          this.boardByPath.delete(snapshot.path);
          if (this.adapters.get(snapshot.boardId) === adapter) this.adapters.delete(snapshot.boardId);
        }
        this.onUpdate(snapshot);
        this.publishRobotArmSnapshot();
      });
      adapter.on("logSnapshot", snapshot => this.loggingSnapshot?.(snapshot));
      this.adapters.set(identity.id, adapter);
      await adapter.connect(info.path, periodMs);
      this.boardByPath.set(info.path, identity.id);
      if (this.loggingPeriodMs !== undefined) adapter.startLogging(this.loggingPeriodMs);
      void adapter.requestConfig().catch(() => {
        // The comparison view exposes a manual retry and reports per-board failures.
      });
    } catch (error) {
      this.adapters.delete(identity.id);
      throw error;
    } finally {
      this.connectingPaths.delete(info.path);
    }
    return { boardId: identity.id };
  }

  disconnect(boardId: string): void {
    const adapter = this.adapters.get(boardId);
    adapter?.disconnect();
    this.adapters.delete(boardId);
    for (const [path, connectedBoardId] of this.boardByPath) {
      if (connectedBoardId === boardId) this.boardByPath.delete(path);
    }
    this.publishRobotArmSnapshot();
  }

  async executeBridgeMaintenance(
    boardId: string,
    request: BridgeMaintenanceRequest
  ): Promise<BridgeMaintenanceResult> {
    const adapter = this.adapters.get(boardId);
    if (!adapter) throw new Error(`Board ${boardId} is not connected`);
    if (adapter.kind !== "multi_i2c_bridge") throw new Error("Maintenance commands require a bridge board");
    const command = bridgeMaintenanceCommand(request);
    const response = await adapter.executeCommand(command);
    if (request.action !== "reboot") {
      setTimeout(() => {
        try {
          adapter.sendCommand("status");
          adapter.sendCommand("channels");
        } catch {
          // Disconnects after an acknowledged command are reported by the adapter.
        }
      }, 100);
    }
    return { boardId, command, response };
  }

  async refreshBridgeConfigs(): Promise<BridgeConfigRefreshResult[]> {
    const bridges = [...this.adapters.values()].filter(
      (adapter): adapter is MultiI2cBridgeAdapter => adapter instanceof MultiI2cBridgeAdapter
    );
    return Promise.all(bridges.map(async adapter => {
      try {
        return { boardId: adapter.boardId, config: await adapter.requestConfig() };
      } catch (error) {
        return {
          boardId: adapter.boardId,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    }));
  }

  startBridgeLogging(
    periodMs: number,
    onSnapshot: (snapshot: BridgeSnapshot) => void,
    onError: (message: string) => void
  ): void {
    this.loggingPeriodMs = Math.max(100, Math.min(60000, periodMs));
    this.loggingSnapshot = onSnapshot;
    this.loggingError = onError;
    this.loggingErrorBoards.clear();
    for (const adapter of this.adapters.values()) {
      if (adapter instanceof MultiI2cBridgeAdapter) adapter.startLogging(this.loggingPeriodMs);
    }
  }

  stopBridgeLogging(): void {
    for (const adapter of this.adapters.values()) {
      if (adapter instanceof MultiI2cBridgeAdapter) adapter.stopLogging();
    }
    this.loggingPeriodMs = undefined;
    this.loggingSnapshot = undefined;
    this.loggingError = undefined;
    this.loggingErrorBoards.clear();
  }

  connectedBridgeCount(): number {
    return [...this.adapters.values()].filter(
      adapter => adapter instanceof MultiI2cBridgeAdapter
    ).length;
  }

  getSnapshotsForExport(): DeviceSnapshot[] {
    const snapshots = new Map(this.latestSnapshots);
    for (const adapter of this.adapters.values()) {
      if (adapter instanceof MultiI2cBridgeAdapter) {
        snapshots.set(adapter.boardId, adapter.getSnapshot());
      }
    }
    return [...snapshots.values()];
  }

  disconnectAll(): void {
    this.stopBridgeLogging();
    for (const adapter of this.adapters.values()) adapter.disconnect();
    this.adapters.clear();
    this.boardByPath.clear();
    this.connectingPaths.clear();
    const close = (this.controlClient as ControlAppClient & { close?: () => void }).close;
    close?.call(this.controlClient);
  }

  private resolveFaultTrace(raw: RawFaultTraceCapture): FaultTraceCapture {
    const settings = this.mappingStore.get();
    const mapping = settings.axisMapping.find(entry =>
      entry.motorBoardId === raw.boardId && entry.motorLocalAxis === raw.localAxis
    );
    const boardLabel = settings.boardLabels[raw.boardId] || raw.boardId;
    return {
      boardId: raw.boardId,
      localAxis: raw.localAxis,
      axisLabel: mapping ? mapping.label : `未割当 (${boardLabel} / Axis ${raw.localAxis})`,
      logicalAxisId: mapping?.axisId ?? null,
      intervalMs: raw.intervalMs,
      capturedAt: raw.capturedAt,
      ...(raw.reason ? { reason: raw.reason } : {}),
      samples: raw.samples
    };
  }

  private resolveMotorAxis(logicalAxisValue: unknown): {
    motorBoardId: string;
    motorLocalAxis: number;
  } {
    const logicalAxis = validLogicalAxis(logicalAxisValue);
    const mapping = this.mappingStore.get().axisMapping.find(entry => entry.axisId === logicalAxis);
    if (!mapping || mapping.motorBoardId === undefined || mapping.motorLocalAxis === undefined) {
      throw new Error(`Logical axis ${logicalAxis} is not assigned to a motor board`);
    }
    return {
      motorBoardId: mapping.motorBoardId,
      motorLocalAxis: mapping.motorLocalAxis
    };
  }
}

export function composeRobotArmSnapshot(
  snapshots: DeviceSnapshot[],
  settings: ReturnType<AxisMappingStore["get"]>,
  controlAppConnected: boolean,
  timestamp = Date.now(),
  mismatchThresholdDeg = 1
): RobotArmSnapshot {
  const byId = new Map(snapshots.map(snapshot => [snapshot.boardId, snapshot]));
  const axes: AxisSnapshot[] = settings.axisMapping.map(mapping => {
    const axis: AxisSnapshot = { axisId: mapping.axisId, axisLabel: mapping.label };
    const motorSnapshot = mapping.motorBoardId
      ? byId.get(mapping.motorBoardId) as MotorSnapshot | undefined
      : undefined;
    const motor = motorSnapshot?.kind === "stepping_motor_driver"
      ? motorSnapshot.axes.find(item => item.axis === mapping.motorLocalAxis)
      : undefined;
    if (motor && motorSnapshot) {
      const { errorCode, errorReason } = axisFaultDisplay(motor, motorSnapshot);
      axis.motor = {
        boardId: motorSnapshot.boardId,
        localAxis: motor.axis,
        state: motor.state,
        stepPos: motor.pos,
        encoderPos: motor.enc,
        deviation: motor.pos - motor.enc,
        velocity: motor.vel,
        currentMa: motorSnapshot.power?.current_mA ?? 0,
        voltageV: (motorSnapshot.power?.voltage_mV ?? 0) / 1000,
        ...(errorCode ? { errorCode, errorReason } : {}),
        ...(motorSnapshot.holdCurrentPercent === undefined ? {} : { holdCurrentPercent: motorSnapshot.holdCurrentPercent })
      };
      const jointAngle = (motorSnapshot.jointAngle ?? []).find(item => item.axis === mapping.motorLocalAxis);
      if (jointAngle) {
        axis.jointAngle = {
          boardId: motorSnapshot.boardId,
          localAxis: jointAngle.axis,
          posDeg: jointAngle.posDeg,
          encDeg: jointAngle.encDeg,
          potDegRaw: jointAngle.potDegRaw,
          potDegZeroed: jointAngle.potDegZeroed
        };
      }
      const relayed = motorSnapshot.gear.find(item => item.axis === mapping.motorLocalAxis);
      const relayedStatus: GearRelayState = relayed?.state ?? "UNAVAILABLE";
      if (relayed) {
        axis.gearRelayed = {
          boardId: motorSnapshot.boardId,
          angleDeg: relayed.angleDeg,
          status: relayed.state,
          deviationDeg: relayed.deviationDeg ?? null
        };
      } else if (mapping.motorLocalAxis !== undefined) {
        axis.gearRelayed = {
          boardId: motorSnapshot.boardId,
          angleDeg: null,
          status: "UNAVAILABLE",
          deviationDeg: null
        };
      }
      axis.comm = {
        usb: motorSnapshot.state,
        i2c: relayedStatus,
        ble: motorSnapshot.bleStatus ?? "UNKNOWN"
      };
    }
    const bridgeSnapshot = mapping.bridgeBoardId
      ? byId.get(mapping.bridgeBoardId)
      : undefined;
    if (bridgeSnapshot?.kind === "multi_i2c_bridge") {
      const bridge = bridgeSnapshot as BridgeSnapshot;
      const channel = bridge.channels.find(item => item.channel === mapping.bridgeLocalChannel);
      if (channel) {
        axis.gearDirect = {
          boardId: bridgeSnapshot.boardId,
          localChannel: channel.channel,
          angleDeg: channel.degrees === null ? null : normalizeAngle(
            channel.degrees * (mapping.gearDirSign ?? 1) - (mapping.gearAngleOffset ?? 0)
          ),
          ok: channel.ok,
          agc: channel.agc
        };
      }
    }
    if (
      axis.motor?.state === "IDLE"
      && axis.gearRelayed?.status === "OK"
      && axis.gearDirect?.ok === true
      && axis.gearRelayed?.angleDeg !== null
      && axis.gearRelayed?.angleDeg !== undefined
      && axis.gearDirect?.angleDeg !== null
      && axis.gearDirect?.angleDeg !== undefined
    ) {
      const diffDeg = shortestAngleDifference(axis.gearRelayed.angleDeg, axis.gearDirect.angleDeg);
      axis.gearMismatch = { diffDeg, exceeded: Math.abs(diffDeg) > mismatchThresholdDeg };
    }
    return axis;
  });

  const assignedMotors = new Set(settings.axisMapping.flatMap(mapping =>
    mapping.motorBoardId === undefined || mapping.motorLocalAxis === undefined
      ? [] : [`${mapping.motorBoardId}:${mapping.motorLocalAxis}`]
  ));
  const assignedBridges = new Set(settings.axisMapping.flatMap(mapping =>
    mapping.bridgeBoardId === undefined || mapping.bridgeLocalChannel === undefined
      ? [] : [`${mapping.bridgeBoardId}:${mapping.bridgeLocalChannel}`]
  ));
  for (const snapshot of snapshots) {
    if (snapshot.kind !== "stepping_motor_driver" || snapshot.state === "disconnected") continue;
    const motorBoard = snapshot as MotorSnapshot;
    for (const motor of motorBoard.axes) {
      if (axes.length >= 12 || assignedMotors.has(`${snapshot.boardId}:${motor.axis}`)) continue;
      const { errorCode, errorReason } = axisFaultDisplay(motor, motorBoard);
      const relayed = motorBoard.gear.find(item => item.axis === motor.axis);
      axes.push({
        axisId: null,
        axisLabel: `未割当 (${settings.boardLabels[snapshot.boardId] || snapshot.boardId} / Axis ${motor.axis})`,
        motor: {
          boardId: snapshot.boardId,
          localAxis: motor.axis,
          state: motor.state,
          stepPos: motor.pos,
          encoderPos: motor.enc,
          deviation: motor.pos - motor.enc,
          velocity: motor.vel,
          currentMa: motorBoard.power?.current_mA ?? 0,
          voltageV: (motorBoard.power?.voltage_mV ?? 0) / 1000,
          ...(errorCode ? { errorCode, errorReason } : {}),
          ...(motorBoard.holdCurrentPercent === undefined ? {} : { holdCurrentPercent: motorBoard.holdCurrentPercent })
        },
        comm: {
          usb: motorBoard.state,
          i2c: relayed?.state ?? "UNAVAILABLE",
          ble: motorBoard.bleStatus ?? "UNKNOWN"
        }
      });
    }
  }
  for (const snapshot of snapshots) {
    if (snapshot.kind !== "multi_i2c_bridge" || snapshot.state === "disconnected") continue;
    const bridge = snapshot as BridgeSnapshot;
    for (const channel of bridge.channels.filter(item => item.channel <= 2)) {
      if (axes.length >= 12 || assignedBridges.has(`${snapshot.boardId}:${channel.channel}`)) continue;
      axes.push({
        axisId: null,
        axisLabel: `未割当 (${settings.boardLabels[snapshot.boardId] || snapshot.boardId} / CH ${channel.channel})`,
        gearDirect: {
          boardId: snapshot.boardId,
          localChannel: channel.channel,
          angleDeg: channel.degrees,
          ok: channel.ok,
          agc: channel.agc
        }
      });
    }
  }
  return {
    axes,
    boards: snapshots.filter(snapshot => snapshot.boardId !== "unidentified").map(snapshot => ({
      boardId: snapshot.boardId,
      kind: snapshot.kind,
      path: snapshot.path,
      state: snapshot.state,
      label: settings.boardLabels[snapshot.boardId] || snapshot.boardId,
      ...(snapshot.error ? { error: snapshot.error } : {})
    })),
    controlAppConnected,
    timestamp
  };
}

/**
 * A faulted axis carries no per-axis error code from the firmware (EVT FAULT / GET FAULT_INFO
 * report one board-wide reason for the whole axis_mask). The display code below is a UI-only
 * label derived from that reason, not a SteppingMotorDriver Exxx protocol code.
 */
export function axisFaultDisplay(
  motor: MotorAxisStatus,
  motorSnapshot: MotorSnapshot
): { errorCode?: string; errorReason?: string } {
  const reason = motorSnapshot.fault?.reason;
  if (motor.state !== "FAULT" || !reason || reason === "NONE") return {};
  return { errorCode: faultDisplayCode(reason), errorReason: reason };
}

function faultDisplayCode(reason: string): string {
  switch (reason) {
    case "ESTOP": return "ESTOP-1";
    case "OVERCURRENT": return "OC-1";
    case "STALL": return "STALL-1";
    default: return `${reason}-1`;
  }
}

export function shortestAngleDifference(relayedDeg: number, directDeg: number): number {
  const difference = ((relayedDeg - directDeg + 540) % 360) - 180;
  return Object.is(difference, -0) ? 0 : difference;
}

function normalizeAngle(value: number): number {
  return ((value % 360) + 360) % 360;
}

export function bridgeMaintenanceCommand(request: BridgeMaintenanceRequest): string {
  if (!request || typeof request !== "object") throw new Error("Invalid maintenance request");
  switch (request.action) {
    case "fault_clear": return "fault clear";
    case "rescan": return "rescan";
    case "mux_reset": return "mux reset";
    case "reboot": return "reboot";
    case "channel_enable":
      return `ch ${validChannel(request.channel)} enable`;
    case "channel_disable":
      return `ch ${validChannel(request.channel)} disable`;
    case "channel_direction": {
      const channel = validChannel(request.channel);
      if (request.direction !== 0 && request.direction !== 1) throw new Error("Direction must be 0 or 1");
      return `ch ${channel} dir ${request.direction}`;
    }
    case "channel_zero_set":
      return `ch ${validChannel(request.channel)} zero set`;
    case "channel_zero_clear":
      return `ch ${validChannel(request.channel)} zero clear`;
    default:
      throw new Error("Unsupported maintenance command");
  }
}

function validChannel(value: unknown): number {
  const channel = Number(value);
  if (!Number.isInteger(channel) || channel < 0 || channel > 5) {
    throw new Error("Bridge channel must be an integer from 0 to 5");
  }
  return channel;
}

function validLogicalAxis(value: unknown): number {
  const axis = Number(value);
  if (!Number.isInteger(axis) || axis < 1 || axis > 12) {
    throw new Error("Logical axis must be an integer from 1 to 12");
  }
  return axis;
}

function validMotionValue(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${field} must be a safe integer`);
  return number;
}

function validFiniteValue(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field} must be a finite number`);
  return number;
}

function validNonNegativeInt(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) throw new Error(`${field} must be a non-negative integer`);
  return number;
}

function validPositiveFiniteValue(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) throw new Error(`${field} must be a positive finite number`);
  return number;
}

function validPositiveInt(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) throw new Error(`${field} must be a positive integer`);
  return number;
}

const VALID_MICROSTEPS = new Set([1, 2, 4, 8, 16, 32]);

function validMicrostep(value: unknown): number {
  const number = Number(value);
  if (!VALID_MICROSTEPS.has(number)) throw new Error("Microstep must be one of 1, 2, 4, 8, 16, 32");
  return number;
}

const VALID_MOTOR_TYPES = new Set([0, 1]);

function validMotorType(value: unknown): number {
  const number = Number(value);
  if (!VALID_MOTOR_TYPES.has(number)) throw new Error("Motor type must be 0 (CLOSED_LOOP) or 1 (OPEN_LOOP)");
  return number;
}

function validateControlArgs(
  command: ControlCommandRequest["command"],
  args: unknown[] | undefined
): unknown[] | undefined {
  switch (command) {
    case "MOVE":
    case "MOVETO":
    case "VEL":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validMotionValue(args[0], `${command} value`)];
    case "MOVE_DEG":
    case "MOVETO_DEG":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validFiniteValue(args[0], `${command} value`)];
    case "SET_GEAR_RATIO":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validFiniteValue(args[0], `${command} value`)];
    case "SET_STALL_FAULT":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validNonNegativeInt(args[0], `${command} value`)];
    case "SET_CURRENT_LIMIT":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validPositiveFiniteValue(args[0], `${command} value`)];
    case "SET_MICROSTEP":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validMicrostep(args[0])];
    case "SET_MOTOR_TYPE":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validMotorType(args[0])];
    case "SET_VMAX":
    case "SET_ACCEL":
    case "SET_DECEL":
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error(`${command} requires exactly one argument`);
      }
      return [validPositiveInt(args[0], `${command} value`)];
    case "ENABLE":
    case "DISABLE":
    case "STOP":
    case "STOP_FREE":
    case "CLEAR_FAULT":
    case "HOME":
    case "POT_ZERO_SET":
    case "POT_ZERO_CLEAR":
    case "GET_GEAR_RATIO":
    case "GET_MOTOR_TYPE":
    case "GET_STALL_FAULT":
    case "GET_CURRENT_LIMIT":
    case "GET_MICROSTEP":
    case "GET_VMAX":
    case "GET_ACCEL":
    case "GET_DECEL":
    case "SAVE":
    case "RECOVER":
      if (args !== undefined && args.length !== 0) throw new Error(`${command} does not accept arguments`);
      return undefined;
    default:
      throw new Error(`Unsupported control command: ${command}`);
  }
}
