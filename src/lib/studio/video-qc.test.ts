import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { pickMotionFrameIndices } from "./motion-frames";
import {
  judgeVideoFrames,
  motionReadyAllowed,
  pinVideoQcAccepted,
  runVideoQc,
  writeVideoQcFromRecordings,
} from "./video-qc";
import type { QcRequire } from "./photo-qc";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const WIST_REQUIRE: QcRequire = { people_count: 1, grey_blocks: false };

test("pickMotionFrameIndices: first, mid, last, every 2s at 24fps", () => {
  const idx = pickMotionFrameIndices(124, 24);
  assert.ok(idx.includes(0));
  assert.ok(idx.includes(61));
  assert.ok(idx.includes(123));
  assert.ok(idx.includes(48));
  assert.ok(idx.includes(96));
});

test("WIST SH01 kfend + sheet location also FAIL location (S2)", () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "video-qc-fixtures/wist-sh01-kfend.json"), "utf8"),
  ) as {
    frames: Array<{ frame: number; t_s: number; file: string; blind: string; summary: Record<string, unknown> }>;
  };
  const repo = path.resolve(__dirname, "../../../..");
  const frames = fx.frames.map((f) => ({
    frame: f.frame,
    t_s: f.t_s,
    file: path.join(repo, "data/jobs/SC-0913-WIST", f.file),
    blind: f.blind,
    summary: f.summary,
  }));
  const tea = judgeVideoFrames(frames, {
    people_count: 1,
    grey_blocks: false,
    location: "茶餐廳卡位",
    action: "坐低",
  });
  assert.equal(tea.status, "FAIL");
  assert.ok(tea.checks.fail_reasons.some((r) => r.includes("grey_blocks")));
  assert.ok(tea.checks.fail_reasons.some((r) => r.includes("location:")));
  const morgue = judgeVideoFrames(frames, {
    people_count: 1,
    grey_blocks: false,
    location: "首都地下停屍間",
    action: "重生者喺鋼床掙扎坐起",
    size: "medium",
  });
  assert.equal(morgue.status, "FAIL");
  assert.ok(morgue.checks.fail_reasons.some((r) => r.includes("location:")));
  assert.ok(morgue.checks.fail_reasons.some((r) => r.includes("action:")));
});

test("WIST SH01 kfend recordings FAIL grey_blocks (fixture, no network)", () => {
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "video-qc-fixtures/wist-sh01-kfend.json"), "utf8"),
  ) as {
    require: QcRequire;
    frames: Array<{ frame: number; t_s: number; file: string; blind: string; summary: Record<string, unknown> }>;
  };
  const repo = path.resolve(__dirname, "../../../..");
  const judged = judgeVideoFrames(
    fx.frames.map((f) => ({
      frame: f.frame,
      t_s: f.t_s,
      file: path.join(repo, "data/jobs/SC-0913-WIST", f.file),
      blind: f.blind,
      summary: f.summary,
    })),
    fx.require,
  );
  assert.equal(judged.status, "FAIL");
  assert.ok(
    judged.checks.fail_reasons.some((r) => r.includes("grey_blocks")),
    judged.checks.fail_reasons.join(" | "),
  );
  assert.ok(judged.frames.every((f) => f.status === "FAIL"));
});

test("writeVideoQcFromRecordings writes motion/SH01.video_qc.json FAIL", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-"));
  const mp4 = path.join(dir, "SH01.mp4");
  fs.writeFileSync(mp4, Buffer.from("fake-mp4"));
  const fx = JSON.parse(
    fs.readFileSync(path.join(__dirname, "video-qc-fixtures/wist-sh01-kfend.json"), "utf8"),
  );
  const outJson = path.join(dir, "SH01.video_qc.json");
  const record = writeVideoQcFromRecordings({
    mp4,
    outJson,
    require: fx.require,
    frames: fx.frames.map(
      (f: { frame: number; t_s: number; file: string; blind: string; summary: Record<string, unknown> }) => ({
        frame: f.frame,
        t_s: f.t_s,
        file: path.join(dir, path.basename(f.file)),
        blind: f.blind,
        summary: f.summary,
      }),
    ),
  });
  assert.equal(record.status, "FAIL");
  assert.equal(record.tool, "slatecrew.video_qc");
  assert.ok(fs.existsSync(outJson));
});

test("pinVideoQcAccepted: GREEN + sha match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-pin-"));
  const mp4 = path.join(dir, "SH01.mp4");
  const bytes = Buffer.from("mp4-fixture");
  fs.writeFileSync(mp4, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(
    path.join(dir, "SH01.video_qc.json"),
    JSON.stringify({
      tool: "slatecrew.video_qc",
      status: "GREEN",
      sha256: sha,
      require: WIST_REQUIRE,
      frames: [],
      checks: { status: "GREEN", fail_reasons: [] },
    }),
  );
  assert.equal(pinVideoQcAccepted(dir, "SH01"), true);
});

test("pinVideoQcAccepted: FAIL or missing qc is false", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-pin2-"));
  fs.writeFileSync(path.join(dir, "SH01.mp4"), Buffer.from("x"));
  fs.writeFileSync(
    path.join(dir, "SH01.video_qc.json"),
    JSON.stringify({ tool: "slatecrew.video_qc", status: "FAIL", require: WIST_REQUIRE, sha256: "dead" }),
  );
  assert.equal(pinVideoQcAccepted(dir, "SH01"), false);
});

test("motionReadyAllowed: missing or FAIL json blocks; GREEN+sha allows", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-ready-"));
  assert.equal(motionReadyAllowed(dir, []), false);
  assert.equal(motionReadyAllowed(dir, ["SH01"]), false);
  const bytes = Buffer.from("mp4-c2");
  fs.writeFileSync(path.join(dir, "SH01.mp4"), bytes);
  fs.writeFileSync(
    path.join(dir, "SH01.video_qc.json"),
    JSON.stringify({
      tool: "slatecrew.video_qc",
      status: "FAIL",
      sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
      require: { people_count: 1, grey_blocks: false, location: "首都地下停屍間" },
    }),
  );
  assert.equal(motionReadyAllowed(dir, ["SH01"]), false);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(
    path.join(dir, "SH01.video_qc.json"),
    JSON.stringify({
      tool: "slatecrew.video_qc",
      status: "GREEN",
      sha256: sha,
      require: { people_count: 1, grey_blocks: false, location: "首都地下停屍間" },
    }),
  );
  assert.equal(motionReadyAllowed(dir, ["SH01"]), true);
  assert.equal(motionReadyAllowed(dir, ["SH01", "SH02"]), false);
});

test("runVideoQc live on WIST kfend frames when MARS_URL is set", async () => {
  if (!process.env.MARS_URL?.trim()) {
    console.log("# skip live MARS — MARS_URL unset");
    return;
  }
  const repo = path.resolve(__dirname, "../../../..");
  const jobDir = path.join(repo, "data/jobs/SC-0913-WIST");
  const mp4 = path.join(jobDir, "motion/SH01.mp4");
  if (!fs.existsSync(mp4)) {
    console.log("# skip live MARS — SH01.mp4 missing");
    return;
  }
  const outJson = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-live-")), "SH01.video_qc.json");
  const record = await runVideoQc({
    mp4,
    outJson,
    require: WIST_REQUIRE,
    shotId: "SH01",
  });
  assert.equal(record.status, "FAIL");
  assert.ok(record.checks.fail_reasons.some((r) => r.includes("grey_blocks")));
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
