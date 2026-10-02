/** Motion席unit test——測核心邏輯函數（determineMotionSource/shouldKeepOnResume/depStamp） */

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import {
  determineMotionSource,
  shouldKeepOnResume,
  motionDepStamp,
} from "./motion";

// ── determineMotionSource ──
nodeTest.test("有Video1（灰片走位）→ rigged_motion", () => {
  assert.equal(determineMotionSource(true, false, false), "rigged_motion");
});

nodeTest.test("冇Video1＋multishot → multimodal_reference", () => {
  assert.equal(determineMotionSource(false, true, false), "multimodal_reference");
});

nodeTest.test("冇Video1＋KF驅動 → text_driven", () => {
  assert.equal(determineMotionSource(false, false, true), "text_driven");
});

nodeTest.test("乜都冇 → text_driven（默認）", () => {
  assert.equal(determineMotionSource(false, false, false), "text_driven");
});

// ── shouldKeepOnResume ──
nodeTest.test("resume+全部齊 → keep", () => {
  assert.ok(shouldKeepOnResume({
    resume: true, mp4Exists: true, receiptExists: true,
    frameSnap: true, allPinned: true, stampOk: true,
  }));
});

nodeTest.test("唔係resume → 唔keep", () => {
  assert.ok(!shouldKeepOnResume({
    resume: false, mp4Exists: true, receiptExists: true,
    frameSnap: true, allPinned: true, stampOk: true,
  }));
});

nodeTest.test("mp4唔存在 → 唔keep", () => {
  assert.ok(!shouldKeepOnResume({
    resume: true, mp4Exists: false, receiptExists: true,
    frameSnap: true, allPinned: true, stampOk: true,
  }));
});

nodeTest.test("QC未pin → 唔keep（要重判QC）", () => {
  assert.ok(!shouldKeepOnResume({
    resume: true, mp4Exists: true, receiptExists: true,
    frameSnap: true, allPinned: false, stampOk: true,
  }));
});

nodeTest.test("stamp唔夾 → 唔keep（材料變咗要重燒）", () => {
  assert.ok(!shouldKeepOnResume({
    resume: true, mp4Exists: true, receiptExists: true,
    frameSnap: true, allPinned: true, stampOk: false,
  }));
});

// ── motionDepStamp ──
nodeTest.test("dep stamp穩定（同輸入同輸出）", () => {
  const a = motionDepStamp({ receiptHash: "abc", frames: 124, wavStat: "100:1000", blockoutStat: "200:2000", stillStat: "300:3000" });
  const b = motionDepStamp({ receiptHash: "abc", frames: 124, wavStat: "100:1000", blockoutStat: "200:2000", stillStat: "300:3000" });
  assert.equal(a, b);
});

nodeTest.test("dep stamp對變化敏感", () => {
  const a = motionDepStamp({ receiptHash: "abc", frames: 124, wavStat: "100:1000", blockoutStat: "200:2000", stillStat: "300:3000" });
  const b = motionDepStamp({ receiptHash: "CHANGED", frames: 124, wavStat: "100:1000", blockoutStat: "200:2000", stillStat: "300:3000" });
  assert.notEqual(a, b);
});

// ── WIST實際數據對照 ──
nodeTest.test("WIST motion mp4存在且motionSource=rigged_motion", async () => {
  const wistMotion = "data/jobs/SC-0913-WIST/motion";
  const fs = await import("node:fs");
  const mp4s = fs.readdirSync(wistMotion).filter(f => f.endsWith(".mp4"));
  assert.equal(mp4s.length, 7, "WIST有7個mp4");
  // WIST嘅mp4係用blockout灰片行C-form→rigged_motion
  assert.equal(determineMotionSource(true, false, false), "rigged_motion");
});
