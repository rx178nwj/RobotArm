const { app, BrowserWindow } = require("electron");
const { promises: fs } = require("node:fs");
const path = require("node:path");

app.disableHardwareAcceleration();

app.whenReady().then(async () => {
  const svgPath = path.resolve(__dirname, "../build/icon.svg");
  const svg = await fs.readFile(svgPath, "utf8");
  const window = new BrowserWindow({
    width: 512,
    height: 512,
    useContentSize: true,
    frame: false,
    show: false,
    transparent: true,
    webPreferences: { offscreen: true }
  });
  window.webContents.setFrameRate(30);
  const imagePromise = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Icon render timeout")), 5000);
    window.webContents.once("paint", (_event, _dirty, image) => {
      clearTimeout(timeout);
      resolve(image);
    });
  });
  await window.loadURL(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
  const image = await imagePromise;
  await fs.writeFile(path.resolve(__dirname, "../build/icon.png"), image.toPNG());
  window.destroy();
  app.quit();
}).catch(error => {
  console.error(error);
  app.exit(1);
});
