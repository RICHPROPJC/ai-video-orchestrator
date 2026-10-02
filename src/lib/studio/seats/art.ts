/** PR-5：art 席——cast/mesh/道具板/場景板 */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";

export const artSeat: SeatModule = {
  seatId: "art" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("art", "cast/mesh + 道具板 + 場景板。");
    return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
  },
};
