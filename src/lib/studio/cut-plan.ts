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

/** cut plan from the continuity cut order + the wav plug: durations are the
 *  real wav clocks, never the plan estimate. Writes cut_plan.json when outFile given. */
export async function buildCutPlan(opts: {
  cut: string[];
  wavDir: string;
  gapSec?: number;
  spineWav?: string;
  outFile?: string;
}): Promise<CutPlan> {
  const gap = opts.gapSec ?? 0;
  const shots: CutPlanShot[] = [];
  let t = 0;
  for (const id of opts.cut) {
    const wav = path.join(opts.wavDir, `${id}.wav`);
    if (!fs.existsSync(wav)) throw new Error(`missing wav slice ${wav}`);
    const duration = await wavSeconds(wav);
    shots.push({
      id,
      start_s: r6(t),
      end_s: r6(t + duration),
      duration_s: r6(duration),
      wav,
    });
    t += duration + gap;
  }
  const plan: CutPlan = { gap_s: gap, shots };
  if (opts.spineWav) plan.spine_duration_s = r6(await wavSeconds(opts.spineWav));
  if (opts.outFile) {
    fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
    fs.writeFileSync(opts.outFile, JSON.stringify(plan, null, 2));
  }
  return plan;
}
