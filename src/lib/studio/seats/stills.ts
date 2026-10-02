/** PR-5：stills 席（阿靜）——從 pipeline/stills.ts 抽出
 * keyframe 生成 + PE 改寫 + photo QC（複雜席位，逐步遷移） */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export const stillsSeat: SeatModule = {
  seatId: "stills" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("stills", "U1.5 生圖 + PE 改寫 + photo QC。");
    // 完整邏輯由 pipeline/stills.ts 遷移（PR-5 逐段搬）
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
