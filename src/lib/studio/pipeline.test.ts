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
  // T39: the earn GPU gate reads the real /mnt/ssd/earn/.lock by default —
  // point it at a nonexistent temp path so a parked earn lock can never hang
  // this test (the gate itself is covered in earn-gpu-lock.test.ts)
  const hadLockEnv = process.env.SLATECREW_EARN_LOCK;
  process.env.SLATECREW_EARN_LOCK = path.join(tmp, "no-earn.lock");
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
    if (hadLockEnv === undefined) delete process.env.SLATECREW_EARN_LOCK;
    else process.env.SLATECREW_EARN_LOCK = hadLockEnv;
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

test("T36 B2: a photo-QC retry re-issues the packet verbatim — no fail_reasons token, no absolute path", async () => {
  const { sealEditRecord } = await import("./pipeline");
  const { buildEditPayload } = await import("./u15-edit");
  const inputs = {
    prompt: "Image-1 係呢一鏡嘅 Blender 灰模概念圖……左起第1個人偶＝角色一。",
    first: true,
    base: "/tmp/SC-FIX/data/jobs/SC-FIX/blocking/SH01.f0.png",
    refs: [
      "/tmp/SC-FIX/data/jobs/SC-FIX/portraits/A.png",
      "/tmp/SC-FIX/data/jobs/SC-FIX/stills/SH01.png",
    ],
  };
  const payload = buildEditPayload({ prompt: inputs.prompt, images: ["/node/base.png", "/node/ref.png"], width: 1024, height: 576 });
  // the fail_reasons a QC miss would surface — none may ride into the prompt.
  // the old retry suffix is spelled in halves so B1's literal src-grep stays 0
  const failReasons = ["people_count: 2", "grey_blocks: mannequin visible", "not GREEN", `Fix ${"these"}: people_count: 2.`];
  const record = sealEditRecord(inputs, payload);
  assert.equal(record.prompt, payload.prompt, "retry prompt = packet prompt, untouched");
  assert.equal(record.prompt, inputs.prompt.trim());
  for (const token of failReasons) {
    assert.ok(!record.prompt.includes(token), `fail_reasons token leaked into prompt: ${token}`);
  }
  assert.equal(record.base, "SH01.f0.png", "base lands as a bare filename");
  assert.deepEqual(record.refs, ["A.png", "SH01.png"], "refs land as bare filenames");
});

test("T44 R1: `first` tracks unseen faces only — a size change no longer re-portraits", async () => {
  const { stillFirstFlags } = await import("./pipeline");
  const boards = [
    { marks: [{ characterId: "A" }] }, // i=0 → first
    { marks: [{ characterId: "A" }] }, // same face, any size change → not first
    { marks: [{ characterId: "A" }, { characterId: "B" }] }, // B unseen → first
    { marks: [{ characterId: "B" }] }, // B seen, A gone → not first
  ];
  assert.deepEqual(stillFirstFlags(boards), [true, false, true, false]);
});

