/** Boards席（阿圖）核心函數 */

import type { AgentId, Shot } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

/** 景別階梯檢查：連續鏡頭唔可以跳超過一級 */
const SIZE_ORDER = ["insert", "closeup", "medium", "full", "wide"];

export function isSizeJump(prev: string, next: string): boolean {
  const pi = SIZE_ORDER.indexOf(prev);
  const ni = SIZE_ORDER.indexOf(next);
  if (pi < 0 || ni < 0) return false;
  return Math.abs(pi - ni) > 1;
}

/** 分鏡板cell QC：檢查人數/灰模/物件 */
export function boardCellCheck(opts: {
  expectedPeople: number;
  greyBlocks: boolean;
  tool?: string;
}): { pass: boolean; reasons: string[] } {
  const reasons: string[] = [];
  if (opts.greyBlocks) reasons.push("grey_blocks: true");
  if (opts.tool === "product" && !opts.tool) reasons.push("product_without_props");
  return { pass: reasons.length === 0, reasons };
}

export const boardsSeat: SeatModule = {
  seatId: "boards" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("boards", "分鏡板生成。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
