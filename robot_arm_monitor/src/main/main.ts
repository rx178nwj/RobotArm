import { app, BrowserWindow, ipcMain, shell } from "electron";
import path from "node:path";
import type {
  BleDeviceInfo,
  BridgeMaintenanceRequest,
  ControlCommandRequest,
  MappingSettings,
  PortInfo,
  SyncMoveAxisRequest
} from "../shared/types";
import { NamedPipeControlAppClient } from "./adapters/control-app-client";
import { AxisMappingStore } from "./axis-mapping";
import { CsvLogger } from "./csv-logger";
import { DeviceManager } from "./device-manager";

let window: BrowserWindow | null = null;
let mappingStore: AxisMappingStore;
let manager: DeviceManager;
const csvLogger = new CsvLogger();
const controlClient = new NamedPipeControlAppClient();
let loggingWriteFailed = false;

function registerIpc(): void {
  ipcMain.handle("ports:list", () => manager.listPorts());
  ipcMain.handle("device:connect", (_event, info: PortInfo) => manager.connect(info, 100));
  ipcMain.handle("ble:scan", () => manager.scanBleDevices());
  ipcMain.handle("ble:connect", (_event, info: BleDeviceInfo) => manager.connectBle(info, 100));
  ipcMain.handle("ble:open-settings", () => shell.openExternal("ms-settings:bluetooth"));
  ipcMain.handle("device:disconnect", (_event, boardId: string) => manager.disconnect(boardId));
  ipcMain.handle(
    "bridge:maintenance",
    (_event, boardId: string, request: BridgeMaintenanceRequest) =>
      manager.executeBridgeMaintenance(boardId, request)
  );
  ipcMain.handle("bridge:config:refresh", () => manager.refreshBridgeConfigs());
  ipcMain.handle("bridge:logging:state", () => csvLogger.getState());
  ipcMain.handle("bridge:logging:start", async () => {
    if (!window) throw new Error("Application window is not ready");
    if (manager.connectedBridgeCount() === 0) {
      throw new Error("ログ対象のbridgeが接続されていません");
    }
    const state = await csvLogger.startBridgeLog(window, 1000);
    if (state.active) {
      loggingWriteFailed = false;
      manager.startBridgeLogging(
        state.periodMs,
        snapshot => {
          void csvLogger.appendBridgeSnapshot(snapshot).catch(error => {
            if (loggingWriteFailed) return;
            loggingWriteFailed = true;
            manager.stopBridgeLogging();
            window?.webContents.send("bridge:logging:update", {
              ...csvLogger.getState(),
              error: error instanceof Error ? error.message : String(error)
            });
          });
        },
        error => window?.webContents.send("bridge:logging:update", {
          ...csvLogger.getState(),
          error
        })
      );
    }
    window.webContents.send("bridge:logging:update", state);
    return state;
  });
  ipcMain.handle("bridge:logging:stop", async () => {
    manager.stopBridgeLogging();
    const state = await csvLogger.stopBridgeLog();
    window?.webContents.send("bridge:logging:update", state);
    return state;
  });
  ipcMain.handle("bridge:raw-log:export", async () => {
    if (!window) throw new Error("Application window is not ready");
    return csvLogger.exportRawLogs(window, manager.getSnapshotsForExport());
  });
  ipcMain.handle("mapping:get", () => mappingStore.get());
  ipcMain.handle("mapping:set", (_event, settings: MappingSettings) => {
    const result = mappingStore.set(settings);
    manager.publishRobotArmSnapshot();
    return result;
  });
  ipcMain.handle("robot-arm:snapshot", () => manager.getRobotArmSnapshot());
  ipcMain.handle("control:state", () => manager.controlAppConnected);
  ipcMain.handle(
    "control:command",
    (_event, request: ControlCommandRequest) => manager.executeControlCommand(request)
  );
  ipcMain.handle(
    "control:sync-move",
    (_event, requests: SyncMoveAxisRequest[]) => manager.executeSyncMove(requests)
  );
  ipcMain.handle("control:estop", () => manager.sendEstop());
}

app.whenReady().then(() => {
  mappingStore = new AxisMappingStore();
  manager = new DeviceManager(
    snapshot => window?.webContents.send("device:update", snapshot),
    controlClient,
    mappingStore,
    snapshot => window?.webContents.send("robot-arm:update", snapshot)
  );
  controlClient.on("connectionChanged", connected => {
    window?.webContents.send("control:connection-changed", connected);
    manager.publishRobotArmSnapshot();
  });
  controlClient.on("controlEvent", event => {
    window?.webContents.send("control:event", event);
  });
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
  window.on("closed", () => {
    window = null;
  });
  void window.loadFile(path.join(__dirname, "../renderer/index.html"));
});

app.on("window-all-closed", () => {
  manager?.disconnectAll();
  void csvLogger.stopBridgeLog();
  if (process.platform !== "darwin") app.quit();
});
