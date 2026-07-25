# Multi I2C Bridge Monitor

Electron + TypeScript desktop monitor for the USB-CDC interface documented in
`../docs/monitor_app_spec.md`.

```powershell
npm.cmd install
npm.cmd start
```

The application discovers RP2040 serial ports and requires an explicit Connect action
for the first connection. After that, it identifies the bridge using the firmware
`identity` command and automatically reconnects it even if the OS assigns a new port.
