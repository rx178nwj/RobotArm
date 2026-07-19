import { contextBridge, ipcRenderer } from "electron";
import type { AppSettings, DeviceSnapshot, PortInfo } from "../shared/types";

contextBridge.exposeInMainWorld("bridgeApi", {
  listPorts: (): Promise<PortInfo[]> => ipcRenderer.invoke("ports:list"),
  connect: (port: PortInfo, periodMs: number): Promise<string> => ipcRenderer.invoke("device:connect", port, periodMs),
  disconnect: (id: string): Promise<void> => ipcRenderer.invoke("device:disconnect", id),
  setMonitor: (id: string, enabled: boolean, periodMs: number): Promise<void> => ipcRenderer.invoke("monitor:set", id, enabled, periodMs),
  setAllMonitors: (enabled: boolean, periodMs: number): Promise<void> => ipcRenderer.invoke("monitor:set-all", enabled, periodMs),
  getSettings: (): Promise<AppSettings> => ipcRenderer.invoke("settings:get"),
  saveSettings: (settings: AppSettings): Promise<void> => ipcRenderer.invoke("settings:set", settings),
  onDeviceUpdate: (callback: (snapshot: DeviceSnapshot) => void) => ipcRenderer.on("device:update", (_event, snapshot) => callback(snapshot))
});
