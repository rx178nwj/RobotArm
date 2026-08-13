import { promises as fs } from "node:fs";
import path from "node:path";
import { csvRow } from "./csv-logger";
import type {
  BridgeSnapshot,
  CommandResult,
  ControlCommandRequest,
  ControlEvent,
  DeviceSnapshot,
  MotorSnapshot
} from "../shared/types";

const HEADER = ["timestamp", "source", "boardId", "axis", "detail"];

/**
 * Appends only error/fault events (command failures, firmware FAULT transitions,
 * bridge channel faults, control-app EVT frames) to a CSV file created at startup.
 * Unlike the raw-log export, this survives across the whole session so an error
 * that happens once can be reviewed later without needing to catch it live.
 */
export class ErrorLogger {
  private readonly filePath: string;
  private writeQueue: Promise<void>;
  private readonly lastMotorFault = new Map<string, string>();
  private readonly lastBridgeFault = new Map<string, string>();

  constructor(baseDir = process.cwd()) {
    this.filePath = path.resolve(baseDir, `error_log_${fileTimestamp(Date.now())}.csv`);
    this.writeQueue = fs.writeFile(this.filePath, `${csvRow(HEADER)}\r\n`, "utf8").catch(() => {});
  }

  getFilePath(): string {
    return this.filePath;
  }

  logCommandResult(
    request: ControlCommandRequest,
    boardId: string,
    axis: number,
    result: CommandResult
  ): void {
    if (result.ok) return;
    this.append(
      "control",
      boardId,
      axis,
      `${request.command} args=${JSON.stringify(request.args ?? [])} -> ERR ${result.error ?? "UNKNOWN"}${result.message ? ` ${result.message}` : ""}`
    );
  }

  logCommandException(request: ControlCommandRequest, error: unknown): void {
    this.append(
      "control",
      "-",
      request.logicalAxis,
      `${request.command} -> EXCEPTION ${error instanceof Error ? error.message : String(error)}`
    );
  }

  logControlEvent(event: ControlEvent): void {
    this.append("event", event.boardId, event.axis ?? "", event.event);
  }

  observeSnapshot(snapshot: DeviceSnapshot): void {
    if (snapshot.kind === "multi_i2c_bridge") {
      this.observeBridgeSnapshot(snapshot as BridgeSnapshot);
    } else if (snapshot.kind === "stepping_motor_driver") {
      this.observeMotorSnapshot(snapshot as MotorSnapshot);
    }
  }

  private observeMotorSnapshot(snapshot: MotorSnapshot): void {
    const fault = snapshot.fault;
    if (!fault || fault.reason === "NONE") {
      this.lastMotorFault.delete(snapshot.boardId);
      return;
    }
    const key = `${fault.reason}:${fault.timestamp_us}`;
    if (this.lastMotorFault.get(snapshot.boardId) === key) return;
    this.lastMotorFault.set(snapshot.boardId, key);
    this.append(
      "motor_fault",
      snapshot.boardId,
      "",
      `reason=${fault.reason} axis_mask=0x${fault.axis_mask.toString(16)}`
    );
  }

  private observeBridgeSnapshot(snapshot: BridgeSnapshot): void {
    const status = snapshot.status;
    if (!status) return;
    if (status.fault === 0 && status.chFault === 0) {
      this.lastBridgeFault.delete(snapshot.boardId);
      return;
    }
    const key = `${status.fault}:${status.chFault}`;
    if (this.lastBridgeFault.get(snapshot.boardId) === key) return;
    this.lastBridgeFault.set(snapshot.boardId, key);
    this.append(
      "bridge_fault",
      snapshot.boardId,
      "",
      `fault=0x${status.fault.toString(16)}(${status.faultNames}) ch_fault=0x${status.chFault.toString(16)}(${status.chFaultNames})`
    );
  }

  private append(source: string, boardId: string, axis: number | string, detail: string): void {
    const row = csvRow([new Date().toISOString(), source, boardId, axis, detail]);
    this.writeQueue = this.writeQueue
      .then(() => fs.appendFile(this.filePath, `${row}\r\n`, "utf8"))
      .catch(() => {
        // Best-effort logging; a write failure should not disrupt device operation.
      });
  }
}

function fileTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join("");
}
