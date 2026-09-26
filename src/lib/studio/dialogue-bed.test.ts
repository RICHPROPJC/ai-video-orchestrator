import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { peakAndSilence, readWavMono, writeWav } from "./audio";
import { layDialogueBed } from "./dialogue-bed";
import { wavSeconds } from "./frame-grid";

test("bed fills the locked clock and keeps the line on top", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-bed-"));
  const silent = path.join(dir, "silent.wav");
  const line = path.join(dir, "line.wav");
  writeWav(silent, new Float32Array(22050), 22050);
  const tone = new Float32Array(24000);
  for (let i = 0; i < tone.length; i += 1) tone[i] = Math.sin((2 * Math.PI * 440 * i) / 24000) * 0.4;
  writeWav(line, tone, 24000);
  const a = path.join(dir, "SH01.wav");
  const b = path.join(dir, "SH02.wav");
  await layDialogueBed({
    workDir: path.join(dir, "work"),
    segments: [
      { id: "SH01", take: silent, out: a, seconds: 2 },
      { id: "SH02", take: line, out: b, seconds: 2.333333 },
    ],
  });
  const aSec = await wavSeconds(a);
  const bSec = await wavSeconds(b);
  assert.ok(Math.abs(aSec - 2) <= 1 / 48, `SH01 ${aSec}`);
  assert.ok(Math.abs(bSec - 56000 / 24000) <= 1 / 48, `SH02 ${bSec}`);
  const bed = peakAndSilence(readWavMono(a).samples);
  assert.ok(bed.peak > 0.05, `bed peak ${bed.peak}`);
  assert.ok(bed.silenceRatio < 0.55, `bed holes ${bed.silenceRatio}`);
  const voiced = peakAndSilence(readWavMono(b).samples);
  assert.ok(voiced.peak > 0.2, `line peak ${voiced.peak}`);
});
