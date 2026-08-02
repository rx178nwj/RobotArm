import { EventEmitter } from "node:events";
import { withBindings } from "@stoprocent/noble";
import type { Characteristic, Noble, Peripheral } from "@stoprocent/noble";
import type {
  BleDeviceInfo,
  ConnectionState,
  MotorAxisStatus,
  MotorFaultInfo,
  MotorGearStatus,
  MotorPower,
  MotorSnapshot,
  RawLogEntry
} from "../../shared/types";
import type { DeviceAdapter } from "./device-adapter";

// Assigned by SteppingMotorDriver/firmware/main/ble_telemetry.c.
export const SMD_TELEMETRY_SERVICE_UUID = "7c9e10006a3d4b89a7125f4e8d2c0100";
export const SMD_DEVICE_INFO_UUID = "7c9e10016a3d4b89a7125f4e8d2c0100";
export const SMD_AXIS_STATUS_UUID = "7c9e10026a3d4b89a7125f4e8d2c0100";
export const SMD_POWER_UUID = "7c9e10036a3d4b89a7125f4e8d2c0100";
export const SMD_FAULT_UUID = "7c9e10046a3d4b89a7125f4e8d2c0100";
export const SMD_GEAR_ANGLE_UUID = "7c9e10056a3d4b89a7125f4e8d2c0100";

const noble: Noble = withBindings(process.platform === "win32" ? "win" : "default");
const discovered = new Map<string, Peripheral>();
let scanInProgress = false;

export function stopSteppingMotorBleCentral(): void {
  noble.stop();
}

export async function scanSteppingMotorBleDevices(durationMs = 5000): Promise<BleDeviceInfo[]> {
  if (scanInProgress) throw new Error("BLEスキャンは既に実行中です");
  if (process.platform !== "win32") {
    throw new Error("SteppingMotorDriver BLEスキャンはWindows 10/11のみ対応しています");
  }
  scanInProgress = true;
  const candidates = new Map<string, BleDeviceInfo>();
  const onDiscover = (peripheral: Peripheral): void => {
    const serviceUuids = (peripheral.advertisement.serviceUuids ?? []).map(normalizeUuid);
    const name = peripheral.advertisement.localName ?? "";
    const match = /^SMD-([0-9a-f]{12})$/i.exec(name);
    if (!match || !serviceUuids.includes(SMD_TELEMETRY_SERVICE_UUID)) return;
    discovered.set(peripheral.id, peripheral);
    candidates.set(peripheral.id, {
      path: peripheral.id,
      name,
      boardId: match[1].toUpperCase(),
      address: peripheral.address && peripheral.address !== "unknown" ? peripheral.address : undefined,
      rssi: peripheral.rssi,
      serviceUuids
    });
  };

  noble.on("discover", onDiscover);
  try {
    await noble.waitForPoweredOnAsync(10000);
    /*
     * Do not pass the service UUID to Noble's WinRT scan filter. The firmware
     * puts the UUID in the primary advertising PDU and the complete
     * SMD-<board_id> name in the scan response. Noble's Windows binding filters
     * every PDU independently, so a UUID filter discards that scan response
     * before Noble can merge the complete name into the Peripheral.
     *
     * We still classify strictly by the assigned service UUID in onDiscover
     * after Active Scan has merged both PDUs.
     */
    await noble.startScanningAsync([], true);
    await delay(Math.max(500, Math.min(durationMs, 15000)));
  } catch (error) {
    throw new Error(`BLEスキャンに失敗しました: ${errorMessage(error)}`);
  } finally {
    noble.removeListener("discover", onDiscover);
    try {
      await noble.stopScanningAsync();
    } catch {
      // Preserve the original scan error; a stopped/disabled radio can reject cleanup.
    }
    scanInProgress = false;
  }
  return [...candidates.values()].sort((a, b) => b.rssi - a.rssi);
}

interface DeviceInfoPayload {
  product: string;
  board_id: string;
  protocol_version?: string | number;
  fw_version?: string;
}

