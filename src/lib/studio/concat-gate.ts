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
  /** MULTISHOT_WIRE: multi-shot renders — when a segment covers shots
   *  [A,B], ONE mp4 {A}-{B}.mp4 must carry the pair's summed frame count
   *  (chained multishot shots quantise to the 17-frame grid, so the expected
   *  count is the sum of each shot's own snapped frames). Shots not covered
   *  by any segment keep the per-shot check. */
  segments?: { shots: string[]; frames?: number; perShot?: number; kind?: string }[];
}): Promise<GateResult> {
  const { plan, motionDir } = opts;
  const shots = plan.shots ?? [];
  const fail = (reason: string): GateResult => ({ ok: false, reason });

  if (!shots.length) return fail("cut_plan has no shots");
  const segOf = new Map<string, string[]>();
  for (const seg of opts.segments ?? []) {
    for (const id of seg.shots) segOf.set(id, seg.shots);
  }
  const checked = new Set<string>();
  for (const shot of shots) {
    if (!fs.existsSync(shot.wav)) return fail(`missing slice ${shot.wav}`);
    const got = await wavSeconds(shot.wav);
    if (Math.abs(got - shot.duration_s) > FRAME_TOL) {
      return fail(`shot ${shot.id}: 退回阿聲 — ${path.basename(shot.wav)} ${got.toFixed(6)}s != locked ${shot.duration_s.toFixed(6)}s`);
    }
    const seg = segOf.get(shot.id);
    const fileId = seg ? seg.join("-") : shot.id;
    if (checked.has(fileId)) continue; // one probe per file, frames summed across its shots
    checked.add(fileId);
    const mp4 = path.join(motionDir, `${fileId}.mp4`);
    if (!fs.existsSync(mp4)) return fail(`missing ${mp4}`);
    const frameIds = seg ?? [shot.id];
    const marked = (opts.segments ?? []).find((s) => s.shots.join("-") === fileId);
    const snapped = frameIds.map((id) => snapDurationToFrames(shots.find((s) => s.id === id)?.duration_s ?? 0));
    const uniform = Math.max(...snapped);
    const frames = marked?.kind === "multishot"
      ? uniform * snapped.length
      : marked?.kind === "cform" && snapped.length > 1
        ? snapped[0]! + Math.max(...snapped.slice(1)) * (snapped.length - 1)
        : snapped.reduce((a, n) => a + n, 0);
    if (marked?.frames !== undefined && marked.frames !== frames) {
      return fail(`${fileId}: manifest frames ${marked.frames} != planned grid budget ${frames}`);
    }
    if (marked?.perShot !== undefined && marked.perShot !== uniform) {
      return fail(`${fileId}: manifest perShot ${marked.perShot} != planned grid ${uniform}`);
    }
    const probe = await probeVideo(mp4);
    if (probe.nbFrames !== frames) {
      return fail(`${fileId}: ${mp4} has ${probe.nbFrames} frames != summed wav snap ${frames}`);
    }
    if (probe.frameRate !== "24/1") {
      return fail(`${fileId}: r_frame_rate ${probe.frameRate} != 24/1`);
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
