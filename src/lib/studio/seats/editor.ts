/** PR-2：editor 席（阿剪）——從 pipeline.ts :911-1085 抽出 */
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import { checkGate } from "../concat-gate";
import { ensureDir, jobDir } from "../paths";
import fs from "node:fs";
import path from "node:path";

export const editorSeat: SeatModule = {
  seatId: "editor" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    const dir = jobDir(ctx.jobId);
    ctx.speak("editor", "剪接：concat gate → ffmpeg 照 cut_plan 接片。");

    try {
      const cutPlan = JSON.parse(fs.readFileSync(path.join(dir, "cut_plan.json"), "utf-8"));
      const cut: string[] = cutPlan.shots.map((s: { id: string }) => s.id);
      ctx.speak("editor", `照分鏡接：${cut.join(" → ")}。唔重排。`);

      // concat gate
      const gate = await checkGate({ plan: cutPlan, motionDir: path.join(dir, "motion") });
      if (!gate.ok) {
        return {
          status: "FAILED_TERMINAL", stopped: true, artifacts: [], receipts: [],
          gaps: [], violations: [{ step: "editor", constraint: "concat_gate", severity: "hard", saw: gate.reason, expected: "all shots present" }],
        };
      }

      // ffmpeg concat（native copy）
      const mp4s = cut.map((id: string) => path.join(dir, "motion", `${id}.mp4`));
      const outFile = path.join(dir, "delivery", `${ctx.jobId}.mp4`);
      ensureDir(path.dirname(outFile));

      // 寫 concat list
      const listFile = path.join(dir, "concat_list.txt");
      fs.writeFileSync(listFile, mp4s.map(f => `file '${f}'`).join("\n"));

      const { runCommand } = await import("../audio");
      const r = await runCommand("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFile]);
      if (r.code !== 0) throw new Error(`editor_ffmpeg: ${r.stderr.slice(-300)}`);

      ctx.speak("editor", `剪接完成：${outFile}`, "pass");
      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.speak("editor", `剪接失敗：${msg}`, "fail");
      return { status: "FAILED_TERMINAL", stopped: true, artifacts: [], receipts: [], gaps: [], violations: [{ step: "editor", constraint: "editor", severity: "hard", saw: msg, expected: "no throw" }] };
    }
  },
};
