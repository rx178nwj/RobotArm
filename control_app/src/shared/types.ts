export type ControlCommand =
  | "ENABLE"
  | "DISABLE"
  | "STOP"
  | "STOP_FREE"
  | "CLEAR_FAULT"
  | "HOME"
  | "MOVE"
  | "MOVETO"
  | "MOVE_DEG"
  | "MOVETO_DEG"
  | "VEL"
  | "SYNC_MOVE"
  | "POT_ZERO_SET"
  | "POT_ZERO_CLEAR"
  | "SET_GEAR_RATIO"
  | "GET_GEAR_RATIO"
  | "SET_MOTOR_TYPE"
  | "GET_MOTOR_TYPE"
  | "SET_DRIVER_TYPE"
  | "GET_DRIVER_TYPE"
  | "SET_STALL_FAULT"
  | "GET_STALL_FAULT"
  | "SET_CURRENT_LIMIT"
  | "GET_CURRENT_LIMIT"
  | "SET_MICROSTEP"
  | "GET_MICROSTEP"
  | "SET_VMAX"
  | "GET_VMAX"
  | "SET_ACCEL"
  | "GET_ACCEL"
  | "SET_DECEL"
  | "GET_DECEL"
  | "SAVE"
  | "RECOVER";

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

export interface MotorAxisTelemetry {
  axis: number;
  state: string;
  pos: number;
  vel: number;
  enc: number;
}

export interface MotorPowerTelemetry {
  pot: number[];
  current_mA: number;
  voltage_mV: number;
}

export interface MotorFaultTelemetry {
  reason: string;
  axis_mask: number;
  timestamp_us: number;
}

export type GearTelemetryState = "OK" | "DEGRADED" | "UNAVAILABLE";

export interface MotorGearTelemetry {
  axis: number;
  angleDeg: number | null;
  state: GearTelemetryState;
  deviationDeg: number | null;
}

export interface MotorJointAngleTelemetry {
  axis: number;
  posDeg: number | null;
  encDeg: number | null;
  potDegRaw: number | null;
  potDegZeroed: number | null;
}

export interface MotorTelemetrySnapshot {
  boardId: string;
  axes: MotorAxisTelemetry[];
  power?: MotorPowerTelemetry;
  fault?: MotorFaultTelemetry;
  gear: MotorGearTelemetry[];
  jointAngle: MotorJointAngleTelemetry[];
  /** GET BLE_STATUS ("CONNECTED"/"ADVERTISING"/"DISABLED") or "ERROR" when the board reports E016. */
  bleStatus?: string;
  /** GET HOLD_CURRENT_PERCENT — board-wide DRV_EN chopping duty (1-100), shared by all 3 axes. */
  holdCurrentPercent?: number;
}

export interface TelemetryFrame extends MotorTelemetrySnapshot {
  type: "telemetry";
}

/** One 10ms-spaced sample from the firmware's FAULT_TRACE ring buffer (GET FAULT_TRACE <axis>). */
export interface FaultTraceSample {
  state: string;
  stepPos: number;
  encSteps: number;
  diff: number;
  vel: number;
  currentMa: number;
}

/** A FAULT_TRACE capture pulled right after an EVT FAULT for one board/axis. */
export interface FaultTraceCapture {
  boardId: string;
  axis: number;
  intervalMs: number;
  capturedAt: number;
  reason?: string;
  samples: FaultTraceSample[];
}

export interface FaultTraceFrame extends FaultTraceCapture {
  type: "fault_trace";
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
