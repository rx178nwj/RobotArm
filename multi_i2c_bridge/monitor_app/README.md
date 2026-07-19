# Multi I2C Bridge Monitor

Electron + TypeScript desktop monitor for the USB-CDC interface documented in
`../docs/monitor_app_spec.md`.

```powershell
npm.cmd install
npm.cmd start
```

The application discovers RP2040 serial ports, requires an explicit Connect action,
and monitors each connected bridge independently.