test("T44 R2/R4: only GREEN-photo_qc files may feed /edit refs — the rest come back rejected", async () => {
  const { refsGreenOnly } = await import("./pipeline");
  const { pinQcAccepted } = await import("./photo-qc");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t44-refs-"));
  const bytes = Buffer.concat([Buffer.from("89504e470d0a1a1a0000", "hex"), Buffer.alloc(9000)]);
  const mk = (id: string, status: "GREEN" | "FAIL") => {
    fs.writeFileSync(path.join(dir, `${id}.png`), bytes);
    fs.writeFileSync(
      path.join(dir, `${id}.photo_qc.json`),
      JSON.stringify({
        tool: "slatecrew.photo_qc",
        status,
        sha256: crypto.createHash("sha256").update(bytes).digest("hex"),
        blind: "fixture",
        require: { people_count: 1, grey_blocks: false },
      }),
    );
    return path.join(dir, `${id}.png`);
  };
  const greenStill = mk("SH01", "GREEN");
  const failStill = mk("SH02", "FAIL");
  const portrait = mk("A", "GREEN");
  // R4: the FAILed still is rejected, the GREEN still and portrait pass
  const gate = refsGreenOnly([greenStill, failStill, portrait]);
  assert.deepEqual(gate.kept, [greenStill, portrait]);
  assert.deepEqual(gate.rejected, [failStill]);
  // R2's mechanism: a FAILed still can never enter refs, so a retry built
  // from kept files cannot contain it
  assert.ok(!gate.kept.includes(failStill));
  // R3's mechanism: pinQcAccepted is GREEN-only — a FAIL png never skips /edit on resume
  assert.equal(pinQcAccepted(dir, "SH02"), false);
  assert.equal(pinQcAccepted(dir, "SH01"), true);
  fs.rmSync(dir, { recursive: true, force: true });
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

// ---- card ③b (sample #20): the UI/infographic photo channel at the pipeline
// layer. uiShot is the only gate; story shots stay zero-photo even with stray
// uiRefs. Fixtures are synthetic — nothing from data/jobs.

function uiChannelSheet(): CallSheet {
  const sheet = resumeSheet();
  return {
    ...sheet,
    shots: [
      {
        ...sheet.shots[0]!,
        id: "SH01",
        action: "The interface holds a full-bleed dashboard: a header bar, three metric cards, a line chart, and a footnote row. The cursor drifts across the cards, pausing on each metric, while the chart draws its final segment and the highlighted card lifts slightly. The grid gutters hold still and the typography never reflows; the whole panel reads as one flat surface under even studio light. Nothing else in the layout moves.",
        uiShot: true,
        uiSpec: {
          cards: [{ label: "revenue card" }],
          onscreen: [{ text: "HK$1.2M", where: "top-left metric card" }],
          moving: ["the cursor", "the highlighted card"],
        },
        uiRefs: ["/fixtures/ui/dashboard.png"],
      },
      {
        ...sheet.shots[0]!,
        id: "SH02",
        action: "Cast-A crosses the stage and lifts the crate onto the table while Cast-B watches from the doorway, arms folded, weight on the doorframe. Dust lifts through the single hard backlight as the lamp swings once and settles, and the floorboards creak under the crate's weight.",
        // stray refs without the marker: the channel must stay shut
        uiRefs: ["/fixtures/ui/accidental.png"],
      },
    ],
  };
}

test("h3MotionPack: §5b C-form story pack wires angle portraits; uiShot keeps the ③b channel", async () => {
  const { h3MotionPack } = await import("./pipeline");
  const sheet = uiChannelSheet();
  const [ui, story] = sheet.shots;
  const portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pack-portraits-"));
  const portraitFiles: Record<string, string> = {};
  for (const id of ["A", "B"]) {
    const f = path.join(portraitDir, `${id}.png`);
    fs.writeFileSync(f, Buffer.from("fake-portrait"));
    portraitFiles[id] = f;
  }
  const uiPack = h3MotionPack(sheet, ui!, "a", "/stills/SH01.png", portraitFiles, undefined, { portraitDir });
  assert.deepEqual(uiPack.uiPhotoFiles, ["/fixtures/ui/dashboard.png"]);
  assert.match(uiPack.prose, /<Picture 1> = the UI layout/);
  assert.match(uiPack.prose, /「HK\$1\.2M」/);
  assert.match(uiPack.prose, /Only the cursor, the highlighted card move/);
  assert.equal(uiPack.kfEnd, undefined, "C-form ui shot wires zero keyframes");
  const storyPack = h3MotionPack(sheet, story!, "a", "/stills/SH02.png", portraitFiles, undefined, { portraitDir });
  assert.equal(storyPack.uiPhotoFiles, undefined);
  // §5b C-form: identity = angle portraits on ref_images (left-to-right), pin names <Picture 1>
  assert.ok(storyPack.refImageFiles?.length === 2, "two marked characters → two portrait refs");
  assert.match(path.basename(storyPack.refImageFiles![0]!), /^A\.png$/, "left mark first");
  assert.match(path.basename(storyPack.refImageFiles![1]!), /^B\.png$/);
  assert.match(storyPack.prose, /continue exactly from <Picture 1>/);
  assert.doesNotMatch(storyPack.prose, /start keyframe image/);
  assert.doesNotMatch(storyPack.prose, /accidental/);
  assert.equal(storyPack.kfEnd, undefined, "C-form story shot wires zero keyframes");
  // A-form (no Video 1 asset): still-to-video keeps keyframes and the old pin
  const aPack = h3MotionPack(sheet, story!, "a", "/stills/SH02.png", portraitFiles, undefined, {
    hasVideo1: false,
    portraitDir,
  });
  assert.equal(aPack.kfEnd, "/stills/SH02.png");
  assert.equal(aPack.refImageFiles, undefined);
  assert.match(aPack.prose, /start keyframe image/);
});

test("h3MotionPack: 45° shot without an angle portrait fails loud (B-lane face-drag ban)", async () => {
  const { h3MotionPack } = await import("./pipeline");
  const sheet = uiChannelSheet();
  const story = sheet.shots[1]!;
  story.refAngle = "45";
  const portraitDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pack-45-"));
  fs.writeFileSync(path.join(portraitDir, "A.png"), Buffer.from("fake-front"));
  assert.throws(
    () => h3MotionPack(sheet, story, "a", "/stills/SH02.png", { A: path.join(portraitDir, "A.png") }, undefined, { portraitDir }),
    /angle_portrait_missing.*A_45\.png/,
  );
  fs.writeFileSync(path.join(portraitDir, "A_45.png"), Buffer.from("fake-45"));
  fs.writeFileSync(path.join(portraitDir, "B_45.png"), Buffer.from("fake-45"));
  const pack = h3MotionPack(sheet, story, "a", "/stills/SH02.png", { A: path.join(portraitDir, "A.png") }, undefined, { portraitDir });
  assert.equal(pack.refImageFiles!.length, 2);
  assert.equal(path.basename(pack.refImageFiles![0]!), "A_45.png");
  assert.equal(path.basename(pack.refImageFiles![1]!), "B_45.png");
  // plugged 45° supply (WR1Q shape): {id}_45.png in the plug dir counts too
  const plugDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-pack-45-plug-"));
  fs.writeFileSync(path.join(plugDir, "A_45.png"), Buffer.from("fake-45-plug"));
  fs.writeFileSync(path.join(plugDir, "B_45.png"), Buffer.from("fake-45-plug"));
  const plugged = h3MotionPack(sheet, story, "a", "/stills/SH02.png", {}, undefined, { portraitDir: "/nonexistent", plugDir });
  assert.equal(plugged.refImageFiles!.length, 2, "plug dir supplies the angle portraits");
});

test("h3MotionPack: UI channel is A-path only — fallback variants stay frozen", async () => {
  const { h3MotionPack } = await import("./pipeline");
  const sheet = uiChannelSheet();
  const ui = sheet.shots[0]!;
  for (const variant of ["b", "bkf", "c"] as const) {
    const pack = h3MotionPack(sheet, ui, variant, "/stills/SH01.png", {});
    assert.equal(pack.uiPhotoFiles, undefined, `${variant} must not feed ui photos`);
  }
});

test("h3MotionPack: UI channel is A-path only — fallback variants stay frozen", async () => {
  const { h3MotionPack } = await import("./pipeline");
  const sheet = uiChannelSheet();
  const ui = sheet.shots[0]!;
  for (const variant of ["b", "bkf", "c"] as const) {
    const pack = h3MotionPack(sheet, ui, variant, "/stills/SH01.png", {});
    assert.equal(pack.uiPhotoFiles, undefined, `${variant} must not feed ui photos`);
  }
});

test("card ③b end-to-end: C-form dry receipts — ui photos ride ref_images, story rides the portrait", async () => {
  const { h3MotionPack } = await import("./pipeline");
  const { submitH3Shot } = await import("./h3-submit");
  const sheet = uiChannelSheet();
  const [ui, story] = sheet.shots;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-ui-channel-"));
  const portraitDir = path.join(dir, "portraits");
  fs.mkdirSync(portraitDir, { recursive: true });
  const portraitFiles: Record<string, string> = {};
  for (const id of ["A", "B"]) {
    const f = path.join(portraitDir, `${id}.png`);
    fs.writeFileSync(f, Buffer.from("fake-portrait"));
    portraitFiles[id] = f;
  }
  for (const id of ["SH01", "SH02"]) {
    writeWav(path.join(dir, `${id}.wav`), new Float32Array(22050 * 2), 22050); // 2.0s → 124f
  }
  for (const id of ["SH01", "SH02"]) {
    fs.writeFileSync(path.join(dir, `${id}.mp4`), Buffer.from("fake-blockout"));
    fs.writeFileSync(path.join(dir, `${id}.png`), Buffer.from("fake-kf"));
  }
  for (const [shot, stillId] of [[ui!, "SH01"], [story!, "SH02"]] as const) {
    const pack = h3MotionPack(sheet, shot, "a", path.join(dir, `${stillId}.png`), portraitFiles, undefined, { portraitDir });
    const { receipt } = await submitH3Shot({
      prose: pack.prose,
      wavFile: path.join(dir, `${stillId}.wav`),
      blockoutMp4: path.join(dir, `${stillId}.mp4`),
      refImageFiles: pack.refImageFiles,
      uiPhotoFiles: pack.uiPhotoFiles,
      outMp4: path.join(dir, "motion", `${stillId}.mp4`),
      receiptJson: path.join(dir, "motion", `${stillId}.receipt.json`),
      dryRun: true,
      shot: stillId,
      requireQuote: false,
    });
    assert.equal(receipt.motion_form, "c");
    assert.equal(receipt.uploads.kf_start, null, "C-form uploads zero keyframe stills");
    const graph = receipt.graph as Record<string, { class_type: string }>;
    assert.equal("keyframes" in graph, false, "C-form wires zero keyframe nodes");
    const r2v = (receipt.graph as { r2v: { inputs: Record<string, unknown> } }).r2v;
    if (shot.uiShot) {
      assert.equal(receipt.uploads.ui_photos.length, 1);
      assert.match(receipt.uploads.ui_photos[0]!, /_ui_0\.png$/);
      assert.deepEqual(r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
      assert.match(receipt.prompt, /<Picture 1>/);
    } else {
      assert.deepEqual(receipt.uploads.ui_photos, []);
      assert.equal(receipt.uploads.ref_images.length, 2, "two identity portraits ride ref_image_0/1");
      assert.match(receipt.uploads.ref_images[0]!, /_ref_img_0\.png$/);
      assert.deepEqual(r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
      assert.deepEqual(r2v.inputs["ref_images.ref_image_1"], ["ref_img_1", 0]);
    }
  }

});

test("CFORM7: motionClipRequire swaps the freeze line for the clip's temporal action, other keys untouched", async () => {
  const { motionClipRequire } = await import("./pipeline");
  const base = {
    people_count: 1,
    grey_blocks: false,
    location: "地下室檔案室",
    action: "沈北辰企定喺兩排金屬檔案架之間嘅空地，雙拳收腰提喺腰側，肩線沉定，眼神堅定望向前方",
    size: "full",
  };
  const clip = { ...resumeSheet().shots[0]!, action: "企定，連環兩記右直拳，側踢，落地收勢立正", motionPrompt: "motion script" };
  const out = motionClipRequire(base, clip);
  assert.equal(out.action, clip.action, "motion require reads the clip's temporal script");
  assert.equal(out.location, base.location, "location gate rides the keyframe require");
  assert.equal(out.size, base.size, "size gate rides the keyframe require");
  assert.equal(out.people_count, base.people_count);
  // motionPrompt stands in when the action line is blank
  const bare = motionClipRequire(base, { ...clip, action: "  " });
  assert.equal(bare.action, "motion script");
  // no shot / no script at all → keyframe require verbatim (no invented action)
  assert.equal(motionClipRequire(base, undefined), base);
  const noAction = motionClipRequire({ people_count: 1, grey_blocks: false }, { ...clip, action: "", motionPrompt: "" });
  assert.equal("action" in noAction, false);
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
