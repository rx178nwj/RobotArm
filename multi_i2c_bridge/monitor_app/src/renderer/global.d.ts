import type { AppSettings, DeviceSnapshot, PortInfo } from "../shared/types";

declare global {
  interface Window {
    bridgeApi: {
      listPorts(): Promise<PortInfo[]>;
      connect(port: PortInfo, periodMs: number): Promise<string>;
      disconnect(id: string): Promise<void>;
      setMonitor(id: string, enabled: boolean, periodMs: number): Promise<void>;
      setAllMonitors(enabled: boolean, periodMs: number): Promise<void>;
      getSettings(): Promise<AppSettings>;
      saveSettings(settings: AppSettings): Promise<void>;
      onDeviceUpdate(callback: (snapshot: DeviceSnapshot) => void): void;
    }
  }
}
export {};
