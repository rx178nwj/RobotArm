import { promises as fs } from "node:fs";
import path from "node:path";
import { BrowserWindow, dialog } from "electron";
import type {
  BridgeLoggingState,
  BridgeSnapshot,
  CsvExportResult,
  DeviceSnapshot
} from "../shared/types";

const BRIDGE_HEADER = [
  "timestamp",
  "board_id",
  "channel",
  "present",
  "enable",
  "ok",
  "angle",
  "degree",
  "agc",
  "read_ok",
  "read_err",
  "fault",
  "ch_fault",
  "last_activity_ms"
];

const RAW_LOG_HEADER = ["timestamp", "board_id", "direction", "text"];

export class CsvLogger {
  private state: BridgeLoggingState = { active: false, periodMs: 1000 };
  private writeQueue: Promise<void> = Promise.resolve();

  getState(): BridgeLoggingState {
    return { ...this.state };
  }

  async startBridgeLog(
    owner: BrowserWindow,
    periodMs = 1000
  ): Promise<BridgeLoggingState> {
    if (this.state.active) throw new Error("Bridge logging is already active");
    const startedAt = Date.now();
    const result = await dialog.showSaveDialog(owner, {
      title: "Bridge CSVログの保存先",
      defaultPath: path.resolve(process.cwd(), `bridge_log_${fileTimestamp(startedAt)}.csv`),
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"]
    });
    if (result.canceled || !result.filePath) {
      this.state = { active: false, periodMs, canceled: true };
      return this.getState();
    }
    await fs.writeFile(result.filePath, `${csvRow(BRIDGE_HEADER)}\r\n`, "utf8");
    this.writeQueue = Promise.resolve();
    this.state = {
      active: true,
      periodMs,
      filePath: result.filePath,
      startedAt
    };
    return this.getState();
  }

  appendBridgeSnapshot(snapshot: BridgeSnapshot): Promise<void> {
    if (!this.state.active || !this.state.filePath) return Promise.resolve();
    const filePath = this.state.filePath;
    const timestamp = new Date().toISOString();
    const channels = new Map(snapshot.channels.map(channel => [channel.channel, channel]));
    const rows = Array.from({ length: 6 }, (_, channelNumber) => {
      const channel = channels.get(channelNumber);
      return csvRow([
        timestamp,
        snapshot.boardId,
        channelNumber,
        channel ? numberBoolean(channel.present) : "",
        channel ? numberBoolean(channel.enable) : "",
        channel ? numberBoolean(channel.ok) : "",
        channel?.angle ?? "",
        channel?.degrees ?? "",
        channel?.agc ?? "",
        channel?.readOk ?? "",
        channel?.readErr ?? "",
        snapshot.status?.fault ?? "",
        snapshot.status?.chFault ?? "",
        snapshot.master?.lastActivityMs ?? ""
      ]);
    }).join("\r\n") + "\r\n";

    this.writeQueue = this.writeQueue.then(() => fs.appendFile(filePath, rows, "utf8"));
    return this.writeQueue.catch(error => {
      this.state = {
        ...this.state,
        active: false,
        error: error instanceof Error ? error.message : String(error)
      };
      throw error;
    });
  }

  async stopBridgeLog(): Promise<BridgeLoggingState> {
    this.state = { ...this.state, active: false };
    try {
      await this.writeQueue;
    } catch {
      // appendBridgeSnapshot has already copied the write error into state.
    }
    return this.getState();
  }

  async exportRawLogs(
    owner: BrowserWindow,
    snapshots: DeviceSnapshot[]
  ): Promise<CsvExportResult> {
    const now = Date.now();
    const result = await dialog.showSaveDialog(owner, {
      title: "送受信ログのCSVエクスポート",
      defaultPath: path.resolve(process.cwd(), `bridge_raw_log_${fileTimestamp(now)}.csv`),
      filters: [{ name: "CSV", extensions: ["csv"] }],
      properties: ["createDirectory", "showOverwriteConfirmation"]
    });
    if (result.canceled || !result.filePath) return { canceled: true };
    const rows = snapshots
      .flatMap(snapshot => snapshot.rawLog.map(entry => ({
        boardId: snapshot.boardId,
        ...entry
      })))
      .sort((a, b) => a.timestamp - b.timestamp)
      .map(entry => csvRow([
        new Date(entry.timestamp).toISOString(),
        entry.boardId,
        entry.direction,
        entry.text
      ]));
    const content = [csvRow(RAW_LOG_HEADER), ...rows].join("\r\n") + "\r\n";
    await fs.writeFile(result.filePath, content, "utf8");
    return { canceled: false, filePath: result.filePath };
  }
}

export function csvRow(values: readonly unknown[]): string {
  return values.map(value => {
    const text = String(value ?? "");
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, "\"\"")}"` : text;
  }).join(",");
}

function numberBoolean(value: boolean): number {
  return value ? 1 : 0;
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
