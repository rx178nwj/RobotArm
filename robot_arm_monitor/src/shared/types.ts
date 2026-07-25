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
}

export interface ConnectResult {
  boardId: string;
}

export interface AxisMappingEntry {
  axisId: number;
  label: string;
  motorBoardId?: string;
  motorLocalAxis?: number;
  bridgeBoardId?: string;
  bridgeLocalChannel?: number;
}

export interface MappingSettings {
  axisMapping: AxisMappingEntry[];
  boardLabels: Record<string, string>;
}
