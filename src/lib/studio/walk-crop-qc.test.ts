import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { judgeWalkCrop, WALK_CROP_RULE } from "./walk-crop-qc";
import { gateVideoWithWalkCrop } from "./video-qc";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

test("Flash Lite cropped head on full-body intent FAILs; CU crop is allowed", () => {
  const cropped = judgeWalkCrop({
    intent: { size: "full" },
    boxes: [{ top: 0.4, bottom: 0.98, left: 0.3, right: 0.7 }],
  });
  assert.equal(cropped.status, "FAIL");
  assert.equal(cropped.rule, WALK_CROP_RULE);
  assert.ok(cropped.fail_reasons.some((r) => r.startsWith("cropped_head")));

  const cu = judgeWalkCrop({
    intent: { size: "closeup" },
    boxes: [{ top: 0.0, bottom: 0.45, left: 0.25, right: 0.75 }],
  });
  assert.equal(cu.status, "GREEN");
});

test("Flash Lite sliding man FAILs; alternate plant + displacement passes", () => {
  const slide = [0, 0.1, 0.2, 0.3].map((x, i) => ({
    t: i,
    rootX: x,
    footL: { x, y: 0.9 },
    footR: { x, y: 0.9 },
  }));
  const sliding = judgeWalkCrop({ intent: { size: "full", gait: "walk" }, walk: slide, boxes: [{ top: 0.05, bottom: 0.95, left: 0.2, right: 0.8 }] });
  assert.equal(sliding.status, "FAIL");
  assert.ok(sliding.fail_reasons.some((r) => r.startsWith("sliding_root")));

  const gait = [
    { t: 0, rootX: 0.2, footL: { x: 0.18, y: 0.92 }, footR: { x: 0.22, y: 0.88 } },
    { t: 1, rootX: 0.3, footL: { x: 0.18, y: 0.92 }, footR: { x: 0.32, y: 0.88 } },
    { t: 2, rootX: 0.4, footL: { x: 0.38, y: 0.88 }, footR: { x: 0.32, y: 0.92 } },
    { t: 3, rootX: 0.5, footL: { x: 0.48, y: 0.88 }, footR: { x: 0.32, y: 0.92 } },
  ];
  const ok = judgeWalkCrop({ intent: { size: "full", gait: "walk" }, walk: gait, boxes: [{ top: 0.05, bottom: 0.95, left: 0.2, right: 0.8 }] });
  assert.equal(ok.status, "GREEN", ok.fail_reasons.join("|"));
});

test("Flash Lite camera order FAILs; matching order passes", () => {
  const bad = judgeWalkCrop({
    intent: { size: "medium", cameraOrder: ["wide", "medium", "close"] },
    cameras: ["close", "wide", "medium"],
  });
  assert.equal(bad.status, "FAIL");
  assert.ok(bad.fail_reasons.some((r) => r.startsWith("camera_order")));
  const good = judgeWalkCrop({
    intent: { size: "medium", cameraOrder: ["wide", "medium", "close"] },
    cameras: ["wide", "medium", "close"],
  });
  assert.equal(good.status, "GREEN");
});

test("missing walk/crop/camera evidence is FAIL not PASS", () => {
  const miss = judgeWalkCrop({ intent: { size: "full", gait: "walk", cameraOrder: ["wide"] } });
  assert.equal(miss.status, "FAIL");
  assert.ok(miss.fail_reasons.some((r) => r.includes("missing_crop_evidence")));
  assert.ok(miss.fail_reasons.some((r) => r.includes("missing_walk_evidence")));
  assert.ok(miss.fail_reasons.some((r) => r.includes("missing_camera_evidence")));
});

test("video_qc gate turns an otherwise GREEN clip FAIL on cropped head", () => {
  const judged = { status: "GREEN" as const, frames: [], checks: { status: "GREEN", fail_reasons: [] as string[] } };
  const out = gateVideoWithWalkCrop(judged, {
    intent: { size: "full" },
    boxes: [{ top: 0.5, bottom: 0.99, left: 0.2, right: 0.8 }],
  });
  assert.equal(out.status, "FAIL");
  assert.ok(out.checks.fail_reasons.some((r) => r.includes("cropped_head")));
});

if (bareBun) {
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