export class SteppingMotorBleAdapter extends EventEmitter implements DeviceAdapter {
  readonly kind = "stepping_motor_driver" as const;
  private _boardId = "unidentified";
  private protocolVersion?: string;
  private firmwareVersion?: string;
  private path = "";
  private state: ConnectionState = "disconnected";
  private error?: string;
  private axes: MotorAxisStatus[] = [];
  private power?: MotorPower;
  private fault?: MotorFaultInfo;
  private gear: MotorGearStatus[] = [];
  private readonly rawLog: RawLogEntry[] = [];
  private peripheral?: Peripheral;
  private intentionalDisconnect = false;
  private characteristics: Characteristic[] = [];

  get boardId(): string {
    return this._boardId;
  }

  async connect(path: string, _periodMs: number): Promise<void> {
    if (this.state !== "disconnected") throw new Error("BLEアダプタは既に接続処理中です");
    this.path = path;
    this.state = "connecting";
    this.log("system", `Connecting BLE peripheral ${path}`);
    this.emitUpdate();

    try {
      const peripheral = discovered.get(path) ?? await noble.connectAsync(path);
      this.peripheral = peripheral;
      this.intentionalDisconnect = false;
      peripheral.once("disconnect", reason => this.handleDisconnect(reason));
      if (peripheral.state !== "connected") await peripheral.connectAsync();
      this.log("system", `BLE connected${peripheral.mtu ? ` (MTU ${peripheral.mtu})` : ""}`);

      const uuids = [
        SMD_DEVICE_INFO_UUID,
        SMD_AXIS_STATUS_UUID,
        SMD_POWER_UUID,
        SMD_FAULT_UUID,
        SMD_GEAR_ANGLE_UUID
      ];
      const result = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
        [SMD_TELEMETRY_SERVICE_UUID],
        uuids
      );
      const byUuid = new Map(result.characteristics.map(characteristic => [
        normalizeUuid(characteristic.uuid),
        characteristic
      ]));
      for (const uuid of uuids) {
        if (!byUuid.has(uuid)) throw new Error(`必須GATT characteristicがありません: ${formatUuid(uuid)}`);
      }

      // Device Info is encrypted by the firmware. On Windows, this read uses the
      // OS bond and therefore intentionally delegates Just Works pairing to the
      // standard Bluetooth "Add device" UI.
      const deviceInfo = this.readJson<DeviceInfoPayload>(
        "Device Info",
        await this.readAfterSecurityEstablished(byUuid.get(SMD_DEVICE_INFO_UUID)!)
      );
      if (deviceInfo.product !== "stepping_motor_driver") {
        throw new Error(`Device Info productが不一致です: ${String(deviceInfo.product)}`);
      }
      if (!/^[0-9a-f]{12}$/i.test(deviceInfo.board_id)) {
        throw new Error("Device Info board_idが12桁16進数ではありません");
      }
      this._boardId = deviceInfo.board_id.toUpperCase();
      this.protocolVersion = deviceInfo.protocol_version === undefined
        ? undefined
        : String(deviceInfo.protocol_version);
      this.firmwareVersion = deviceInfo.fw_version;

      await this.readInitialValues(byUuid);
      await this.subscribe(byUuid.get(SMD_AXIS_STATUS_UUID)!, "Axis Status", data => {
        this.axes = parseAxes(this.readJson<unknown>("Axis Status", data));
      });
      await this.subscribe(byUuid.get(SMD_POWER_UUID)!, "Power/ADC", data => {
        this.power = parsePower(this.readJson<unknown>("Power/ADC", data));
      });
      await this.subscribe(byUuid.get(SMD_FAULT_UUID)!, "Fault Info", data => {
        this.fault = parseFault(this.readJson<unknown>("Fault Info", data));
      });
      await this.subscribe(byUuid.get(SMD_GEAR_ANGLE_UUID)!, "Gear Angle", data => {
        this.gear = parseGear(this.readJson<unknown>("Gear Angle", data));
      });
      this.state = "monitoring";
      this.error = undefined;
      this.log("system", `Identity verified: stepping_motor_driver ${this._boardId}`);
      this.emitUpdate();
    } catch (error) {
      const detail = errorMessage(error);
      this.state = "error";
      this.error = pairingHint(detail);
      this.log("system", this.error);
      this.emitUpdate();
      this.intentionalDisconnect = true;
      await this.closePeripheral();
      throw new Error(this.error);
    }
  }

  disconnect(): void {
    this.intentionalDisconnect = true;
    void this.closePeripheral().finally(() => {
      this.state = "disconnected";
      this.error = undefined;
      this.log("system", "BLE disconnected");
      this.emitUpdate();
    });
  }

  sendCommand(_command: string): void {
    throw new Error("SteppingMotorDriver BLE adapter is read-only");
  }

  executeCommand(_command: string): Promise<string> {
    return Promise.reject(new Error("SteppingMotorDriver BLE adapter is read-only"));
  }

  private async readInitialValues(byUuid: Map<string, Characteristic>): Promise<void> {
    this.axes = parseAxes(this.readJson<unknown>(
      "Axis Status",
      await byUuid.get(SMD_AXIS_STATUS_UUID)!.readAsync()
    ));
    this.power = parsePower(this.readJson<unknown>(
      "Power/ADC",
      await byUuid.get(SMD_POWER_UUID)!.readAsync()
    ));
    this.fault = parseFault(this.readJson<unknown>(
      "Fault Info",
      await byUuid.get(SMD_FAULT_UUID)!.readAsync()
    ));
    this.gear = parseGear(this.readJson<unknown>(
      "Gear Angle",
      await byUuid.get(SMD_GEAR_ANGLE_UUID)!.readAsync()
    ));
  }

  private async readAfterSecurityEstablished(characteristic: Characteristic): Promise<Buffer> {
    const deadline = Date.now() + 15000;
    let lastError: unknown;
    let attempts = 0;
    while (Date.now() < deadline) {
      try {
        return await characteristic.readAsync();
      } catch (error) {
        lastError = error;
        if (!isTemporarySecurityError(error) || this.peripheral?.state === "disconnected") throw error;
        attempts++;
        if (attempts === 1) {
          this.log("system", "Waiting for Windows BLE pairing/encryption to complete");
        }
        await delay(500);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async subscribe(
    characteristic: Characteristic,
    label: string,
    apply: (data: Buffer) => void
  ): Promise<void> {
    const listener = (data: Buffer, isNotification: boolean): void => {
      if (!isNotification) return;
      try {
        apply(data);
        this.emitUpdate();
      } catch (error) {
        this.error = `${label} Notifyを解析できません: ${errorMessage(error)}`;
        this.log("system", this.error);
        this.emitUpdate();
      }
    };
    characteristic.on("data", listener);
    this.characteristics.push(characteristic);
    await characteristic.subscribeAsync();
    this.log("system", `${label} Notify subscribed`);
  }

  private readJson<T>(label: string, data: Buffer): T {
    const text = data.toString("utf8");
    this.log("rx", `${label}: ${text}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`${label}が有効なJSONではありません`);
    }
  }

  private handleDisconnect(reason: string): void {
    this.peripheral = undefined;
    this.characteristics = [];
    if (this.intentionalDisconnect) return;
    this.state = "disconnected";
    this.error = reason ? `BLE接続が切断されました: ${reason}` : "BLE接続が切断されました";
    this.log("system", this.error);
    this.emitUpdate();
  }

  private async closePeripheral(): Promise<void> {
    const peripheral = this.peripheral;
    this.peripheral = undefined;
    this.characteristics = [];
    if (peripheral && peripheral.state !== "disconnected") {
      try {
        await peripheral.disconnectAsync();
      } catch {
        // Disconnection is best-effort and must not crash the application.
      }
    }
  }

  private log(direction: RawLogEntry["direction"], text: string): void {
    this.rawLog.push({ timestamp: Date.now(), direction, text });
    if (this.rawLog.length > 500) this.rawLog.shift();
  }

  private emitUpdate(): void {
    const metrics: MotorSnapshot["metrics"] = [
      { label: "Axes", value: this.axes.length },
      { label: "Current", value: this.power ? `${this.power.current_mA} mA` : "—" },
      { label: "Voltage", value: this.power ? `${(this.power.voltage_mV / 1000).toFixed(2)} V` : "—" },
      { label: "Fault", value: this.fault?.reason ?? "—" }
    ];
    this.emit("update", {
      kind: this.kind,
      boardId: this._boardId,
      protocolVersion: this.protocolVersion,
      firmwareVersion: this.firmwareVersion,
      path: this.path,
      state: this.state,
      error: this.error,
      lastUpdate: Date.now(),
      metrics,
      rawLog: [...this.rawLog],
      axes: this.axes.map(axis => ({ ...axis })),
      power: this.power ? { ...this.power, pot: [...this.power.pot] } : undefined,
      fault: this.fault ? { ...this.fault } : undefined,
      gear: this.gear.map(item => ({ ...item }))
    } satisfies MotorSnapshot);
  }
}

function parseGear(value: unknown): MotorGearStatus[] {
  if (isRecord(value) && value.state === "UNAVAILABLE") return [];
  if (!Array.isArray(value)) throw new Error("Gear Angleは配列ではありません");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Gear Angle[${index}]がオブジェクトではありません`);
    const state = String(item.state ?? "UNAVAILABLE");
    if (state !== "OK" && state !== "DEGRADED" && state !== "UNAVAILABLE") {
      throw new Error(`Gear Angle[${index}]のstateが不正です`);
    }
    return {
      axis: finiteNumber(item.axis, "axis"),
      angleDeg: state === "UNAVAILABLE" ? null : finiteNumber(item.angle_deg, "angle_deg"),
      state,
      deviationDeg: item.deviation_deg === undefined ? null : finiteNumber(item.deviation_deg, "deviation_deg")
    };
  });
}

function parseAxes(value: unknown): MotorAxisStatus[] {
  if (!Array.isArray(value)) throw new Error("Axis Statusは配列ではありません");
  return value.map((item, index) => {
    if (!isRecord(item)) throw new Error(`Axis Status[${index}]がオブジェクトではありません`);
    return {
      axis: finiteNumber(item.axis, "axis"),
      state: String(item.state ?? ""),
      pos: finiteNumber(item.pos, "pos"),
      vel: finiteNumber(item.vel, "vel"),
      enc: finiteNumber(item.enc, "enc")
    };
  });
}

function parsePower(value: unknown): MotorPower {
  if (!isRecord(value) || !Array.isArray(value.pot)) throw new Error("Power/ADC形式が不正です");
  return {
    pot: value.pot.map(item => finiteNumber(item, "pot")),
    current_mA: finiteNumber(value.current_mA, "current_mA"),
    voltage_mV: finiteNumber(value.voltage_mV, "voltage_mV")
  };
}

function parseFault(value: unknown): MotorFaultInfo {
  if (!isRecord(value)) throw new Error("Fault Info形式が不正です");
  return {
    reason: String(value.reason ?? ""),
    axis_mask: finiteNumber(value.axis_mask, "axis_mask"),
    timestamp_us: finiteNumber(value.timestamp_us, "timestamp_us")
  };
}

function finiteNumber(value: unknown, field: string): number {
  const number = Number(value);
  if (!Number.isFinite(number)) throw new Error(`${field}が数値ではありません`);
  return number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeUuid(uuid: string): string {
  return uuid.replace(/-/g, "").toLowerCase();
}

function formatUuid(uuid: string): string {
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pairingHint(message: string): string {
  if (/protocol error/i.test(message)) {
    return `${message}。暗号化GATT読み取りが拒否されました。SMD基板のファームウェアが最新版か確認し、再発する場合はWindowsのSMDデバイス登録を削除してペアリングし直してください`;
  }
  if (/access|denied|encrypt|unreachable|security|auth/i.test(message)) {
    return `${message}。Windowsの「Bluetoothとデバイス > デバイスの追加」でSMD基板をペアリングしてから再接続してください`;
  }
  return message;
}

function isTemporarySecurityError(error: unknown): boolean {
  return /access|denied|encrypt|unreachable|security|auth|protocol error/i.test(errorMessage(error));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}
