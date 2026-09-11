import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./audio";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import type { CutPlan } from "./cut-plan";

const FRAME_TOL = 1 / 24;

async function probeVideo(file: string): Promise<{ nbFrames: number; frameRate: string }> {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=nb_frames,r_frame_rate",
    "-of", "json", file,
  ]);
  if (r.code !== 0) throw new Error(r.stderr || `ffprobe failed on ${file}`);
  const st = (JSON.parse(r.stdout).streams ?? [])[0] as
    | { nb_frames?: string; r_frame_rate?: string }
    | undefined;
  if (!st?.nb_frames || !st.r_frame_rate) throw new Error(`ffprobe: no stream facts for ${file}`);
  return { nbFrames: Number(st.nb_frames), frameRate: st.r_frame_rate };
}

export type GateResult = { ok: boolean; reason?: string };

/** machine gate before concat: real wav clocks must match the plan, every cut id
 *  must have a motion mp4 whose stream says exactly the snapped frame count at
 *  24 fps, no overlaps, and (when a spine exists) the clock must close. */
export async function checkGate(opts: {
  plan: CutPlan;
  motionDir: string;
  spineWav?: string;
  outFile?: string;
}): Promise<GateResult> {
  const { plan, motionDir } = opts;
  const shots = plan.shots ?? [];
  const fail = (reason: string): GateResult => ({ ok: false, reason });

  if (!shots.length) return fail("cut_plan has no shots");
  for (const shot of shots) {
    const mp4 = path.join(motionDir, `${shot.id}.mp4`);
    if (!fs.existsSync(mp4)) return fail(`missing ${mp4}`);
    if (!fs.existsSync(shot.wav)) return fail(`missing slice ${shot.wav}`);
    const got = await wavSeconds(shot.wav);
    if (Math.abs(got - shot.duration_s) > FRAME_TOL) {
      return fail(`shot ${shot.id}: ${path.basename(shot.wav)} ${got.toFixed(6)}s != plan ${shot.duration_s.toFixed(6)}s`);
    }
    const frames = snapDurationToFrames(got);
    const probe = await probeVideo(mp4);
    if (probe.nbFrames !== frames) {
      return fail(`shot ${shot.id}: ${mp4} has ${probe.nbFrames} frames != wav snap ${frames}`);
    }
    if (probe.frameRate !== "24/1") {
      return fail(`shot ${shot.id}: r_frame_rate ${probe.frameRate} != 24/1`);
    }
  }
  let prevEnd = -1;
  for (const shot of shots) {
    if (shot.start_s < prevEnd - 1e-9) {
      return fail(`overlapping shots: ${shot.id} start=${shot.start_s} prev_end=${prevEnd}`);
    }
    if (shot.end_s <= shot.start_s) return fail(`non-positive duration: shot ${shot.id}`);
    prevEnd = shot.end_s;
  }
  if (opts.spineWav) {
    const spineSec = await wavSeconds(opts.spineWav);
    const shotSum = shots.reduce((a, s) => a + s.duration_s, 0);
    const expected = shotSum + plan.gap_s * Math.max(0, shots.length - 1);
    if (Math.abs(expected - spineSec) > FRAME_TOL) {
      return fail(
        `clock: sum(shots)=${shotSum.toFixed(6)}s + gaps=${plan.gap_s}s*${shots.length - 1} ` +
          `= ${expected.toFixed(6)}s != spine.wav ${spineSec.toFixed(6)}s`,
      );
    }
    if (plan.spine_duration_s != null && Math.abs(spineSec - plan.spine_duration_s) > FRAME_TOL) {
      return fail(`spine.wav ${spineSec.toFixed(6)}s != cut_plan spine ${plan.spine_duration_s.toFixed(6)}s`);
    }
  }
  const result: GateResult = { ok: true, reason: "ok" };
  if (opts.outFile) {
    fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
    fs.writeFileSync(
      opts.outFile,
      JSON.stringify({ ...result, motionDir, spine: opts.spineWav ?? null, shots: shots.length }, null, 2),
    );
  }
  return result;
}
