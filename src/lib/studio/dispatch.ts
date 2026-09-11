import type { AgentId } from "./types";
import { whoLine } from "./crew";

/**
 * ViMax-style dispatch: hand a sealed packet to a named specialist.
 * In-process only. Packet.slate is the only vault the receiver may read.
 */
export type Packet<T> = {
  kind: "slate-packet";
  slate: string;
  from: AgentId;
  to: AgentId;
  issuedAt: string;
  payload: T;
};

export function seal<T>(opts: { slate: string; from: AgentId; to: AgentId; payload: T }): Packet<T> {
  return {
    kind: "slate-packet",
    slate: opts.slate,
    from: opts.from,
    to: opts.to,
    issuedAt: new Date().toISOString(),
    payload: opts.payload,
  };
}

export function open<T>(packet: Packet<T>, expect: { slate: string; to: AgentId }): T {
  if (packet.kind !== "slate-packet") throw new Error("not a slate packet");
  if (packet.slate !== expect.slate) {
    throw new Error(`cross-job dispatch blocked: packet ${packet.slate} ≠ floor ${expect.slate}`);
  }
  if (packet.to !== expect.to) {
    throw new Error(`wrong desk: packet for ${whoLine(packet.to)}, standing ${whoLine(expect.to)}`);
  }
  return packet.payload;
}

export function packetLine<T>(p: Packet<T>) {
  return `${whoLine(p.from)} → ${whoLine(p.to)} · packet ${p.slate} only · 唔讀舊 project`;
}
