import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWav } from "./audio";
import { muxArgs, padH3Wav } from "./pipeline";
import { wavSeconds } from "./frame-grid";

test("padH3Wav pads a 2.0s wav to the snapped 124-frame clock (±1/48)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pad-"));
  const src = path.join(dir, "SH01.wav");
  const dst = path.join(dir, "SH01.h3.wav");
  writeWav(src, new Float32Array(22050 * 2), 22050); // 2.0 s → 124 f
  const got = await padH3Wav(src, dst, 124);
  assert.ok(Math.abs(got - 124 / 24) <= 1 / 48, `padded ${got}s`);
  const onDisk = await wavSeconds(dst);
  assert.ok(Math.abs(onDisk - 124 / 24) <= 1 / 48, `on disk ${onDisk}s`);
});

test("padH3Wav lands exactly on a longer clock (243f = 10.125s)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pad2-"));
  const src = path.join(dir, "SH01.wav");
  writeWav(src, new Float32Array(22050 * 2), 22050);
  const got = await padH3Wav(src, path.join(dir, "out.wav"), 243);
  assert.ok(Math.abs(got - 10.125) <= 1 / 48, `padded ${got}s`);
});

test("mux args level-match the padded wav and never apad", () => {
  const args = muxArgs("/m/SH01.mp4", "/a/SH01.h3.wav", "/m/SH01.muxed.mp4");
  assert.ok(args.includes("loudnorm=I=-18:TP=-1.5:LRA=11"), "loudnorm present");
  assert.ok(args.includes("-b:a") && args[args.indexOf("-b:a") + 1] === "128k", "aac 128k");
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("-shortest"));
  assert.ok(!args.includes("apad"), "apad dropped — wav is already padded");
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 4), ["-i", "/m/SH01.mp4", "-i", "/a/SH01.h3.wav"]);
});
