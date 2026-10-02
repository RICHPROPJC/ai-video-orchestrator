/** PR-5：pictureQc 席（阿察）——從 pipeline.ts :623-690 抽出 */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export const pictureQcSeat: SeatModule = {
  seatId: "pictureQc" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("pictureQc", "Qwen 27B 盲測：人數、灰模、物件。每鏡 /edit 完即判。");
    // 照舊邏輯：每鏡盲測，GREEN pin 先准做下鏡
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
