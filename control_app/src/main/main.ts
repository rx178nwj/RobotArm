import { app, BrowserWindow, ipcMain } from "electron";
import path from "node:path";
import type { AppLogEntry, AppSnapshot } from "../shared/types";
import { BoardManager } from "./board-manager";
import { ControlIpcServer } from "./ipc-server";

let window: BrowserWindow | null = null;
const manager = new BoardManager();
const ipcServer = new ControlIpcServer(manager);
const logs: AppLogEntry[] = [];

function snapshot(): AppSnapshot {
  return {
    ipcClientConnected: ipcServer.clientConnected,
    boards: manager.getBoards(),
    logs: [...logs]
  };
}

function publish(): void {
  window?.webContents.send("app:snapshot", snapshot());
}

function log(source: AppLogEntry["source"], message: string): void {
  logs.push({ timestamp: Date.now(), source, message });
  if (logs.length > 200) logs.splice(0, logs.length - 200);
  publish();
}

manager.on("connectionChanged", publish);
manager.on("controlEvent", event => log("board", `EVT ${event.boardId} ${event.event}${event.axis === undefined ? "" : ` ${event.axis}`}`));
manager.on("log", message => log("board", String(message)));
ipcServer.on("clientConnectionChanged", publish);
ipcServer.on("log", message => log("ipc", String(message)));

app.whenReady().then(async () => {
  ipcMain.handle("app:snapshot", snapshot);
  window = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 680,
    minHeight: 480,
    title: "Robot Arm Control",
    backgroundColor: "#10151d",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  window.on("closed", () => { window = null; });
  await window.loadFile(path.join(__dirname, "../renderer/index.html"));
  try {
    await ipcServer.start();
    log("system", "Named Pipe server started");
  } catch (error) {
    log("system", `Named Pipe server failed: ${error instanceof Error ? error.message : String(error)}`);
  }
  manager.startDiscovery();
  publish();
});

app.on("window-all-closed", () => {
  manager.closeAll();
  void ipcServer.close();
  if (process.platform !== "darwin") app.quit();
});
