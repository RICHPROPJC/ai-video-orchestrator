/** Writer席（阿文）核心函數 */

import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

/** 秒數/beat預算：一beat幾多秒（照writer charter） */
export function maxBeatsForSec(sec: number): number {
  // charter: 2.33秒≈1-2 beats; 1.5秒≈1 beat
  if (sec <= 1.5) return 1;
  if (sec <= 3.5) return 2;
  return Math.ceil(sec / 2);
}

/** 對白時鐘：一個字≈幾秒 */
export function dialogueSeconds(text: string): number {
  // charter: SECONDS_PER_CHAR ≈ 0.35s/字（中文）
  const leadIn = 0.2; // DIALOGUE_LEAD_IN
  return text.length * 0.35 + leadIn;
}

/** 場次秒數加總驗證 */
export function totalSceneSec(scenes: Array<{ targetSec: number }>): number {
  return scenes.reduce((s, sc) => s + sc.targetSec, 0);
}

export const writerSeat: SeatModule = {
  seatId: "writer" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("writer", "編劇：outline → beats → callsheet。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
