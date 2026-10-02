/** PR-5：layout 席（阿標）——從 pipeline/world.ts 抽出
 * world assemble + blockout bake + motion-select（複雜席位，逐步遷移） */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export const layoutSeat: SeatModule = {
  seatId: "layout" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("layout", "世界搭建 + 走位 + blockout bake。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
