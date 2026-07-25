import { SerialPort } from "serialport";
import type {
  BridgeMaintenanceRequest,
  BridgeMaintenanceResult,
  ConnectResult,
  DeviceSnapshot,
  PortInfo,
  RawLogEntry
} from "../shared/types";
import { MultiI2cBridgeAdapter } from "./adapters/multi-i2c-bridge-adapter";
import type { DeviceAdapter } from "./adapters/device-adapter";
import { VID_HINT } from "./adapters/device-adapter";
import { identifyPort, makeProbeLog } from "./adapters/port-identity";

export class DeviceManager {
  private readonly adapters = new Map<string, DeviceAdapter>();
  private readonly boardByPath = new Map<string, string>();
  private readonly connectingPaths = new Set<string>();

  constructor(private readonly onUpdate: (snapshot: DeviceSnapshot) => void) {}

  async listPorts(): Promise<PortInfo[]> {
    return (await SerialPort.list()).map(port => {
      const vendorId = port.vendorId?.toLowerCase();
      const kindHint = vendorId ? VID_HINT[vendorId] : undefined;
      return {
        path: port.path,
        manufacturer: port.manufacturer,
        serialNumber: port.serialNumber,
        vendorId: port.vendorId,
        productId: port.productId,
        friendlyName: [port.manufacturer, port.path].filter(Boolean).join(" · ") || port.path,
        candidate: kindHint === "multi_i2c_bridge",
        kindHint
      };
    });
  }

  async connect(info: PortInfo, periodMs = 100): Promise<ConnectResult> {
    if (this.boardByPath.has(info.path) || this.connectingPaths.has(info.path)) {
      throw new Error(`${info.path} is already connected or connecting`);
    }
    this.connectingPaths.add(info.path);

    const probe = makeProbeLog();
    let identity;
    try {
      identity = await identifyPort(info, 1500, probe.logger);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const rawLog: RawLogEntry[] = [
        ...probe.entries,
        { timestamp: Date.now(), direction: "system", text: `Identity verification failed: ${message}` }
      ];
      this.onUpdate({
        kind: "multi_i2c_bridge",
        boardId: "unidentified",
        path: info.path,
        state: "disconnected",
        error: message,
        lastUpdate: Date.now(),
        metrics: [],
        rawLog
      });
      this.connectingPaths.delete(info.path);
      throw error;
    }
    try {
      if (this.adapters.has(identity.id)) {
        throw new Error(`Board ${identity.id} is already connected`);
      }
      const adapter = new MultiI2cBridgeAdapter(identity.id, String(identity.protocol), probe.entries);
      adapter.on("update", snapshot => {
        if (snapshot.state === "disconnected") {
          this.boardByPath.delete(snapshot.path);
          if (this.adapters.get(snapshot.boardId) === adapter) this.adapters.delete(snapshot.boardId);
        }
        this.onUpdate(snapshot);
      });
      this.adapters.set(identity.id, adapter);
      await adapter.connect(info.path, periodMs);
      this.boardByPath.set(info.path, identity.id);
    } catch (error) {
      this.adapters.delete(identity.id);
      throw error;
    } finally {
      this.connectingPaths.delete(info.path);
    }
    return { boardId: identity.id };
  }

  disconnect(boardId: string): void {
    const adapter = this.adapters.get(boardId);
    adapter?.disconnect();
    this.adapters.delete(boardId);
    for (const [path, connectedBoardId] of this.boardByPath) {
      if (connectedBoardId === boardId) this.boardByPath.delete(path);
    }
  }

  async executeBridgeMaintenance(
    boardId: string,
    request: BridgeMaintenanceRequest
  ): Promise<BridgeMaintenanceResult> {
    const adapter = this.adapters.get(boardId);
    if (!adapter) throw new Error(`Board ${boardId} is not connected`);
    if (adapter.kind !== "multi_i2c_bridge") throw new Error("Maintenance commands require a bridge board");
    const command = bridgeMaintenanceCommand(request);
    const response = await adapter.executeCommand(command);
    if (request.action !== "reboot") {
      setTimeout(() => {
        try {
          adapter.sendCommand("status");
          adapter.sendCommand("channels");
        } catch {
          // Disconnects after an acknowledged command are reported by the adapter.
        }
      }, 100);
    }
    return { boardId, command, response };
  }

  disconnectAll(): void {
    for (const adapter of this.adapters.values()) adapter.disconnect();
    this.adapters.clear();
    this.boardByPath.clear();
    this.connectingPaths.clear();
  }
}

export function bridgeMaintenanceCommand(request: BridgeMaintenanceRequest): string {
  if (!request || typeof request !== "object") throw new Error("Invalid maintenance request");
  switch (request.action) {
    case "fault_clear": return "fault clear";
    case "rescan": return "rescan";
    case "mux_reset": return "mux reset";
    case "reboot": return "reboot";
    case "channel_enable":
      return `ch ${validChannel(request.channel)} enable`;
    case "channel_disable":
      return `ch ${validChannel(request.channel)} disable`;
    case "channel_direction": {
      const channel = validChannel(request.channel);
      if (request.direction !== 0 && request.direction !== 1) throw new Error("Direction must be 0 or 1");
      return `ch ${channel} dir ${request.direction}`;
    }
    default:
      throw new Error("Unsupported maintenance command");
  }
}

function validChannel(value: unknown): number {
  const channel = Number(value);
  if (!Number.isInteger(channel) || channel < 0 || channel > 5) {
    throw new Error("Bridge channel must be an integer from 0 to 5");
  }
  return channel;
}
