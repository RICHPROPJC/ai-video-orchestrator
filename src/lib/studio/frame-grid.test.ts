import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { writeWav } from "./audio";

test("snap receipts (ceil, 17k+5, k∈[7,21])", () => {
  assert.equal(snapDurationToFrames(10.8), 260); // shotdag shots/01 receipt (10.8 s wav → 260 f)
  assert.equal(snapDurationToFrames(12.92), 311); // v6 receipt wav (PROVENANCE: shingx-proof 12.92 s → 311 f)
  assert.equal(snapDurationToFrames(12.96), 328); // 12.96 s is past the 311 boundary (311/24 = 12.9583…)
  assert.equal(snapDurationToFrames(8.12), 209);
  assert.equal(snapDurationToFrames(1), 124);
  assert.equal(snapDurationToFrames(60), 362);
});

test("wavSeconds reads a canonical PCM wav", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-fg-"));
  const file = path.join(dir, "s.wav");
  writeWav(file, new Float32Array(22050 * 2), 22050);
  const sec = await wavSeconds(file);
  assert.ok(Math.abs(sec - 2.0) < 1e-6, `got ${sec}`);
});

test("wavSeconds walks past a LIST chunk before data", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-fg-"));
  const file = path.join(dir, "s.wav");
  writeWav(file, new Float32Array(22050 * 2), 22050);
  const plain = fs.readFileSync(file);
  const list = Buffer.alloc(12); // "LIST" + size 4 + payload "INFO"
  list.write("LIST", 0);
  list.writeUInt32LE(4, 4);
  list.write("INFO", 8);
  const withList = path.join(dir, "list.wav");
  fs.writeFileSync(withList, Buffer.concat([plain.subarray(0, 12), list, plain.subarray(12)]));
  const sec = await wavSeconds(withList);
  assert.ok(Math.abs(sec - 2.0) < 1e-6, `got ${sec}`);
});
