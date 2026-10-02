/** PR-2：delivery 席——從 pipeline.ts :1088-1184 抽出 */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import fs from "node:fs";
import path from "node:path";
import { jobDir } from "../paths";

export const deliverySeat: SeatModule = {
  seatId: "delivery" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    const dir = jobDir(ctx.jobId);
    ctx.speak("delivery", "交片包：mp4 + continuity + QC + Blender。故事＝分鏡＝剪接。");

    try {
      const mp4 = path.join(dir, "delivery", `${ctx.jobId}.mp4`);
      if (!fs.existsSync(mp4)) throw new Error(`delivery_missing_mp4: ${mp4}`);

      const files = [
        mp4,
        path.join(dir, "continuity.json"),
        path.join(dir, "cut_plan.json"),
        path.join(dir, "timing.json"),
      ].filter(f => fs.existsSync(f));

      const totalSize = files.reduce((s, f) => s + fs.statSync(f).size, 0);
      ctx.speak("delivery", `交片：${files.length} 檔案 ${(totalSize / 1024 / 1024).toFixed(1)}MB`, "pass");

      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.speak("delivery", `交片失敗：${msg}`, "fail");
      return { status: "FAILED_TERMINAL", stopped: true, artifacts: [], receipts: [], gaps: [], violations: [{ step: "delivery", constraint: "delivery", severity: "hard", saw: msg, expected: "no throw" }] };
    }
  },
};
