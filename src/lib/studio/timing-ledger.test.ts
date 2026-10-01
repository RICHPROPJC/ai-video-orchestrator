import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Use a temp cwd so writes land outside the real repo (dataRoot = cwd/data/jobs)
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "timing-ledger-test-"));
process.chdir(tmpRoot);
const ledgerDir = (id: string) => path.join(tmpRoot, "data", "jobs", id);

test("writeTimingLedger writes timing.json with grid-snapped frames", async () => {
  const { writeTimingLedger } = await import("./timing-ledger");
  const jobId = "SC-TEST-LEDGER";
  const shots = [
    { id: "SH01", durationSec: 2.33 },
    { id: "SH02", durationSec: 5.17 },
  ];
  const ledger = writeTimingLedger(jobId, shots);

  assert.equal(ledger.version, 1);
  assert.equal(ledger.fps, 24);
  assert.equal(ledger.shots.length, 2);
  // 2.33s snaps to 17k+5 → k=3 → 56 frames
  assert.equal(ledger.shots[0].frames, 56);
  assert.ok(Math.abs(ledger.shots[0].genSec - 56 / 24) < 1e-9);
  // 5.17s snaps to k=8 → 17*8+5 = 141 frames
  assert.equal(ledger.shots[1].frames, 141);
  assert.ok(ledger.totalFrames > 0);
  assert.ok(Math.abs(ledger.totalStorySec - 7.5) < 1e-6);

  const onDisk = JSON.parse(
    fs.readFileSync(path.join(ledgerDir(jobId), "timing.json"), "utf8"),
  );
  assert.equal(onDisk.totalFrames, ledger.totalFrames);
});

test("readTimingLedger round-trips", async () => {
  const { writeTimingLedger, readTimingLedger } = await import(
    "./timing-ledger"
  );
  const jobId = "SC-TEST-LEDGER-2";
  writeTimingLedger(jobId, [{ id: "SH01", durationSec: 2.5 }]);
  const loaded = readTimingLedger(jobId);
  assert.ok(loaded);
  assert.equal(loaded.shots[0].id, "SH01");
  assert.equal(readTimingLedger("SC-DOES-NOT-EXIST"), null);
});

test("cut-plan throws timing_ledger when lockedSec missing (no wav fallback)", async () => {
  const { buildCutPlan } = await import("./cut-plan");
  const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), "wav-test-"));
  // Write a tiny valid wav so the old path would have succeeded
  const wavPath = path.join(wavDir, "SH01.wav");
  // Minimal PCM WAV: 44-byte header + 1 second of silence at 16kHz mono 16-bit
  const rate = 16000;
  const data = Buffer.alloc(rate * 2, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(wavPath, Buffer.concat([header, data]));

  await assert.rejects(
    () =>
      buildCutPlan({ cut: ["SH01"], wavDir, outFile: path.join(tmpRoot, "cp.json") }),
    /timing_ledger:/,
  );

  // With allowWavFallback, it should succeed
  const plan = await buildCutPlan({
    cut: ["SH01"],
    wavDir,
    allowWavFallback: true,
  });
  assert.equal(plan.shots.length, 1);
  assert.ok(plan.shots[0].duration_s > 0.9);
});

test("cut-plan accepts lockedSec and snaps nothing (story clock wins)", async () => {
  const { buildCutPlan } = await import("./cut-plan");
  const wavDir = fs.mkdtempSync(path.join(os.tmpdir(), "wav-test-2"));
  const rate = 16000;
  const data = Buffer.alloc(rate * 2, 0);
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(path.join(wavDir, "SH01.wav"), Buffer.concat([header, data]));

  const plan = await buildCutPlan({
    cut: ["SH01"],
    wavDir,
    lockedSec: { SH01: 3.5 },
  });
  assert.equal(plan.shots[0].duration_s, 3.5);
});

test.after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});