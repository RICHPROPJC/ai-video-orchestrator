/** PR-5：boards 席（阿圖）——分鏡板 */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export const boardsSeat: SeatModule = {
  seatId: "boards" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("boards", "分鏡板生成。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
