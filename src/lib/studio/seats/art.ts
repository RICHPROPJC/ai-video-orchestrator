/** Art席——cast/mesh/道具板/場景板 核心函數 */

import type { AgentId, CallSheet } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

/** 判斷一個cast item需要rig定係rigid */
export function needsRig(role: string, hasMotion: boolean): boolean {
  if (role === "character" && hasMotion) return true;
  return false;
}

/** 判斷SF3D入料需要isolated（唔係scene圖） */
export function isIsolatedRef(imageType: string): boolean {
  return imageType === "portrait" || imageType === "product";
}

export const artSeat: SeatModule = {
  seatId: "art" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("art", "cast/mesh＋道具板＋場景板。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
