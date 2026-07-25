import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import type { BridgeMaintenanceRequest, MappingSettings, PortInfo } from "../shared/types";
import { AxisMappingStore } from "./axis-mapping";
import { DeviceManager } from "./device-manager";

let window: BrowserWindow | null = null;
let mappingStore: AxisMappingStore;
const manager = new DeviceManager(snapshot => window?.webContents.send("device:update", snapshot));

function registerIpc(): void {
  ipcMain.handle("ports:list", () => manager.listPorts());
  ipcMain.handle("device:connect", (_event, info: PortInfo) => manager.connect(info, 100));
  ipcMain.handle("device:disconnect", (_event, boardId: string) => manager.disconnect(boardId));
  ipcMain.handle(
    "bridge:maintenance",
    (_event, boardId: string, request: BridgeMaintenanceRequest) =>
      manager.executeBridgeMaintenance(boardId, request)
  );
  ipcMain.handle("mapping:get", () => mappingStore.get());
  ipcMain.handle("mapping:set", (_event, settings: MappingSettings) => mappingStore.set(settings));
}

app.whenReady().then(() => {
  mappingStore = new AxisMappingStore();
  registerIpc();
  window = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 820,
    minHeight: 620,
    title: "Robot Arm Monitor",
    backgroundColor: "#0b111b",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  void window.loadFile(path.join(__dirname, "../renderer/index.html"));
});

app.on("window-all-closed", () => {
  manager.disconnectAll();
  if (process.platform !== "darwin") app.quit();
});
