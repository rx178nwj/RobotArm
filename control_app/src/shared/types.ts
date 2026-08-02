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

export interface EstopBoardResult extends CommandResult {
  boardId: string;
}

export interface EstopResult {
  results: EstopBoardResult[];
}

export interface ControlEvent {
  boardId: string;
  event: string;
  axis?: number;
}

export interface BoardEvent {
  event: string;
  axis?: number;
  data: string[];
}

export interface PortInfo {
  path: string;
  manufacturer?: string;
  serialNumber?: string;
  vendorId?: string;
  productId?: string;
}

export interface BoardStatus {
  boardId: string;
  path: string;
  state: "connected" | "disconnected" | "error";
  error?: string;
}

export interface AppLogEntry {
  timestamp: number;
  source: "ipc" | "board" | "system";
  message: string;
}

export interface AppSnapshot {
  ipcClientConnected: boolean;
  boards: BoardStatus[];
  logs: AppLogEntry[];
}

export interface CommandRequestFrame {
  id: number;
  type: "command";
  boardId: string;
  axis: number;
  command: ControlCommand;
  args?: unknown[];
}

export interface EstopRequestFrame {
  id: number;
  type: "estop";
}

export interface ResultFrame extends CommandResult {
  id: number;
  type: "result";
}

export interface EstopResultFrame extends EstopResult {
  id: number;
  type: "estop_result";
}

export interface EventFrame extends ControlEvent {
  type: "event";
}

export interface ConnectionChangedFrame {
  type: "connection_changed";
  boards: BoardStatus[];
}
