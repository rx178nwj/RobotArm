export type DeviceKind = "stepping_motor_driver" | "multi_i2c_bridge";
export type ConnectionState = "disconnected" | "connecting" | "monitoring" | "timeout" | "error";
export type LogDirection = "tx" | "rx" | "system";

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName: string;
  candidate: boolean;
  kindHint?: DeviceKind;
}

export interface BleDeviceInfo {
  /** Noble/WinRT peripheral identifier used by connect(). */
  path: string;
  name: string;
  boardId: string;
  address?: string;
  rssi: number;
  serviceUuids: string[];
}

export interface MotorAxisStatus {
  axis: number;
  state: string;
  pos: number;
  vel: number;
  enc: number;
}

export interface MotorPower {
  pot: number[];
  current_mA: number;
  voltage_mV: number;
}

export interface MotorFaultInfo {
  reason: string;
  axis_mask: number;
  timestamp_us: number;
}

export type GearRelayState = "OK" | "DEGRADED" | "UNAVAILABLE";

export interface MotorGearStatus {
  axis: number;
  angleDeg: number | null;
  state: GearRelayState;
  deviationDeg?: number | null;
}

export interface BridgeStatus {
  statusLo: number;
  statusHi: number;
  fault: number;
  chFault: number;
  present: number;
  enable: number;
  samples: number;
  cmd: number;
  uptimeMs: number;
  busRecoveries: number;
  muxResets: number;
  rescans: number;
  faultNames: string;
  chFaultNames: string;
}

export interface ChannelData {
  channel: number;
  present: boolean;
  enable: boolean;
  ok: boolean;
  dirConfig: boolean;
  dirOutput: boolean;
  angle: number | null;
  degrees: number | null;
  agc: number;
  magnetRaw: number;
  md: boolean;
  ml: boolean;
  mh: boolean;
  readOk: number;
  readErr: number;
  lastOkMs: number;
  lastErrMs: number;
}

export interface MasterStats {
  writeTx: number;
  writeBytes: number;
  readReq: number;
  readBytes: number;
  lastActivityMs: number;
  logSeq: number;
  active: boolean;
}

export interface BridgeConfig {
  angleSrc: string;
  pollPeriodMs: number;
  statusDecim: number;
  as5600Conf: number;
  chEnable: number;
  dirConfig: number;
  dirApplied: number;
}

export interface RawLogEntry {
  timestamp: number;
  direction: LogDirection;
  text: string;
}

export interface SnapshotMetric {
  label: string;
  value: string | number;
}

export interface DeviceSnapshot {
  kind: DeviceKind;
  boardId: string;
  protocolVersion?: string;
  path: string;
  state: ConnectionState;
  error?: string;
  lastUpdate: number;
  metrics: SnapshotMetric[];
  rawLog: RawLogEntry[];
}

export interface BridgeSnapshot extends DeviceSnapshot {
  kind: "multi_i2c_bridge";
  status?: BridgeStatus;
  channels: ChannelData[];
  master?: MasterStats;
  config?: BridgeConfig;
}

export interface MotorSnapshot extends DeviceSnapshot {
  kind: "stepping_motor_driver";
  firmwareVersion?: string;
  axes: MotorAxisStatus[];
  power?: MotorPower;
  fault?: MotorFaultInfo;
  gear: MotorGearStatus[];
}

export interface AxisSnapshot {
  axisId: number | null;
  axisLabel: string;
  motor?: {
    boardId: string;
    localAxis: number;
    state: string;
    stepPos: number;
    encoderPos: number;
    deviation: number;
    velocity: number;
    currentMa: number;
    voltageV: number;
  };
  gearRelayed?: {
    boardId: string;
    angleDeg: number | null;
    status: GearRelayState;
    deviationDeg: number | null;
  };
  gearDirect?: {
    boardId: string;
    localChannel: number;
    angleDeg: number | null;
    ok: boolean;
    agc: number;
  };
  gearMismatch?: {
    diffDeg: number;
    exceeded: boolean;
  };
}

export interface BoardConnectionState {
  boardId: string;
  kind: DeviceKind;
  path: string;
  state: ConnectionState;
  label: string;
  error?: string;
}

export interface RobotArmSnapshot {
  axes: AxisSnapshot[];
  boards: BoardConnectionState[];
  controlAppConnected: boolean;
  timestamp: number;
}

export interface ConnectResult {
  boardId: string;
}

export type BridgeMaintenanceAction =
  | "fault_clear"
  | "rescan"
  | "channel_enable"
  | "channel_disable"
  | "channel_direction"
  | "channel_zero_set"
  | "channel_zero_clear"
  | "mux_reset"
  | "reboot";

export interface BridgeMaintenanceRequest {
  action: BridgeMaintenanceAction;
  channel?: number;
  direction?: 0 | 1;
}

export interface BridgeMaintenanceResult {
  boardId: string;
  command: string;
  response: string;
}

export interface BridgeConfigRefreshResult {
  boardId: string;
  config?: BridgeConfig;
  error?: string;
}

export interface BridgeLoggingState {
  active: boolean;
  periodMs: number;
  filePath?: string;
  startedAt?: number;
  error?: string;
  canceled?: boolean;
}

export interface CsvExportResult {
  canceled: boolean;
  filePath?: string;
}

export interface AxisMappingEntry {
  axisId: number;
  label: string;
  motorBoardId?: string;
  motorLocalAxis?: number;
  bridgeBoardId?: string;
  bridgeLocalChannel?: number;
  /** SteppingMotorDriver gear_dir_sign used to correct the bridge-direct angle. */
  gearDirSign?: -1 | 1;
  /** SteppingMotorDriver gear_angle_offset (degrees) used for direct-value comparison. */
  gearAngleOffset?: number;
}

export interface MappingSettings {
  axisMapping: AxisMappingEntry[];
  boardLabels: Record<string, string>;
}

export type ControlCommand =
  | "ENABLE"
  | "DISABLE"
  | "STOP"
  | "STOP_FREE"
  | "CLEAR_FAULT"
  | "HOME"
  | "MOVE"
  | "MOVETO"
  | "VEL"
  | "SYNC_MOVE";

export interface CommandResult {
  ok: boolean;
  error?: string;
  message?: string;
}

export interface EstopBoardResult {
  boardId: string;
  ok: boolean;
  error?: string;
  message?: string;
}

export interface EstopResult {
  results: EstopBoardResult[];
}

export interface ControlCommandRequest {
  logicalAxis: number;
  command: Exclude<ControlCommand, "SYNC_MOVE">;
  args?: unknown[];
}

export interface SyncMoveAxisRequest {
  logicalAxis: number;
  steps: number;
}

export interface ControlEvent {
  boardId: string;
  event: string;
  axis?: number;
}
