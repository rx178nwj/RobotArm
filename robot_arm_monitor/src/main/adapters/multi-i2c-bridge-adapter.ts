import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { BridgeSnapshot, BridgeStatus, RawLogEntry } from "../../shared/types";
import type { DeviceAdapter } from "./device-adapter";
import { parseChannel, parseDownstream, parseMaster, parseStatus } from "./parser";

const emptyStatus = (): BridgeStatus => ({
  statusLo: 0, statusHi: 0, fault: 0, chFault: 0, present: 0, enable: 0,
  samples: 0, cmd: 0, uptimeMs: 0, busRecoveries: 0, muxResets: 0, rescans: 0,
  faultNames: "unknown", chFaultNames: "unknown"
});

export class MultiI2cBridgeAdapter extends EventEmitter implements DeviceAdapter {
  readonly kind = "multi_i2c_bridge" as const;
  readonly boardId: string;
  private port?: SerialPort;
  private responseTimer?: NodeJS.Timeout;
  private monitorResponseTimer?: NodeJS.Timeout;
  private masterTimer?: NodeJS.Timeout;
  private initialStatus?: { resolve: () => void; reject: (error: Error) => void };
  private commandResponse?: {
    resolve: (response: string) => void;
    reject: (error: Error) => void;
    timer: NodeJS.Timeout;
  };
  private periodMs = 100;
  private monitorEnabled = false;
  private status = emptyStatus();
  private snapshot: BridgeSnapshot;

  constructor(boardId: string, protocolVersion: string, initialLog: RawLogEntry[] = []) {
    super();
    this.boardId = boardId;
    this.snapshot = {
      kind: this.kind, boardId, protocolVersion, path: "", state: "disconnected",
      lastUpdate: 0, metrics: [], channels: [], rawLog: initialLog.slice(-199)
    };
  }

  async connect(path: string, periodMs: number): Promise<void> {
    this.periodMs = Math.max(100, Math.min(60000, periodMs));
    this.snapshot.path = path;
    this.snapshot.state = "connecting";
    delete this.snapshot.error;
    this.log("system", `Opening ${path} at 115200 baud`);
    this.emitUpdate();

    const port = new SerialPort({ path, baudRate: 115200, autoOpen: false });
    this.port = port;
    port.on("error", error => { if (this.port === port) this.fail(error); });
    port.on("close", () => {
      if (this.port !== port) return;
      const error = new Error(`serial port ${path} closed`);
      this.rejectInitialStatus(error);
      this.rejectCommand(error);
      this.port = undefined;
      this.stopTimers();
      this.snapshot.state = "disconnected";
      this.log("system", `${path} closed`);
      this.emitUpdate();
    });

    try {
      await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
      await new Promise<void>((resolve, reject) => port.set({ dtr: true, rts: true }, error => error ? reject(error) : resolve()));
      const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
      parser.on("data", (line: string) => this.onLine(line.replace(/\r$/, "")));
      await this.requestInitialStatus();
      this.sendCommand("channels");
    } catch (error) {
      if (this.port === port) this.port = undefined;
      this.stopTimers();
      const message = error instanceof Error ? error.message : String(error);
      if (message !== "status response timeout") {
        this.snapshot.state = "error";
        this.snapshot.error = message;
        this.log("system", `Connection failed: ${message}`);
      }
      this.emitUpdate();
      if (port.isOpen) port.close();
      throw error;
    }
  }

  disconnect(): void {
    this.rejectInitialStatus(new Error("Disconnected by user"));
    this.rejectCommand(new Error("Disconnected by user"));
    this.stopTimers();
    const port = this.port;
    this.port = undefined;
    if (port?.isOpen) port.close();
    this.snapshot.state = "disconnected";
    this.log("system", "Disconnected by user");
    this.emitUpdate();
  }

