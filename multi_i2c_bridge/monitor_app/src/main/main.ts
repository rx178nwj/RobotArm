import { app, BrowserWindow, ipcMain } from "electron";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { SerialPort } from "serialport";
import type { AppSettings, PortInfo } from "../shared/types";
import { DeviceSession } from "./device-session";

const sessions = new Map<string, DeviceSession>();
let window: BrowserWindow | null = null;
const defaults: AppSettings = { periodMs: 1000, historySeconds: 60, layout: "single", labels: {} };

const settingsPath = () => path.join(app.getPath("userData"), "settings.json");
async function loadSettings(): Promise<AppSettings> { try { return { ...defaults, ...JSON.parse(await readFile(settingsPath(), "utf8")) }; } catch { return defaults; } }
async function listPorts(): Promise<PortInfo[]> {
  return (await SerialPort.list()).map(port => ({
    path: port.path, manufacturer: port.manufacturer, serialNumber: port.serialNumber,
    vendorId: port.vendorId, productId: port.productId,
    friendlyName: [port.manufacturer, port.path].filter(Boolean).join(" · "),
    candidate: port.vendorId?.toLowerCase() === "2e8a"
  }));
}

function registerIpc(): void {
  ipcMain.handle("ports:list", listPorts);
  ipcMain.handle("settings:get", loadSettings);
  ipcMain.handle("settings:set", async (_event, value: AppSettings) => writeFile(settingsPath(), JSON.stringify(value, null, 2)));
  ipcMain.handle("device:connect", async (_event, info: PortInfo, periodMs: number) => {
    const id = info.serialNumber || info.path;
    if (sessions.has(id)) return id;
    const session = new DeviceSession(info);
    sessions.set(id, session);
    session.on("update", snapshot => window?.webContents.send("device:update", snapshot));
    try { await session.connect(periodMs); } catch (error) { sessions.delete(id); throw error; }
    return id;
  });
  ipcMain.handle("device:disconnect", (_event, id: string) => { sessions.get(id)?.disconnect(); sessions.delete(id); });
  ipcMain.handle("monitor:set", (_event, id: string, enabled: boolean, periodMs: number) => enabled ? sessions.get(id)?.startMonitor(periodMs) : sessions.get(id)?.stopMonitor());
  ipcMain.handle("monitor:set-all", (_event, enabled: boolean, periodMs: number) => sessions.forEach(session => enabled ? session.startMonitor(periodMs) : session.stopMonitor()));
}

app.whenReady().then(() => {
  registerIpc();
  window = new BrowserWindow({
    width: 1480, height: 920, minWidth: 1050, minHeight: 700, title: "Multi I2C Bridge Monitor",
    backgroundColor: "#09111f", webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false }
  });
  window.loadFile(path.join(__dirname, "../renderer/index.html"));
});

app.on("window-all-closed", () => { sessions.forEach(session => session.disconnect()); if (process.platform !== "darwin") app.quit(); });
