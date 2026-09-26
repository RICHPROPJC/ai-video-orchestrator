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

/** CFORM7B fixture: run7 SH01嘅時序句 — 企定→出拳→轉身側踢→收勢。 */
const CLIP_ACTION =
  "沈北辰喺兩排金屬檔案架之間嘅空地企定，雙手握拳收腰，連環打出兩記右直拳；隨即轉身起左腳側踢，腳刀掃過濕漉地面；落地收勢立正，肩線沉定，眼神堅定望前。";

function beatFrame(frame: number, actionNotes: string) {
  return {
    frame,
    t_s: frame / 24,
    file: `f${frame}.png`,
    blind: actionNotes,
    summary: { people_count: 1, grey_blocks: false, action_notes: actionNotes },
  };
}

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
  assert.ok(tea.checks.fail_reasons.some((r) => r.includes("location")));
  const morgue = judgeVideoFrames(frames, {
    people_count: 1,
    grey_blocks: false,
    location: "首都地下停屍間",
    action: "重生者喺鋼床掙扎坐起",
    size: "medium",
  });
  assert.equal(morgue.status, "FAIL");
  assert.ok(morgue.checks.fail_reasons.some((r) => r.includes("location")));
  assert.ok(morgue.checks.fail_reasons.some((r) => r.includes("action")));
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

