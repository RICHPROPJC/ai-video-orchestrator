/** PictureQc席unit test——測核心函數 */

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import fs from "node:fs";
import path from "node:path";
import { computeSliceBounds, motionClipRequire } from "./pictureQc";

// ── computeSliceBounds ──
nodeTest.test("solo shot：一個slice佔全部", () => {
  const b = computeSliceBounds({
    segShots: ["SH01"], isMultishot: false,
    anchorFrames: 124, perShotFrames: 0, chainedFrames: 0,
  });
  assert.equal(b.length, 1);
  assert.equal(b[0].start, 0);
  assert.equal(b[0].len, 124);
});

nodeTest.test("chain（1 anchor + 2 chain）：anchor幀數+chain各同幀數", () => {
  const b = computeSliceBounds({
    segShots: ["SH01", "SH02", "SH03"], isMultishot: false,
    anchorFrames: 124, perShotFrames: 0, chainedFrames: 56,
  });
  assert.equal(b.length, 3);
  assert.equal(b[0].len, 124); // anchor
  assert.equal(b[1].len, 56);  // chain 1
  assert.equal(b[2].len, 56);  // chain 2
  assert.equal(b[1].start, 124);
  assert.equal(b[2].start, 180);
});

nodeTest.test("multishot：每shot同幀數", () => {
  const b = computeSliceBounds({
    segShots: ["SH01", "SH02", "SH03"], isMultishot: true,
    anchorFrames: 0, perShotFrames: 90, chainedFrames: 0,
  });
  assert.equal(b.length, 3);
  for (const s of b) assert.equal(s.len, 90);
});

// ── motionClipRequire ──
nodeTest.test("motionClipRequire保留keyframe keys但改action", () => {
  const base = {
    people_count: 1,
    action: "freeze line: standing still",
    grey_blocks: false,
    location: "kitchen",
  };
  const shot = { action: "walking to table and picking up can", dialogue: "hello" };
  const result = motionClipRequire(base, shot);
  assert.equal(result.action, shot.action);
  assert.equal(result.people_count, 1);
  assert.equal(result.grey_blocks, false);
  assert.equal(result.location, "kitchen");
});

nodeTest.test("motionClipRequire冇shot時返回原样", () => {
  const base = { action: "test", foo: "bar" };
  assert.deepEqual(motionClipRequire(base, undefined), base);
});

// ── WIST實際QC數據 ──
nodeTest.test("WIST有motion mp4可以對照QC狀態", () => {
  const motionDir = "data/jobs/SC-0913-WIST/motion";
  const qcFiles = fs.readdirSync(motionDir).filter(f => f.includes("video_qc"));
  // WIST有7個mp4，可能有對應QC json
  const mp4s = fs.readdirSync(motionDir).filter(f => f.endsWith(".mp4"));
  assert.equal(mp4s.length, 7, "WIST 7個mp4");
  // QC files可能唔存在（--until motion停咗）
  // 呢個test只驗證mp4存在
});
