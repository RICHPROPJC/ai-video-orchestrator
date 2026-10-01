/** PR-1 §2：Delivery 席——第一個用新 SeatModule 介面嘅模板
 * 從 pipeline.ts :1088-1184 抽出，示範席位遷移標準做法。 */

import fs from "node:fs";
import path from "node:path";
import { ensureDir, jobDir } from "../shared/../paths";
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "./orchestrator";
import { concatCopyArgs, assertNativeFfmpeg } from "../native-cut";
import { runCommand } from "../audio";

export const deliverySeat: SeatModule = {
  seatId: "delivery" as AgentId,

  async run(ctx: SeatContext): Promise<SeatResult> {
    const { jobId, input } = ctx;
    const dir = jobDir(jobId);

    ctx.speak("delivery", "交片包：mp4 + continuity + QC + Blender。故事＝分鏡＝剪接。");

    try {
      // 1. 驗 ffmpeg
      await assertNativeFfmpeg(["ffmpeg"]);

      // 2. 讀 cut plan 揀定嘅鏡
      const cutPlan = JSON.parse(fs.readFileSync(path.join(dir, "cut_plan.json"), "utf-8"));
      const shots = cutPlan.shots.map((s: { id: string; wav: string }) => s.id);

      // 3. concat 所有 motion mp4
      const motionDir = path.join(dir, "motion");
      const mp4s = shots.map((id: string) => path.join(motionDir, `${id}.mp4`));
      for (const f of mp4s) {
        if (!fs.existsSync(f)) throw new Error(`delivery_missing_shot: ${f}`);
      }

      const outPath = path.join(dir, "delivery", `${jobId}.mp4`);
      ensureDir(path.dirname(outPath));

      const args = await concatCopyArgs(mp4s, outPath);
      const r = await runCommand("ffmpeg", args);
      if (r.code !== 0) throw new Error(`delivery_ffmpeg_fail: ${r.stderr.slice(-300)}`);

      // 4. 打包
      const files = [
        outPath,
        path.join(dir, "continuity.json"),
        path.join(dir, "cut_plan.json"),
      ].filter(f => fs.existsSync(f));

      ctx.speak("delivery", `交片完成：${outPath}（${files.length} 個檔案）`, "pass");

      return {
        status: "PASSED",
        stopped: false,
        artifacts: [],  // PR-2 填 ArtifactRef
        receipts: [],   // PR-2 填 ReceiptRef
        gaps: [],
        violations: [],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.speak("delivery", `交片失敗：${message}`, "fail");
      return {
        status: "FAILED_TERMINAL",
        stopped: true,
        artifacts: [],
        receipts: [],
        gaps: [],
        violations: [{ step: "delivery", constraint: "delivery", severity: "hard", saw: message, expected: "no throw" }],
      };
    }
  },
};
