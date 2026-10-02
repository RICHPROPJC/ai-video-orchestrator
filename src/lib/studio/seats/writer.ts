/** PR-5：writer 席（阿文）——編劇 */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export const writerSeat: SeatModule = {
  seatId: "writer" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("writer", "編劇：outline → beats → callsheet。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
