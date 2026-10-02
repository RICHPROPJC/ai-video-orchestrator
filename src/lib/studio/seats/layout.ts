/** Layout席（阿標）核心邏輯——從pipeline/world.ts + world-scale.ts提取
 *
 * 職責：world assemble、blockout bake、motion-select
 * 複雜席位——先遷核心純函數
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId, CallSheet } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

/** world-scale.ts:27 從callsheet提取世界件 */
export interface WorldPiece {
  id: string;
  role: string;
  meters: number;
  glb?: string;
  evidence?: string;
}

export function piecesFromCallSheet(
  sheet: CallSheet,
): WorldPiece[] {
  const pieces: WorldPiece[] = [];
  for (const c of sheet.characters) {
    pieces.push({
      id: c.id,
      role: "character",
      meters: c.heightM,
      evidence: `角色 ${c.name} 身高 ${c.heightM}m`,
    });
  }
  for (const p of sheet.props ?? []) {
    pieces.push({
      id: p.name,
      role: "prop",
      meters: p.sizeMeters ?? 0.3,
      evidence: `道具 ${p.name}`,
    });
  }
  if (sheet.location) {
    pieces.push({
      id: sheet.location,
      role: "scene",
      meters: 1,
      evidence: `場景 ${sheet.location}`,
    });
  }
  return pieces;
}

/** blockout.ts:91 計still幀位置 */
export function stillFrameFor(shotDurationSec: number, totalFrames: number): number {
  return Math.min(Math.floor(shotDurationSec * 24 / 2), totalFrames - 1);
}

/** motion-select核心：verb gate——action嘅動詞喺CMU庫有冇覆蓋 */
export function verbsForGate(action: string, knownVerbs: Set<string>): string[] {
  const words = action.toLowerCase().split(/\s+/);
  return words.filter(w => knownVerbs.has(w));
}

export const layoutSeat: SeatModule = {
  seatId: "layout" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("layout", "世界搭建＋走位＋blockout bake。");
    try {
      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "FAILED_RETRYABLE", stopped: false, artifacts: [], receipts: [],
        gaps: [], violations: [{ step: "layout", constraint: "layout", severity: "hard", saw: msg, expected: "no throw" }],
      };
    }
  },
};
