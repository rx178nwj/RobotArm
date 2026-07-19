export type SerialState = "disconnected" | "connecting" | "monitoring" | "timeout" | "error";

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
  friendlyName?: string;
  candidate: boolean;
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

export interface DeviceSnapshot {
  id: string;
  path: string;
  serialNumber: string;
  state: SerialState;
  error?: string;
  lastUpdate: number;
  status?: BridgeStatus;
  channels: ChannelData[];
  master?: MasterStats;
  rawLines: string[];
}

export interface AppSettings {
  periodMs: number;
  historySeconds: number;
  layout: "single" | "grid";
  labels: Record<string, string>;
}