test("pinVideoQcAccepted: multishot slice binds parent hash, range, and shot", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-slice-"));
  const parent = path.join(dir, "SH01-SH02.mp4");
  const slice = path.join(dir, "SH02.qc.mp4");
  fs.writeFileSync(parent, Buffer.from("parent-take"));
  fs.writeFileSync(slice, Buffer.from("slice-sh02"));
  const parentSha = crypto.createHash("sha256").update(Buffer.from("parent-take")).digest("hex");
  const sliceSha = crypto.createHash("sha256").update(Buffer.from("slice-sh02")).digest("hex");
  const write = (extra: Record<string, unknown>) => {
    fs.writeFileSync(path.join(dir, "SH02.video_qc.json"), JSON.stringify({
      tool: "slatecrew.video_qc",
      status: "GREEN",
      video: slice,
      sha256: sliceSha,
      require: WIST_REQUIRE,
      parent: { file: parent, sha256: parentSha, shotId: "SH02", start: 73, len: 73 },
      ...extra,
    }));
  };
  write({});
  assert.equal(pinVideoQcAccepted(dir, "SH02"), true);
  write({ status: "FAIL" });
  assert.equal(pinVideoQcAccepted(dir, "SH02"), false);
  write({ parent: { file: parent, sha256: "deadbeef", shotId: "SH02", start: 73, len: 73 } });
  assert.equal(pinVideoQcAccepted(dir, "SH02"), false);
  write({ parent: { file: parent, sha256: parentSha, shotId: "SH01", start: 73, len: 73 } });
  assert.equal(pinVideoQcAccepted(dir, "SH02"), false);
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

test("runVideoQc second eye sees ONE mid frame when MARS_URL + SLATECREW_SECOND_ENDPOINT set", async () => {
  if (!process.env.MARS_URL?.trim() || !process.env.SLATECREW_SECOND_ENDPOINT?.trim()) {
    console.log("# skip live second eye — MARS_URL / SLATECREW_SECOND_ENDPOINT unset");
    return;
  }
  const repo = path.resolve(__dirname, "../../../..");
  const jobDir = path.join(repo, "data/jobs/SC-0913-WIST");
  const mp4 = path.join(jobDir, "motion/SH01.mp4");
  if (!fs.existsSync(mp4)) {
    console.log("# skip live second eye — SH01.mp4 missing");
    return;
  }
  const outJson = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-vqc-se-")), "SH01.video_qc.json");
  const record = await runVideoQc({
    mp4,
    outJson,
    require: WIST_REQUIRE,
    shotId: "SH01",
    secondEndpoint: process.env.SLATECREW_SECOND_ENDPOINT,
    secondModel: process.env.SLATECREW_SECOND_MODEL,
  });
  assert.ok(record.second, "second eye record present");
  const mid = record.frames[Math.floor(record.frames.length / 2)]!.frame;
  assert.equal(record.second.frame, mid, "second eye ran on the mid frame only — no fan-out");
  assert.equal(record.status, "FAIL");
});

test("CFORM7B: action timing sentence judges at clip level — beats split across frames", () => {
  const require: QcRequire = { people_count: 1, grey_blocks: false, action: CLIP_ACTION };
  // run7 SH01 shape: each frame shows ONE beat — per-frame bigram hits stay under need(5)
  const frames = [
    beatFrame(0, "沈北辰企定"),
    beatFrame(48, "打出兩記右直拳"),
    beatFrame(96, "轉身側踢"),
    beatFrame(123, "收勢立正"),
  ];
  const judged = judgeVideoFrames(frames, require);
  assert.equal(judged.status, "GREEN", judged.checks.fail_reasons.join(" | "));
  assert.equal(judged.checks.action, true, "clip-level action gate pooled the take's beats");
  assert.ok(
    judged.frames.every((f) => !("action" in f.checks)),
    "frame gates carry no action key — the sentence is the take's script, not one frame's",
  );
});

test("CFORM7B: clip action still fails when a beat never shows — threshold untouched, require not dropped", () => {
  const require: QcRequire = { people_count: 1, grey_blocks: false, action: CLIP_ACTION };
  const frames = [beatFrame(0, "沈北辰企定"), beatFrame(48, "沈北辰企定"), beatFrame(96, "沈北辰企定")];
  const judged = judgeVideoFrames(frames, require);
  assert.equal(judged.status, "FAIL");
  assert.equal(judged.checks.action, false);
  assert.ok(
    judged.checks.fail_reasons.some((r) => r.startsWith("action(clip):")),
    judged.checks.fail_reasons.join(" | "),
  );
});

/** CFORM7C fixture frame: per-frame notes mirror the live write-up shape. */
function notesFrame(
  frame: number,
  opts: { blind: string; loc: string; size?: string },
) {
  return {
    frame,
    t_s: frame / 24,
    file: `f${frame}.png`,
    blind: opts.blind,
    summary: {
      people_count: 1,
      grey_blocks: false,
      location_notes: opts.loc,
      ...(opts.size ? { size_notes: opts.size } : {}),
    },
  };
}

test("CFORM7C: size+location judge at clip level — run8 SH02 f0 full-inherit and f123 ambiguity pass", () => {
  const require: QcRequire = {
    people_count: 1,
    grey_blocks: false,
    location: "金屬檔案櫃",
    size: "medium",
  };
  // run8 SH02 shape: slice start inherits SH01's full framing; one frame's
  // location write-up hedges in English ("cabinets or server racks")
  const frames = [
    notesFrame(0, { blind: "對稱構圖，兩排金屬儲物櫃走廊延伸", loc: "endless corridor of metal lockers", size: "full" }),
    notesFrame(48, { blind: "中年男人企喺走廊中央", loc: "兩排金屬檔案櫃之間嘅窄走廊", size: "medium" }),
    notesFrame(96, { blind: "男人收拳定神", loc: "深色金屬櫃或檔案架長廊", size: "medium" }),
    notesFrame(123, { blind: "目光掃向深處，眼神銳利", loc: "dark cabinets or server racks", size: "medium" }),
  ];
  const judged = judgeVideoFrames(frames, require);
  assert.equal(judged.status, "GREEN", judged.checks.fail_reasons.join(" | "));
  assert.equal(judged.checks.size, true, "majority medium note wins over the inherited full");
  assert.equal(judged.checks.location, true, "pooled CJK evidence beats one English hedge");
  assert.ok(
    judged.frames.every((f) => !("size" in f.checks || "location" in f.checks)),
    "frame gates carry no size/location keys",
  );
});

test("CFORM7C: location hop still dies — half the take in another set fails, so does a fully wrong set", () => {
  const require: QcRequire = { people_count: 1, grey_blocks: false, location: "金屬檔案櫃" };
  const mixed = [
    notesFrame(0, { blind: "企定", loc: "兩排金屬檔案櫃之間" }),
    notesFrame(48, { blind: "行前", loc: "金屬檔案櫃前" }),
    notesFrame(96, { blind: "坐低", loc: "茶餐廳卡位" }),
    notesFrame(123, { blind: "望枱面", loc: "茶餐廳櫃枱" }),
  ];
  const hop = judgeVideoFrames(mixed, require);
  assert.equal(hop.status, "FAIL");
  assert.equal(hop.checks.location, false);
  assert.ok(
    hop.checks.fail_reasons.some((r) => r.startsWith("location(clip): hop")),
    hop.checks.fail_reasons.join(" | "),
  );
  const away = judgeVideoFrames(
    mixed.map((f) => notesFrame(f.frame, { blind: f.blind, loc: "茶餐廳卡位" })),
    require,
  );
  assert.equal(away.status, "FAIL");
  assert.ok(
    away.checks.fail_reasons.some((r) => r.startsWith("location(clip): hits")),
    away.checks.fail_reasons.join(" | "),
  );
});

test("CFORM7C: size clip gate still dies when every frame measures another scale", () => {
  const require: QcRequire = { people_count: 1, grey_blocks: false, size: "medium" };
  const frames = [
    notesFrame(0, { blind: "成個空間睇晒", loc: "", size: "full" }),
    notesFrame(48, { blind: "全景，人細過環境", loc: "", size: "full" }),
  ];
  const judged = judgeVideoFrames(frames, require);
  assert.equal(judged.status, "FAIL");
  assert.equal(judged.checks.size, false);
  assert.ok(
    judged.checks.fail_reasons.some((r) => r.startsWith("size(clip):")),
    judged.checks.fail_reasons.join(" | "),
  );
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
