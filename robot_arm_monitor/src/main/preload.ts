import { contextBridge, ipcRenderer } from "electron";
import type {
  BleDeviceInfo,
  BridgeConfigRefreshResult,
  BridgeLoggingState,
  BridgeMaintenanceRequest,
  BridgeMaintenanceResult,
  ConnectResult,
  ControlCommandRequest,
  ControlEvent,
  CommandResult,
  DeviceSnapshot,
  CsvExportResult,
  EstopResult,
  MappingSettings,
  PortInfo,
  RobotArmSnapshot,
  SyncMoveAxisRequest
} from "../shared/types";

contextBridge.exposeInMainWorld("robotArmApi", {
  listPorts: (): Promise<PortInfo[]> => ipcRenderer.invoke("ports:list"),
  connect: (port: PortInfo): Promise<ConnectResult> => ipcRenderer.invoke("device:connect", port),
  scanBleDevices: (): Promise<BleDeviceInfo[]> => ipcRenderer.invoke("ble:scan"),
  connectBle: (device: BleDeviceInfo): Promise<ConnectResult> =>
    ipcRenderer.invoke("ble:connect", device),
  openBluetoothSettings: (): Promise<void> => ipcRenderer.invoke("ble:open-settings"),
  disconnect: (boardId: string): Promise<void> => ipcRenderer.invoke("device:disconnect", boardId),
  executeBridgeMaintenance: (
    boardId: string,
    request: BridgeMaintenanceRequest
  ): Promise<BridgeMaintenanceResult> => ipcRenderer.invoke("bridge:maintenance", boardId, request),
  refreshBridgeConfigs: (): Promise<BridgeConfigRefreshResult[]> =>
    ipcRenderer.invoke("bridge:config:refresh"),
  getBridgeLoggingState: (): Promise<BridgeLoggingState> =>
    ipcRenderer.invoke("bridge:logging:state"),
  startBridgeLogging: (): Promise<BridgeLoggingState> =>
    ipcRenderer.invoke("bridge:logging:start"),
  stopBridgeLogging: (): Promise<BridgeLoggingState> =>
    ipcRenderer.invoke("bridge:logging:stop"),
  exportRawLogs: (): Promise<CsvExportResult> =>
    ipcRenderer.invoke("bridge:raw-log:export"),
  getMappingSettings: (): Promise<MappingSettings> => ipcRenderer.invoke("mapping:get"),
  saveMappingSettings: (settings: MappingSettings): Promise<MappingSettings> => ipcRenderer.invoke("mapping:set", settings),
  getControlConnectionState: (): Promise<boolean> => ipcRenderer.invoke("control:state"),
  sendControlCommand: (request: ControlCommandRequest): Promise<CommandResult> =>
    ipcRenderer.invoke("control:command", request),
  sendSyncMove: (requests: SyncMoveAxisRequest[]): Promise<CommandResult> =>
    ipcRenderer.invoke("control:sync-move", requests),
  sendEstop: (): Promise<EstopResult> => ipcRenderer.invoke("control:estop"),
  getRobotArmSnapshot: (): Promise<RobotArmSnapshot> => ipcRenderer.invoke("robot-arm:snapshot"),
  onDeviceUpdate: (callback: (snapshot: DeviceSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DeviceSnapshot) => callback(snapshot);
    ipcRenderer.on("device:update", listener);
    return () => ipcRenderer.removeListener("device:update", listener);
  },
  onBridgeLoggingUpdate: (callback: (state: BridgeLoggingState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BridgeLoggingState) => callback(state);
    ipcRenderer.on("bridge:logging:update", listener);
    return () => ipcRenderer.removeListener("bridge:logging:update", listener);
  },
  onControlConnectionChanged: (callback: (connected: boolean) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, connected: boolean) => callback(connected);
    ipcRenderer.on("control:connection-changed", listener);
    return () => ipcRenderer.removeListener("control:connection-changed", listener);
  },
  onControlEvent: (callback: (event: ControlEvent) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, controlEvent: ControlEvent) =>
      callback(controlEvent);
    ipcRenderer.on("control:event", listener);
    return () => ipcRenderer.removeListener("control:event", listener);
  },
  onRobotArmUpdate: (callback: (snapshot: RobotArmSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: RobotArmSnapshot) => callback(snapshot);
    ipcRenderer.on("robot-arm:update", listener);
    return () => ipcRenderer.removeListener("robot-arm:update", listener);
  }
});
