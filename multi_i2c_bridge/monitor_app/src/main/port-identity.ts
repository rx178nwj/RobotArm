import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { PortInfo } from "../shared/types";
import { parseIdentity, type BridgeIdentity } from "./parser";

const closePort = (port: SerialPort): Promise<void> => new Promise(resolve => {
  if (!port.isOpen) return resolve();
  port.close(() => resolve());
});

export async function identifyPort(info: PortInfo, timeoutMs = 1500): Promise<BridgeIdentity> {
  const port = new SerialPort({ path: info.path, baudRate: 115200, autoOpen: false });
  let rejectOnPortError: ((error: Error) => void) | undefined;
  port.on("error", error => rejectOnPortError?.(error));
  try {
    await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => port.set({ dtr: true, rts: true }, error => error ? reject(error) : resolve()));
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    return await new Promise<BridgeIdentity>((resolve, reject) => {
      const finish = (action: () => void) => {
        clearTimeout(timer);
        rejectOnPortError = undefined;
        action();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(`identity response timeout on ${info.path}; update the bridge firmware`))), timeoutMs);
      rejectOnPortError = error => finish(() => reject(error));
      parser.on("data", (raw: string) => {
        const identity = parseIdentity(raw.replace(/\r$/, ""));
        if (!identity) return;
        finish(() => resolve(identity));
      });
      port.write("identity\n", error => {
        if (!error) return;
        finish(() => reject(error));
      });
    });
  } finally {
    rejectOnPortError = undefined;
    await closePort(port);
  }
}