  startMonitor(periodMs = this.periodMs): void {
    this.periodMs = Math.max(100, Math.min(60000, periodMs));
    this.monitorEnabled = true;
    this.sendCommand(`monitor ${this.periodMs}`);
    this.armMonitorTimeout();
    if (this.masterTimer) clearInterval(this.masterTimer);
    this.masterTimer = setInterval(() => {
      try {
        if (this.port?.isOpen) this.sendCommand("master");
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)));
      }
    }, Math.max(3000, this.periodMs * 3));
  }

  stopMonitor(): void {
    this.monitorEnabled = false;
    if (this.monitorResponseTimer) clearTimeout(this.monitorResponseTimer);
    if (this.masterTimer) clearInterval(this.masterTimer);
    this.monitorResponseTimer = undefined;
    this.masterTimer = undefined;
    this.sendCommand("monitor off");
    this.snapshot.state = "connecting";
    this.emitUpdate();
  }

  sendCommand(command: string): void {
    if (!this.port?.isOpen) throw new Error("Serial port is not connected");
    this.log("tx", command);
    this.port.write(`${command}\n`, error => {
      if (error) this.fail(error);
    });
    this.emitUpdate();
  }

  executeCommand(command: string): Promise<string> {
    if (this.commandResponse) return Promise.reject(new Error("Another bridge command is still pending"));
    return new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (!this.commandResponse) return;
        this.commandResponse = undefined;
        reject(new Error(`Command response timeout: ${command}`));
      }, 2000);
      this.commandResponse = { resolve, reject, timer };
      try {
        this.sendCommand(command);
      } catch (error) {
        clearTimeout(timer);
        this.commandResponse = undefined;
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private onLine(line: string): void {
    if (!line) return;
    this.log("rx", line);
    if (this.commandResponse && (line.startsWith("OK") || line.startsWith("ERR"))) {
      const pending = this.commandResponse;
      this.commandResponse = undefined;
      clearTimeout(pending.timer);
      if (line.startsWith("ERR")) pending.reject(new Error(line));
      else pending.resolve(line);
    }
    const status = parseStatus(line);
    if (status) {
      Object.assign(this.status, status);
      this.snapshot.status = { ...this.status };
      this.snapshot.state = "monitoring";
      this.snapshot.lastUpdate = Date.now();
      this.snapshot.metrics = [
        { label: "Samples", value: this.status.samples },
        { label: "Uptime", value: `${this.status.uptimeMs} ms` }
      ];
      delete this.snapshot.error;
      this.completeInitialStatus();
      if (this.monitorEnabled) this.armMonitorTimeout();
    } else {
      const downstream = parseDownstream(line);
      if (downstream) Object.assign(this.status, downstream);
      else if (line.startsWith("FAULTS ")) this.status.faultNames = line.slice(7);
      else if (line.startsWith("CH_FAULTS ")) this.status.chFaultNames = line.slice(10);
      else {
        const channel = parseChannel(line);
        if (channel) {
          this.snapshot.channels = [
            ...this.snapshot.channels.filter(item => item.channel !== channel.channel),
            channel
          ].sort((a, b) => a.channel - b.channel);
        } else {
          const master = parseMaster(line, this.snapshot.master?.lastActivityMs);
          if (master) this.snapshot.master = master;
        }
      }
    }
    this.snapshot.status = { ...this.status };
    this.emitUpdate();
  }

  private fail(error: Error): void {
    this.snapshot.state = "error";
    this.snapshot.error = error.message;
    this.log("system", `Serial error: ${error.message}`);
    this.rejectInitialStatus(error);
    this.rejectCommand(error);
    this.stopTimers();
    this.emitUpdate();
    if (this.port?.isOpen) this.port.close();
  }

  private log(direction: RawLogEntry["direction"], text: string): void {
    this.snapshot.rawLog = [
      ...this.snapshot.rawLog.slice(-199),
      { timestamp: Date.now(), direction, text }
    ];
  }

  private requestInitialStatus(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.initialStatus = { resolve, reject };
      this.responseTimer = setTimeout(() => {
        if (!this.initialStatus) return;
        const error = new Error("status response timeout");
        this.snapshot.state = "timeout";
        this.snapshot.error = error.message;
        this.log("system", error.message);
        this.emitUpdate();
        this.rejectInitialStatus(error);
      }, 1500);
      try {
        this.sendCommand("status");
      } catch (error) {
        this.rejectInitialStatus(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private completeInitialStatus(): void {
    const pending = this.initialStatus;
    this.initialStatus = undefined;
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.responseTimer = undefined;
    pending?.resolve();
  }

  private rejectInitialStatus(error: Error): void {
    const pending = this.initialStatus;
    this.initialStatus = undefined;
    if (this.responseTimer) clearTimeout(this.responseTimer);
    this.responseTimer = undefined;
    pending?.reject(error);
  }

  private rejectCommand(error: Error): void {
    const pending = this.commandResponse;
    this.commandResponse = undefined;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.reject(error);
  }

  private armMonitorTimeout(): void {
    if (this.monitorResponseTimer) clearTimeout(this.monitorResponseTimer);
    this.monitorResponseTimer = setTimeout(() => {
      this.snapshot.state = "timeout";
      this.snapshot.error = "monitor response timeout";
      this.log("system", this.snapshot.error);
      this.emitUpdate();
    }, Math.max(1000, this.periodMs * 3));
  }

  private stopTimers(): void {
    if (this.responseTimer) clearTimeout(this.responseTimer);
    if (this.monitorResponseTimer) clearTimeout(this.monitorResponseTimer);
    if (this.masterTimer) clearInterval(this.masterTimer);
    this.responseTimer = undefined;
    this.monitorResponseTimer = undefined;
    this.masterTimer = undefined;
    this.monitorEnabled = false;
  }

  private emitUpdate(): void {
    this.emit("update", structuredClone(this.snapshot));
  }
}
