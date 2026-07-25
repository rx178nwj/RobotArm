import type { BridgeStatus, ChannelData, MasterStats } from "../../shared/types";

export interface BridgeIdentity {
  product: string;
  id: string;
  protocol: number;
}

function fields(line: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const token of line.trim().split(/\s+/).slice(1)) {
    const split = token.indexOf("=");
    if (split > 0) result[token.slice(0, split)] = token.slice(split + 1);
  }
  return result;
}

const num = (value: string | undefined): number => value ? Number(value) : 0;

export function parseIdentity(line: string): BridgeIdentity | null {
  if (!line.startsWith("IDENTITY ")) return null;
  const f = fields(line);
  if (
    f.product !== "multi_i2c_bridge"
    || !/^[0-9a-f]{16}$/i.test(f.id)
    || f.protocol !== "1"
  ) return null;
  return { product: f.product, id: f.id.toUpperCase(), protocol: num(f.protocol) };
}

export function parseStatus(line: string): Partial<BridgeStatus> | null {
  if (!line.startsWith("STATUS ")) return null;
  const f = fields(line);
  return {
    statusLo: num(f.status_lo), statusHi: num(f.status_hi), fault: num(f.fault),
    chFault: num(f.ch_fault), present: num(f.present), enable: num(f.enable),
    samples: num(f.samples), cmd: num(f.cmd), uptimeMs: num(f.uptime_ms)
  };
}

export function parseDownstream(line: string): Partial<BridgeStatus> | null {
  if (!line.startsWith("DOWNSTREAM ")) return null;
  const f = fields(line);
  return { busRecoveries: num(f.bus_recoveries), muxResets: num(f.mux_resets), rescans: num(f.rescans) };
}

export function parseChannel(line: string): ChannelData | null {
  if (!/^\d+\s/.test(line)) return null;
  const p = line.trim().split(/\s+/);
  if (p.length < 17) return null;
  const invalid = p[6] === "invalid";
  return {
    channel: num(p[0]), present: p[1] === "1", enable: p[2] === "1", ok: p[3] === "1",
    dirConfig: p[4] === "1", dirOutput: p[5] === "1",
    angle: invalid ? null : num(p[6]), degrees: invalid ? null : num(p[7]),
    agc: num(p[8]), magnetRaw: num(p[9]), md: p[10] === "1", ml: p[11] === "1", mh: p[12] === "1",
    readOk: num(p[13]), readErr: num(p[14]), lastOkMs: num(p[15]), lastErrMs: num(p[16])
  };
}

export function parseMaster(line: string, previousActivity?: number): MasterStats | null {
  if (!line.startsWith("MASTER ")) return null;
  const f = fields(line);
  const lastActivityMs = num(f.last_activity_ms);
  return {
    writeTx: num(f.write_tx), writeBytes: num(f.write_bytes), readReq: num(f.read_req),
    readBytes: num(f.read_bytes), lastActivityMs, logSeq: num(f.log_seq),
    active: previousActivity !== undefined && lastActivityMs > previousActivity
  };
}
