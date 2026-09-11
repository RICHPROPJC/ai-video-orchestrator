import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand, writeWav } from "./audio";
import { buildCutPlan } from "./cut-plan";
import { checkGate } from "./concat-gate";
import { snapDurationToFrames } from "./frame-grid";

async function ffmpeg(args: string[]) {
  const r = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (r.code !== 0) throw new Error(r.stderr || "ffmpeg failed");
}

async function lavfiMp4(dir: string, id: string, frames: number) {
  const out = path.join(dir, `${id}.mp4`);
  await ffmpeg([
    "-f", "lavfi", "-i", `color=c=gray:s=864x480:r=24`,
    "-frames:v", String(frames), "-c:v", "libx264", "-pix_fmt", "yuv420p", out,
  ]);
  return out;
}

async function twoSlices() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-cg-"));
  writeWav(path.join(dir, "SH01.wav"), new Float32Array(22050 * 2), 22050); // 2.0 s
  writeWav(path.join(dir, "SH02.wav"), new Float32Array(22050 * 3.5), 22050); // 3.5 s
  await lavfiMp4(dir, "SH01", snapDurationToFrames(2.0));
  await lavfiMp4(dir, "SH02", snapDurationToFrames(3.5));
  return dir;
}

test("two slices + snapped lavfi mp4s gate ok", async () => {
  const dir = await twoSlices();
  const plan = await buildCutPlan({ cut: ["SH01", "SH02"], wavDir: dir, gapSec: 0 });
  assert.equal(plan.shots.length, 2);
  assert.ok(Math.abs(plan.shots[0]!.duration_s - 2.0) < 1e-6);
  assert.ok(Math.abs(plan.shots[1]!.duration_s - 3.5) < 1e-6);
  const gate = await checkGate({ plan, motionDir: dir });
  assert.deepEqual(gate, { ok: true, reason: "ok" });
});

test("a slice trimmed 0.2 s fails with the shot named", async () => {
  const dir = await twoSlices();
  const plan = await buildCutPlan({ cut: ["SH01", "SH02"], wavDir: dir, gapSec: 0 });
  writeWav(path.join(dir, "SH01.wav"), new Float32Array(22050 * 1.8), 22050); // trimmed
  const gate = await checkGate({ plan, motionDir: dir });
  assert.equal(gate.ok, false);
  assert.ok(gate.reason?.includes("SH01"), gate.reason);
});

test("mp4 one frame short fails", async () => {
  const dir = await twoSlices();
  await lavfiMp4(dir, "SH02", snapDurationToFrames(3.5) - 1);
  const plan = await buildCutPlan({ cut: ["SH01", "SH02"], wavDir: dir, gapSec: 0 });
  const gate = await checkGate({ plan, motionDir: dir });
  assert.equal(gate.ok, false);
  assert.ok(gate.reason?.includes("SH02"), gate.reason);
});

test("spine off by 0.5 s fails", async () => {
  const dir = await twoSlices();
  writeWav(path.join(dir, "spine.wav"), new Float32Array(22050 * 6.0), 22050); // real sum is 5.5 s
  const plan = await buildCutPlan({ cut: ["SH01", "SH02"], wavDir: dir, gapSec: 0 });
  const gate = await checkGate({ plan, motionDir: dir, spineWav: path.join(dir, "spine.wav") });
  assert.equal(gate.ok, false);
  assert.ok(gate.reason?.includes("clock"), gate.reason);
});
