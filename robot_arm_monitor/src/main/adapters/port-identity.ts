import { SerialPort } from "serialport";
import { ReadlineParser } from "@serialport/parser-readline";
import type { LogDirection, PortInfo, RawLogEntry } from "../../shared/types";
import { parseIdentity, type BridgeIdentity } from "./parser";

const closePort = (port: SerialPort): Promise<void> => new Promise(resolve => {
  if (!port.isOpen) return resolve();
  port.close(() => resolve());
});

export type ProbeLogger = (direction: LogDirection, text: string) => void;

export async function identifyPort(
  info: PortInfo,
  timeoutMs = 1500,
  logger?: ProbeLogger
): Promise<BridgeIdentity> {
  const port = new SerialPort({ path: info.path, baudRate: 115200, autoOpen: false });
  let rejectOnPortError: ((error: Error) => void) | undefined;
  port.on("error", error => rejectOnPortError?.(error));
  try {
    await new Promise<void>((resolve, reject) => port.open(error => error ? reject(error) : resolve()));
    await new Promise<void>((resolve, reject) => port.set({ dtr: true, rts: true }, error => error ? reject(error) : resolve()));
    const parser = port.pipe(new ReadlineParser({ delimiter: "\n" }));
    return await new Promise<BridgeIdentity>((resolve, reject) => {
      let finished = false;
      const finish = (action: () => void) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        rejectOnPortError = undefined;
        action();
      };
      const timer = setTimeout(
        () => finish(() => reject(new Error(`identity response timeout on ${info.path}; update the bridge firmware`))),
        timeoutMs
      );
      rejectOnPortError = error => finish(() => reject(error));
      parser.on("data", (raw: string) => {
        const line = raw.replace(/\r$/, "");
        logger?.("rx", line);
        const identity = parseIdentity(line);
        if (identity) finish(() => resolve(identity));
      });
      logger?.("tx", "identity");
      port.write("identity\n", error => {
        if (error) finish(() => reject(error));
      });
    });
  } finally {
    rejectOnPortError = undefined;
    await closePort(port);
  }
}

export function makeProbeLog(): { entries: RawLogEntry[]; logger: ProbeLogger } {
  const entries: RawLogEntry[] = [];
  return {
    entries,
    logger: (direction, text) => entries.push({ timestamp: Date.now(), direction, text })
  };
}
