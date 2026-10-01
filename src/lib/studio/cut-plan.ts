import fs from "node:fs";
import path from "node:path";
import { wavSeconds } from "./frame-grid";

export type CutPlanShot = {
  id: string;
  start_s: number;
  end_s: number;
  duration_s: number;
  wav: string;
};

export type CutPlan = {
  spine_duration_s?: number;
  gap_s: number;
  shots: CutPlanShot[];
};

const r6 = (n: number) => Math.round(n * 1e6) / 1e6;

/** cut plan from the continuity cut order. lockedSec is the story clock.
 *  Without it, duration falls back to the wav length. Writes cut_plan.json when outFile given. */
export async function buildCutPlan(opts: {
  cut: string[];
  wavDir: string;
  gapSec?: number;
  spineWav?: string;
  outFile?: string;
  lockedSec?: Record<string, number>;
  allowWavFallback?: boolean;
}): Promise<CutPlan> {
  const gap = opts.gapSec ?? 0;
  const shots: CutPlanShot[] = [];
  const missing: string[] = [];
  let t = 0;
  for (const id of opts.cut) {
    const wav = path.join(opts.wavDir, `${id}.wav`);
    if (!fs.existsSync(wav)) throw new Error(`missing wav slice ${wav}`);
    const locked = opts.lockedSec?.[id];
    if (typeof locked !== "number" || !Number.isFinite(locked) || locked <= 0) {
      if (opts.allowWavFallback) {
        const wavDur = await wavSeconds(wav);
        shots.push({ id, start_s: r6(t), end_s: r6(t + wavDur), duration_s: r6(wavDur), wav });
        t += wavDur + gap;
        continue;
      }
      missing.push(id);
      continue;
    }
    const duration = locked;
    shots.push({
      id,
      start_s: r6(t),
      end_s: r6(t + duration),
      duration_s: r6(duration),
      wav,
    });
    t += duration + gap;
  }
  if (missing.length) {
    throw new Error(
      `timing_ledger: ${missing.length} 镜缺 lockedSec（${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""}）——cut_plan 不准用 wav 长度代替故事时钟；请 producer 补齐 continuity.durationSec`,
    );
  }
  const plan: CutPlan = { gap_s: gap, shots };
  if (opts.spineWav) plan.spine_duration_s = r6(await wavSeconds(opts.spineWav));
  if (opts.outFile) {
    fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
    fs.writeFileSync(opts.outFile, JSON.stringify(plan, null, 2));
  }
  return plan;
}
