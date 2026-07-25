import type { EventEmitter } from "node:events";
import type { DeviceKind, DeviceSnapshot } from "../../shared/types";

export type { DeviceKind };

export interface DeviceIdentity {
  kind: DeviceKind;
  boardId: string;
  protocolVersion?: string;
}

export interface DeviceAdapter extends EventEmitter {
  readonly kind: DeviceKind;
  readonly boardId: string;
  connect(path: string, periodMs: number): Promise<void>;
  disconnect(): void;
  sendCommand(command: string): void;
  on(event: "update", listener: (snapshot: DeviceSnapshot) => void): this;
}

export interface IdentityProbe {
  probe(path: string): Promise<DeviceIdentity | null>;
}

export const VID_HINT: Record<string, DeviceKind> = {
  "303a": "stepping_motor_driver",
  "2e8a": "multi_i2c_bridge"
};
