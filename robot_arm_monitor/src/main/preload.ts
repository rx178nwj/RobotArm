import { contextBridge, ipcRenderer } from "electron";
import type {
  BridgeMaintenanceRequest,
  BridgeMaintenanceResult,
  ConnectResult,
  DeviceSnapshot,
  MappingSettings,
  PortInfo
} from "../shared/types";

contextBridge.exposeInMainWorld("robotArmApi", {
  listPorts: (): Promise<PortInfo[]> => ipcRenderer.invoke("ports:list"),
  connect: (port: PortInfo): Promise<ConnectResult> => ipcRenderer.invoke("device:connect", port),
  disconnect: (boardId: string): Promise<void> => ipcRenderer.invoke("device:disconnect", boardId),
  executeBridgeMaintenance: (
    boardId: string,
    request: BridgeMaintenanceRequest
  ): Promise<BridgeMaintenanceResult> => ipcRenderer.invoke("bridge:maintenance", boardId, request),
  getMappingSettings: (): Promise<MappingSettings> => ipcRenderer.invoke("mapping:get"),
  saveMappingSettings: (settings: MappingSettings): Promise<MappingSettings> => ipcRenderer.invoke("mapping:set", settings),
  onDeviceUpdate: (callback: (snapshot: DeviceSnapshot) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: DeviceSnapshot) => callback(snapshot);
    ipcRenderer.on("device:update", listener);
    return () => ipcRenderer.removeListener("device:update", listener);
  }
});
