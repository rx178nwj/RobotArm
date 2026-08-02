import { SerialPort } from "serialport";
import type {
  BleDeviceInfo,
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
  MotorSnapshot,
  RobotArmSnapshot,
  PortInfo,
  RawLogEntry,
  SyncMoveAxisRequest
} from "../shared/types";
import type { AxisMappingStore } from "./axis-mapping";
import type { ControlAppClient } from "./adapters/control-app-client";
import { MultiI2cBridgeAdapter } from "./adapters/multi-i2c-bridge-adapter";
import type { DeviceAdapter } from "./adapters/device-adapter";
import { VID_HINT } from "./adapters/device-adapter";
import { identifyPort, makeProbeLog } from "./adapters/port-identity";
import {
  scanSteppingMotorBleDevices,
  SteppingMotorBleAdapter,
  stopSteppingMotorBleCentral
} from "./adapters/stepping-motor-ble-adapter";

export class DeviceManager {
  private readonly adapters = new Map<string, DeviceAdapter>();
  private readonly boardByPath = new Map<string, string>();
  private readonly connectingPaths = new Set<string>();
  private readonly latestSnapshots = new Map<string, DeviceSnapshot>();
  private loggingPeriodMs?: number;
  private loggingSnapshot?: (snapshot: BridgeSnapshot) => void;
  private loggingError?: (message: string) => void;
  private readonly loggingErrorBoards = new Set<string>();

  constructor(
    private readonly onUpdate: (snapshot: DeviceSnapshot) => void,
    private readonly controlClient: ControlAppClient,
    private readonly mappingStore: AxisMappingStore,
    private readonly onRobotArmUpdate?: (snapshot: RobotArmSnapshot) => void
  ) {}

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

  async scanBleDevices(durationMs = 5000): Promise<BleDeviceInfo[]> {
    return scanSteppingMotorBleDevices(durationMs);
  }

  async connectBle(info: BleDeviceInfo, periodMs = 100): Promise<ConnectResult> {
    if (this.boardByPath.has(info.path) || this.connectingPaths.has(info.path)) {
      throw new Error(`${info.name} is already connected or connecting`);
    }
    this.connectingPaths.add(info.path);
    const adapter = new SteppingMotorBleAdapter();
    adapter.on("update", snapshot => {
      if (snapshot.boardId !== "unidentified") this.latestSnapshots.set(snapshot.boardId, snapshot);
      if (snapshot.state === "disconnected" && snapshot.boardId !== "unidentified") {
        this.boardByPath.delete(snapshot.path);
        if (this.adapters.get(snapshot.boardId) === adapter) this.adapters.delete(snapshot.boardId);
      }
      this.onUpdate(snapshot);
      this.publishRobotArmSnapshot();
    });

    try {
      await adapter.connect(info.path, periodMs);
      if (adapter.boardId !== info.boardId) {
        throw new Error(
          `Advertising名のboard_id (${info.boardId}) とDevice Info (${adapter.boardId}) が一致しません`
        );
      }
      if (this.adapters.has(adapter.boardId)) {
        throw new Error(`Board ${adapter.boardId} is already connected`);
      }
      this.adapters.set(adapter.boardId, adapter);
      this.boardByPath.set(info.path, adapter.boardId);
      return { boardId: adapter.boardId };
    } catch (error) {
      adapter.removeAllListeners("update");
      if (adapter.boardId !== "unidentified") this.latestSnapshots.delete(adapter.boardId);
      adapter.disconnect();
      throw error;
    } finally {
      this.connectingPaths.delete(info.path);
    }
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
    stopSteppingMotorBleCentral();
    const close = (this.controlClient as ControlAppClient & { close?: () => void }).close;
    close?.call(this.controlClient);
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
      axis.motor = {
        boardId: motorSnapshot.boardId,
        localAxis: motor.axis,
        state: motor.state,
        stepPos: motor.pos,
        encoderPos: motor.enc,
        deviation: motor.pos - motor.enc,
        velocity: motor.vel,
        currentMa: motorSnapshot.power?.current_mA ?? 0,
        voltageV: (motorSnapshot.power?.voltage_mV ?? 0) / 1000
      };
      const relayed = motorSnapshot.gear.find(item => item.axis === mapping.motorLocalAxis);
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
          voltageV: (motorBoard.power?.voltage_mV ?? 0) / 1000
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
    case "ENABLE":
    case "DISABLE":
    case "STOP":
    case "STOP_FREE":
    case "CLEAR_FAULT":
    case "HOME":
      if (args !== undefined && args.length !== 0) throw new Error(`${command} does not accept arguments`);
      return undefined;
    default:
      throw new Error(`Unsupported control command: ${command}`);
  }
}
