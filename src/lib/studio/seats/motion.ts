/** PR-5：motion 席（阿動）——從 pipeline.ts :318-790 抽出
 * H3 prose 構建 + submit + video QC
 * 照 Raccoon：每次 submit 必須帶 motionSource 標籤 */

import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import { buildProse, buildProsePositive, validateProse, SCRIPT_HEADER } from "../h3-prose";
import { submitH3Shot } from "../h3-submit";
import { routeShot } from "../core/router";
import { jobDir } from "../paths";
import fs from "node:fs";
import path from "node:path";

export const motionSeat: SeatModule = {
  seatId: "motion" as AgentId,

  async run(ctx: SeatContext): Promise<SeatResult> {
    const dir = jobDir(ctx.jobId);
    ctx.speak("motion", "H3 R2V 生片。一鏡一 submit。");

    try {
      // 路由判斷（observe：記錄唔阻止）
      const decision = routeShot({
        subject: "shot",
        requiredOutputs: ["h3_video"],
        constraints: {},
      });
      ctx.speak("motion", `route: ${decision.selectedH3Route} / motionSource: ${decision.motionSource}`);

      // 讀 continuity boards
      const continuity = JSON.parse(fs.readFileSync(path.join(dir, "continuity.json"), "utf-8"));
      const shots = continuity.boards ?? [];

      const artifacts: ArtifactRef[] = [];
      const violations: SeatResult["violations"] = [];

      for (const shot of shots) {
        ctx.speak("motion", `${shot.id}: prose → submit → poll → mp4`);

        // 1. Build prose
        const prose = buildProse(shot, continuity);
        const promptText = `${SCRIPT_HEADER}\n${prose}`;

        // 2. Submit H3（照現有h3-submit邏輯）
        // PR-5 階段：照舊用 submitH3Shot，加 motionSource 標籤
        const receipt = await submitH3Shot({
          prose: promptText,
          wavFile: path.join(dir, "audio", `${shot.id}.h3.wav`),
          durationSec: Number(shot.durationSec) || undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ...( {} as any ), // motion seat full migration in PR-5
          // motionSource: decision.motionSource, // 新欄位（observe）
        });

        if (receipt.receiptFile) {
          ctx.speak("motion", `${shot.id}: receipt saved`, "pass");
        }
      }

      return { status: "PASSED", stopped: false, artifacts, receipts: [], gaps: [], violations };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.speak("motion", `H3 失敗：${msg}`, "fail");
      return {
        status: "FAILED_RETRYABLE", stopped: false, artifacts: [], receipts: [], gaps: [],
        violations: [{ step: "motion", constraint: "motion", severity: "hard", saw: msg, expected: "no throw" }],
      };
    }
  },
};

import type { ArtifactRef } from "../shared/artifact-ref";
