import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { writeWav } from "./audio";
import { wavSeconds } from "./frame-grid";
import type { CallSheet, JobRecord, Shot } from "./types";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom) */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function pinGreenVideo(motionDir: string, shotId: string) {
  const mp4 = path.join(motionDir, `${shotId}.mp4`);
  const sha = crypto.createHash("sha256").update(fs.readFileSync(mp4)).digest("hex");
  fs.writeFileSync(
    path.join(motionDir, `${shotId}.video_qc.json`),
    JSON.stringify({
      tool: "slatecrew.video_qc",
      status: "GREEN",
      sha256: sha,
      require: { people_count: 1, grey_blocks: false },
      frames: [],
      checks: { status: "GREEN", fail_reasons: [] },
    }),
  );
}

function pinGreenStill(stillDir: string, shotId: string) {
  fs.mkdirSync(stillDir, { recursive: true });
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a0a0000", "hex"), Buffer.alloc(9000)]);
  const png = path.join(stillDir, `${shotId}.png`);
  fs.writeFileSync(png, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  fs.writeFileSync(
    path.join(stillDir, `${shotId}.photo_qc.json`),
    JSON.stringify({
      tool: "slatecrew.photo_qc",
      status: "GREEN",
      sha256: sha,
      blind: "fixture",
      require: { people_count: 1, grey_blocks: false },
    }),
  );
}

function resumeSheet(): CallSheet {
  return {
    title: "skip-fixture",
    logline: "l",
    language: "zh-Hant",
    location: "stage",
    timeOfDay: "night",
    weather: "clear",
    mood: "test",
    durationSec: 2,
    aspect: "16:9",
    characters: [
      { id: "A", name: "Cast-A", role: "r1", wardrobe: "coat", palette: ["#111", "#222", "#333"], voice: { pitchHz: 190, gender: "f" }, heightM: 1.05 },
      { id: "B", name: "Cast-B", role: "r2", wardrobe: "shirt", palette: ["#444", "#555", "#666"], voice: { pitchHz: 120, gender: "m" } },
    ],
    styleBible: { grade: "test", refs: [], stillModel: "u15", motionModel: "h3" },
    shots: [
      {
        id: "SH01",
        index: 0,
        heading: "1",
        size: "medium",
        location: "stage",
        action: "lane fixture",
        dialogue: "",
        durationSec: 2,
        camera: { pos: { x: 0, y: -4, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.4 }, lensMm: 35 },
        marks: [
          { characterId: "A", start: { x: 20, y: 40 }, end: { x: 24, y: 42 }, facing: 0, handL: { x: 24, y: 38 }, handR: { x: 26, y: 38 }, footL: { x: 21, y: 80 }, footR: { x: 23, y: 80 }, gait: "plant" },
          { characterId: "B", start: { x: 70, y: 40 }, end: { x: 70, y: 40 }, facing: 0, handL: { x: 66, y: 38 }, handR: { x: 74, y: 38 }, footL: { x: 68, y: 80 }, footR: { x: 71, y: 80 }, gait: "plant" },
        ],
        stillPrompt: "",
        motionPrompt: "",
      },
    ],
    voiceover: "",
  };
}

test("resume + all stills GREEN skips portraits and reaches motion-prep", async () => {
  let portraitCalls = 0;
  const { mock } = await import("bun:test");
  mock.module("./portraits", () => ({
    ensurePortraits: async () => {
      portraitCalls += 1;
      return { files: {}, made: [], plugged: [], kept: [] };
    },
  }));
  const { runPipeline } = await import("./pipeline");
  const { writeJob, readEvents } = await import("./store");
  const { renderBlockout, extractFrame0, stillFrameFor } = await import("./blockout");
  const { writeAnchors } = await import("./dhash-anchors");
  const { snapDurationToFrames } = await import("./frame-grid");
  const { jobDir } = await import("./paths");

  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pipe-skip-"));
  process.chdir(tmp);
  try {
    const jobId = "SC-0913-SKIP";
    const sheet = resumeSheet();
    const jdir = jobDir(jobId);
    fs.mkdirSync(jdir, { recursive: true });
    fs.writeFileSync(path.join(jdir, "callsheet.json"), JSON.stringify(sheet, null, 2));
    const job: JobRecord = {
      id: jobId,
      slate: jobId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      status: "running",
      input: { brief: "fixture", wavDir: "" },
      progress: 0,
      retries: { stills: 0, voice: 0, motion: 0 },
      outputs: { stills: [], shots: [], blockout: [], receipts: [] },
    };
    writeJob(job);

    const wavDir = path.join(tmp, "wav");
    fs.mkdirSync(wavDir);
    writeWav(path.join(wavDir, "SH01.wav"), new Float32Array(22050 * 2), 22050);

    const blockoutDir = path.join(jdir, "blockout");
    fs.mkdirSync(blockoutDir);
    const frames = snapDurationToFrames(2);
    const blockoutMp4 = path.join(blockoutDir, "SH01.mp4");
    await renderBlockout({ sheet, shot: sheet.shots[0]!, frames, outMp4: blockoutMp4 });
    await extractFrame0(blockoutMp4, path.join(blockoutDir, "SH01.f0.png"), stillFrameFor(sheet.shots[0]!, frames));
    await writeAnchors(blockoutMp4, path.join(blockoutDir, "SH01.anchors.json"));

    pinGreenStill(path.join(jdir, "stills"), "SH01");

    const portraitDir = path.join(jdir, "portraits");
    fs.mkdirSync(portraitDir, { recursive: true });
    fs.writeFileSync(path.join(portraitDir, "A.png"), Buffer.from("89504e470d0a1a2a0001", "hex"));
    fs.writeFileSync(
      path.join(portraitDir, "A.photo_qc.json"),
      JSON.stringify({ status: "FAIL", checks: { fail_reasons: ["people_count: 2"] } }),
    );

    const motionDir = path.join(jdir, "motion");
    fs.mkdirSync(motionDir);
    fs.copyFileSync(blockoutMp4, path.join(motionDir, "SH01.mp4"));
    fs.writeFileSync(path.join(motionDir, "SH01.h3_submit.json"), "{}");
    pinGreenVideo(motionDir, "SH01");

    await runPipeline(jobId, { brief: "fixture", wavDir, resume: true, until: "motion" });

    assert.equal(portraitCalls, 0);
    const events = readEvents(jobId);
    assert.ok(
      events.some((e) => e.message.includes("肖像跳過：stills 已全 GREEN，肖像唔再守門")),
      events.map((e) => e.message).join(" | "),
    );
    assert.ok(
      events.some((e) => e.message === "repair: portraits saw ensurePortraits became skip (all stills pinned GREEN on resume)"),
      events.map((e) => e.message).join(" | "),
    );
    assert.ok(
      events.some((e) => e.agent === "motion" && e.message.includes("H3 R2V")),
      events.map((e) => e.message).join(" | "),
    );
    assert.ok(events.some((e) => e.agent === "motion" && e.message.includes("packet")), events.map((e) => e.message).join(" | "));
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("padH3Wav pads a 2.0s wav to the snapped 124-frame clock (±1/48)", async () => {
  const { padH3Wav } = await import("./pipeline");
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
  const { padH3Wav } = await import("./pipeline");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pad2-"));
  const src = path.join(dir, "SH01.wav");
  writeWav(src, new Float32Array(22050 * 2), 22050);
  const got = await padH3Wav(src, path.join(dir, "out.wav"), 243);
  assert.ok(Math.abs(got - 10.125) <= 1 / 48, `padded ${got}s`);
});

test("mux args level-match the padded wav and never apad", async () => {
  const { muxArgs } = await import("./pipeline");
  const args = muxArgs("/m/SH01.mp4", "/a/SH01.h3.wav", "/m/SH01.muxed.mp4");
  assert.ok(args.includes("loudnorm=I=-18:TP=-1.5:LRA=11"), "loudnorm present");
  assert.ok(args.includes("-b:a") && args[args.indexOf("-b:a") + 1] === "128k", "aac 128k");
  assert.ok(args.includes("aac"));
  assert.ok(args.includes("-shortest"));
  assert.ok(!args.includes("apad"), "apad dropped — wav is already padded");
  assert.deepEqual(args.slice(args.indexOf("-i"), args.indexOf("-i") + 4), ["-i", "/m/SH01.mp4", "-i", "/a/SH01.h3.wav"]);
});

/** Synthetic story-free shots — ids and scene tags only, nothing from data/jobs. */
function shotOf(id: string, scene?: string, beatId?: string): Shot {
  return {
    id,
    index: 0,
    heading: "INT. STAGE",
    size: "medium",
    location: "stage",
    action: "lane-filter fixture",
    dialogue: "",
    durationSec: 2,
    camera: { pos: { x: 0, y: 1, z: 2 }, lookAt: { x: 0, y: 1, z: 0 }, lensMm: 35 },
    marks: [],
    stillPrompt: "",
    motionPrompt: "",
    ...(scene ? { scene } : {}),
    ...(beatId ? { beatId } : {}),
  };
}

test("shotsForScene: scene omitted returns all shots unchanged", async () => {
  const { shotsForScene } = await import("./pipeline");
  const shots = [shotOf("SH01", "SC01"), shotOf("SH02", "SC01"), shotOf("SH03", "SC02")];
  assert.equal(shotsForScene(shots).length, 3);
  assert.equal(shotsForScene(shots, undefined).length, 3);
});

test("shotsForScene: SC01 keeps only that scene's shot ids", async () => {
  const { shotsForScene } = await import("./pipeline");
  const shots = [shotOf("SH01", "SC01"), shotOf("SH02", "SC01"), shotOf("SH03", "SC02")];
  assert.deepEqual(shotsForScene(shots, "SC01").map((s) => s.id), ["SH01", "SH02"]);
});

test("shotsForScene: unknown scene throws instead of burning the slate", async () => {
  const { shotsForScene } = await import("./pipeline");
  const shots = [shotOf("SH01", "SC01"), shotOf("SH02", "SC01"), shotOf("SH03", "SC02")];
  assert.throws(() => shotsForScene(shots, "SC99"));
});

test("shotsForScene: a shot without .scene still matches via beatId prefix", async () => {
  const { shotsForScene } = await import("./pipeline");
  const shots = [shotOf("SH04", undefined, "SC02.B01"), shotOf("SH05", "SC01")];
  assert.deepEqual(shotsForScene(shots, "SC02").map((s) => s.id), ["SH04"]);
});

test("hopGeometrySheet: no scene keeps the whole slate, a hop crops to its shots", async () => {
  const { hopGeometrySheet } = await import("./pipeline");
  const shots = [shotOf("SH01", "SC01"), shotOf("SH02", "SC01"), shotOf("SH03", "SC02")];
  const sheet = { ...resumeSheet(), shots };
  assert.equal(hopGeometrySheet(sheet).shots.length, 3, "no scene = the full sheet");
  assert.deepEqual(hopGeometrySheet(sheet, "SC01").shots.map((s) => s.id), ["SH01", "SH02"]);
  assert.equal(hopGeometrySheet(sheet, "SC01").title, sheet.title, "the rest of the sheet travels unchanged");
  assert.throws(() => hopGeometrySheet(sheet, "SC99"), /一鏡都對唔上/);
});

test("g6 LD0F grave: hop stills vs the full slate's sheet cried missing-still; the hop sheet does not", async () => {
  const { hopGeometrySheet } = await import("./pipeline");
  const { localPictureQc } = await import("./providers");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "g6-hop-"));
  const stills = ["SH01", "SH02"].map((id) => {
    const file = path.join(tmp, `${id}.png`);
    fs.writeFileSync(file, Buffer.concat([Buffer.from("89504e470d0a1a0a0000", "hex"), Buffer.alloc(9000)]));
    return file;
  });
  const shots = [shotOf("SH01", "SC01"), shotOf("SH02", "SC01"), shotOf("SH03", "SC02")];
  const sheet = { ...resumeSheet(), shots };
  // the old behaviour: 2 hop stills scored against all 3 shots → "Missing stills"
  const fullSlate = localPictureQc({ stills, sheet, target: "stills" });
  assert.ok(fullSlate.issues.some((i) => i.code === "missing-still"), "full-sheet geometry blocks the hop");
  // g6 fix: the same 2 stills against the hop's 2 shots is a clean geometry
  const hop = localPictureQc({ stills, sheet: hopGeometrySheet(sheet, "SC01"), target: "stills" });
  assert.ok(!hop.issues.some((i) => i.code === "missing-still"), "hop sheet scores hop shots only");
});

if (bareBun) {
  // IIFE, not top-level await: tsx transpiles this file as CJS
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
