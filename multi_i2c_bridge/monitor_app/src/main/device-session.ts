import { EventEmitter } from "node:events";
import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { BridgeStatus, DeviceSnapshot, PortInfo } from "../shared/types";
import { parseChannel, parseDownstream, parseMaster, parseStatus } from "./parser";

const emptyStatus = (): BridgeStatus => ({
  statusLo: 0, statusHi: 0, fault: 0, chFault: 0, present: 0, enable: 0,
  samples: 0, cmd: 0, uptimeMs: 0, busRecoveries: 0, muxResets: 0, rescans: 0,
  faultNames: "unknown", chFaultNames: "unknown"
});

export class DeviceSession extends EventEmitter {
  readonly id: string;
  private port?: SerialPort;
  private periodMs = 1000;
  private timeout?: NodeJS.Timeout;
  private masterTimer?: NodeJS.Timeout;
  private status = emptyStatus();
  private snapshot: DeviceSnapshot;

  constructor(private info: PortInfo) {
    super();
    this.id = info.serialNumber || info.path;
    this.snapshot = { id: this.id, path: info.path, serialNumber: info.serialNumber || "unknown", state: "disconnected", lastUpdate: 0, channels: [], rawLines: [] };
  }

  async connect(periodMs: number): Promise<void> {
    this.periodMs = periodMs;
    this.snapshot.state = "connecting";
    this.emitUpdate();
    this.port = new SerialPort({ path: this.info.path, baudRate: 115200, autoOpen: false });
    this.port.on("error", error => this.fail(error));
    this.port.on("close", () => { this.snapshot.state = "disconnected"; this.stopTimers(); this.emitUpdate(); });
    await new Promise<void>((resolve, reject) => this.port!.open(error => error ? reject(error) : resolve()));
    await new Promise<void>(resolve => this.port!.set({ dtr: true, rts: true }, () => resolve()));
    const parser = this.port.pipe(new ReadlineParser({ delimiter: "\n" }));
    parser.on("data", (line: string) => this.onLine(line.replace(/\r$/, "")));
    this.write("status");
    setTimeout(() => this.startMonitor(), 250);
  }

  startMonitor(periodMs = this.periodMs): void {
    this.periodMs = Math.max(100, Math.min(60000, periodMs));
    this.write(`monitor ${this.periodMs}`);
    this.armTimeout();
    if (this.masterTimer) clearInterval(this.masterTimer);
    this.masterTimer = setInterval(() => this.write("master"), Math.max(3000, this.periodMs * 3));
  }

  stopMonitor(): void { this.write("monitor off"); this.snapshot.state = "connecting"; this.emitUpdate(); }

  disconnect(): void {
    this.stopTimers();
    if (this.port?.isOpen) this.port.close();
  }

  private write(command: string): void {
    if (this.port?.isOpen) this.port.write(`${command}\n`);
  }

  private onLine(line: string): void {
    if (!line) return;
    this.snapshot.rawLines = [...this.snapshot.rawLines.slice(-39), line];
    const status = parseStatus(line);
    if (status) {
      Object.assign(this.status, status);
      this.snapshot.status = { ...this.status };
      this.snapshot.state = "monitoring";
      this.snapshot.lastUpdate = Date.now();
      this.armTimeout();
    } else {
      const downstream = parseDownstream(line);
      if (downstream) Object.assign(this.status, downstream);
      else if (line.startsWith("FAULTS ")) this.status.faultNames = line.slice(7);
      else if (line.startsWith("CH_FAULTS ")) this.status.chFaultNames = line.slice(10);
      else {
        const channel = parseChannel(line);
        if (channel) {
          const channels = this.snapshot.channels.filter(item => item.channel !== channel.channel);
          channels.push(channel);
          this.snapshot.channels = channels.sort((a, b) => a.channel - b.channel);
        } else {
          const master = parseMaster(line, this.snapshot.master?.lastActivityMs);
          if (master) this.snapshot.master = master;
        }
      }
    }
    this.snapshot.status = { ...this.status };
    this.emitUpdate();
  }

  private armTimeout(): void {
    if (this.timeout) clearTimeout(this.timeout);
    this.timeout = setTimeout(() => { this.snapshot.state = "timeout"; this.snapshot.error = "monitor response timeout"; this.emitUpdate(); }, Math.max(1000, this.periodMs * 3));
  }

  private fail(error: Error): void {
    this.snapshot.state = "error";
    this.snapshot.error = process.platform === "linux" && /permission/i.test(error.message)
      ? `${error.message}. Add the user to the dialout group.` : error.message;
    this.stopTimers();
    this.emitUpdate();
  }

  private stopTimers(): void {
    if (this.timeout) clearTimeout(this.timeout);
    if (this.masterTimer) clearInterval(this.masterTimer);
  }

  private emitUpdate(): void { this.emit("update", structuredClone(this.snapshot)); }
}
