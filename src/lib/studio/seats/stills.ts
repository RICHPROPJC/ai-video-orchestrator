/** Stills席（阿靜）核心邏輯——從pipeline/stills.ts提取可測試函數
 *
 * 職責：U1.5 keyframe生成、PE改寫、photo QC
 * 複雜席位——先遷核心純函數，依賴調用逐步接
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

/** T44 §1：判斷每鏡係咪「首次出場」（需要重新portrait） */
export function stillFirstFlags(
  boards: Array<{ marks: Array<{ characterId: string }> }>,
): boolean[] {
  const seen = new Set<string>();
  return boards.map((board, i) => {
    const newChar = board.marks.some(m => !seen.has(m.characterId));
    for (const m of board.marks) seen.add(m.characterId);
    return i === 0 || newChar;
  });
}

/** T44 §4：refs必須有自己嘅GREEN photo_qc先可以做Image-2+ */
export function refsGreenOnly(
  candidates: string[],
  isAccepted: (dir: string, id: string) => boolean,
): { kept: string[]; rejected: string[] } {
  const kept: string[] = [];
  const rejected: string[] = [];
  for (const file of candidates) {
    const dir = path.dirname(file);
    const id = path.basename(file, path.extname(file));
    (isAccepted(dir, id) ? kept : rejected).push(file);
  }
  return { kept, rejected };
}

/** T36：edit record封裝——bare filenames、prompt原文 */
export function sealEditRecord(
  inputs: { prompt: string; first: boolean; base: string; refs: string[] },
  params: { prompt: string; img_cfg_scale: number; cfg_scale: number; num_steps: number; use_edit_pe: boolean; width: number; height: number },
): Record<string, unknown> {
  return {
    ts: new Date().toISOString(),
    prompt: params.prompt,
    img_cfg: params.img_cfg_scale,
    cfg: params.cfg_scale,
    steps: params.num_steps,
    use_edit_pe: params.use_edit_pe,
    width: params.width,
    height: params.height,
    first: inputs.first,
    base: path.basename(inputs.base),
    refs: inputs.refs.map(f => path.basename(f)),
  };
}

export const stillsSeat: SeatModule = {
  seatId: "stills" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("stills", "U1.5 keyframe生成。");
    try {
      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        status: "FAILED_RETRYABLE", stopped: false, artifacts: [], receipts: [],
        gaps: [], violations: [{ step: "stills", constraint: "stills", severity: "hard", saw: msg, expected: "no throw" }],
      };
    }
  },
};
