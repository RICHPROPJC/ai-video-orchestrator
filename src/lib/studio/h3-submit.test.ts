import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { writeWav } from "./audio";
import { submitH3Shot } from "./h3-submit";

function validProse() {
  return [
    "Photoreal. 茶餐廳門口, night.",
    "Have the 2 people act following the movements of the grey placeholders in <Video 1> — they carry motion only; replace their look entirely.",
    "Faces and clothes continue exactly from <Picture 1>. Same props, not a morph. Do not add people.",
    '阿月 (left) speaks the line in Audio 1: "你仲記得個門口個燈？". 阿衡 listens.',
  ].join("\n\n");
}

function shotDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-h3-"));
  writeWav(path.join(dir, "SH01.wav"), new Float32Array(22050 * 2), 22050); // 2.0 s → k=3 → 56 f
  fs.writeFileSync(path.join(dir, "SH01.mp4"), Buffer.from("fake-blockout"));
  fs.writeFileSync(path.join(dir, "SH01.png"), Buffer.from("fake-kf"));
  fs.writeFileSync(path.join(dir, "A.png"), Buffer.from("fake-portrait"));
  return dir;
}

test("dry run C-form (Video 1 asset given): 56-frame receipt, zero keyframe nodes, portrait ref_image_0", async () => {
  const dir = shotDir();
  const receiptJson = path.join(dir, "motion", "SH01.h3_submit_dryrun.json");
  const { receipt, receiptFile } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    refImageFiles: [path.join(dir, "A.png")],
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson,
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.dry_run, true);
  assert.equal(receipt.graph_variant, "a");
  assert.equal(receipt.motion_form, "c");
  assert.equal(receipt.frames, 56);
  assert.equal(receipt.prompt_id, null);
  assert.equal(receipt.keyframe_positions, "");
  assert.equal(receipt.uploads.kf_start, null);
  assert.equal(receipt.uploads.kf_end, null);
  assert.match(receipt.uploads.blockout!, /_blockout\.mp4$/);
  assert.equal(receipt.uploads.ref_images.length, 1);
  assert.match(receipt.uploads.ref_images[0]!, /_ref_img_0\.png$/);
  assert.deepEqual(receipt.uploads.ui_photos, []);
  assert.equal(receipt.uploads.audio_timing, null);
  const graph = receipt.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  for (const key of ["keyframes", "kf_start_in", "kf_end_in", "kf_strength", "cond_combine"]) {
    assert.equal(key in graph, false, `${key} must not exist on the C-form`);
  }
  assert.deepEqual(graph.r2v.inputs["ref_videos.ref_video_0"], ["blender_vid", 0]);
  assert.deepEqual(graph.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.match(String(graph.split.inputs.bindings), /<Picture 1> is the sole appearance and identity reference/);
  assert.deepEqual(graph.guider_a.inputs.conditioning, ["cond_cs", 0]);
  // §5b: 8-step road carries zero FBC/SolAttn nodes
  assert.equal("fbc_ref2va" in graph, false);
  assert.equal("solattn_ref2va" in graph, false);
  assert.ok(receiptFile);
  const onDisk = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(onDisk.frames, 56);
  assert.ok(onDisk.prompt.startsWith("# produced_by: slatecrew_h3_submit"));
  // no motion mp4 materialised in dry run
  assert.equal(fs.existsSync(path.join(dir, "motion", "SH01.mp4")), false);
});

test("dry run A-form (no Video 1 asset): keyframes 0%, 100%, kf uploads wired", async () => {
  const dir = shotDir();
  const kf = path.join(dir, "SH01.png");
  const { receipt } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    kfStart: kf,
    kfEnd: kf,
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.motion_form, "a");
  assert.equal(receipt.keyframe_positions, "0%, 100%");
  assert.match(receipt.uploads.kf_start!, /_kf_start\.png$/);
  assert.match(receipt.uploads.kf_end!, /_kf_end\.png$/);
  assert.equal(receipt.uploads.blockout, null);
  assert.deepEqual(receipt.uploads.ref_images, []);
  const graph = receipt.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.equal(graph.keyframes.class_type, "H3Keyframes");
  assert.equal(graph.keyframes.inputs.positions, "0%, 100%");
  assert.deepEqual(graph.keyframes.inputs.image_2, ["kf_end_in", 0]);
  assert.equal("blender_vid" in graph, false);
  assert.equal("ref_videos.ref_video_0" in graph.r2v.inputs, false);
  assert.match(String(graph.split.inputs.bindings), /start and end keyframe images/);
});

test("§5b prohibition: blockoutMp4 + kfEnd in one submit refuses to emit", async () => {
  const dir = shotDir();
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: validProse(),
        wavFile: path.join(dir, "SH01.wav"),
        blockoutMp4: path.join(dir, "SH01.mp4"),
        kfStart: path.join(dir, "SH01.png"),
        kfEnd: path.join(dir, "SH01.png"),
        refImageFiles: [path.join(dir, "A.png")],
        outMp4: path.join(dir, "motion", "SH01.mp4"),
        receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
        dryRun: true,
        shot: "SH01",
      }),
    /keyframes_video1_coexist/,
  );
});

test("dry-run: blockout plus keyframes rides when keyframePositions is set", async () => {
  const dir = shotDir();
  const positions = "0%, 40%, 100%";
  const { receipt } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    kfStart: path.join(dir, "SH01.png"),
    kfEnd: path.join(dir, "SH01.png"),
    keyframePositions: positions,
    kfExtraFiles: [path.join(dir, "SH01.png")],
    refImageFiles: [path.join(dir, "A.png")],
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.keyframe_positions, positions);
  assert.equal(receipt.motion_form, "c");
  const graph = receipt.graph as Record<string, { class_type: string; inputs: Record<string, unknown> }>;
  assert.ok(graph.blender_vid, "Video 1 node stays");
  assert.equal(graph.keyframes.inputs.positions, positions);
});

test("dry run never clobbers a real receipt", async () => {
  const dir = shotDir();
  const receiptJson = path.join(dir, "motion", "SH01.h3_submit.json");
  fs.mkdirSync(path.dirname(receiptJson), { recursive: true });
  fs.writeFileSync(receiptJson, JSON.stringify({ dry_run: false, prompt_id: "real" }));
  const { receiptFile } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    refImageFiles: [path.join(dir, "A.png")],
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson,
    dryRun: true,
  });
  assert.match(receiptFile, /_dryrun\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(receiptJson, "utf8")).prompt_id, "real");
});

test("dry run wires UI photo refs and audio timing on the C-form (cards ③a/③b)", async () => {
  const dir = shotDir();
  fs.writeFileSync(path.join(dir, "ui.png"), Buffer.from("fake-ui"));
  fs.writeFileSync(path.join(dir, "timing.wav"), Buffer.from("fake-timing"));
  const { receipt } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    uiPhotoFiles: [path.join(dir, "ui.png")],
    audioTimingFile: path.join(dir, "timing.wav"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.motion_form, "c");
  assert.equal(receipt.uploads.ui_photos.length, 1);
  assert.match(receipt.uploads.ui_photos[0]!, /_ui_0\.png$/);
  assert.match(receipt.uploads.audio_timing!, /_timing\.wav$/);
  const graph = receipt.graph as {
    r2v: { inputs: Record<string, unknown> };
    timing_guard: { inputs: Record<string, unknown> };
  };
  // no portrait passed: the ui board holds <Picture 1>
  assert.deepEqual(graph.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.deepEqual(graph.r2v.inputs["ref_audios.ref_audio_1"], ["timing_guard", 0]);
  // the dialogue wav keeps <Audio 1>: exactly one dialogue wav stands
  assert.deepEqual(graph.r2v.inputs["ref_audios.ref_audio_0"], ["voice_guard", 0]);
});

test("UI photos and timing ref are rejected off the A path (fallback variants stay frozen)", async () => {
  const dir = shotDir();
  const base = {
    prose: "",
    wavFile: path.join(dir, "SH01.wav"),
    kfStart: path.join(dir, "SH01.png"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
    dryRun: true,
    graphVariant: "b" as const,
    refImageFiles: [path.join(dir, "SH01.png")],
  };
  await assert.rejects(
    () => submitH3Shot({ ...base, uiPhotoFiles: [path.join(dir, "SH01.png")] }),
    /A-path law-d channel/,
  );
  await assert.rejects(
    () => submitH3Shot({ ...base, audioTimingFile: path.join(dir, "SH01.wav") }),
    /A-path montage channel/,
  );
  // §5b: only the A production path may carry a Video 1
  await assert.rejects(
    () => submitH3Shot({ ...base, blockoutMp4: path.join(dir, "SH01.mp4") }),
    /only the A production path may carry a Video 1/,
  );
});

test("prose that fails validateProse throws before anything else", async () => {
  const dir = shotDir();
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: "隨便寫，冇 photoreal 冇 <Video 1> 句。",
        wavFile: path.join(dir, "SH01.wav"),
        blockoutMp4: path.join(dir, "SH01.mp4"),
        refImageFiles: [path.join(dir, "A.png")],
        outMp4: path.join(dir, "motion", "SH01.mp4"),
        receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
        dryRun: true,
      }),
    /Photoreal|motion-only/,
  );
});

test("ALIGN-LOCK rejects chained multishot before upload", async () => {
  const dir = shotDir();
  await assert.rejects(() => submitH3Shot({
    prose: validProse(), wavFile: path.join(dir, "SH01.wav"), blockoutMp4: path.join(dir, "SH01.mp4"),
    chain: { script: "two", shots: ["SH02"], framesPerShot: 124, referenceImageFile: path.join(dir, "boards/A.angles.png") },
    outMp4: path.join(dir, "out.mp4"), receiptJson: path.join(dir, "receipt.json"), dryRun: true,
  }), /multishot_identity_only/);
});

test("MULTISHOT_WIRE dry-run: standalone multishot (MS-A shape, motion_form=ms)", async () => {
  const dir = shotDir();
  const { receipt } = await submitH3Shot({
    prose: "line A\n---\nline B",
    wavFile: path.join(dir, "SH01.wav"),
    multishot: {
      script: "line A\n---\nline B",
      shots: ["SH01", "SH02"],
      framesPerShot: 119,
      referenceImageFile: path.join(dir, "boards/A.angles.png"),
    },
    outMp4: path.join(dir, "motion", "SH01-SH02.mp4"),
    receiptJson: path.join(dir, "motion", "SH01-SH02.h3_submit_dryrun.json"),
    dryRun: true,
    shot: "SH01-SH02",
  });
  assert.equal(receipt.motion_form, "ms");
  assert.equal(receipt.multishot!.shot_count, 2);
  assert.equal(receipt.multishot!.frames_per_shot, 124);
  assert.equal(receipt.multishot!.start_image, null);
  assert.equal(receipt.uploads.blockout, null);
  assert.equal(receipt.uploads.ms_start, null);
  const graph = receipt.graph as Record<string, { class_type: string }>;
  assert.equal(graph.ms.class_type, "H3MultishotSampler");
  assert.equal("r2v" in graph, false);
  assert.equal("keyframes" in graph, false);
});

test("MULTISHOT_WIRE refuse: chain without a Video 1; multishot with r2v refs", async () => {
  const dir = shotDir();
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: validProse(),
        wavFile: path.join(dir, "SH01.wav"),
        kfStart: path.join(dir, "SH01.png"),
        chain: { script: "x", shots: ["SH02"], framesPerShot: 119, referenceImageFile: path.join(dir, "A.png") },
        outMp4: path.join(dir, "motion", "x.mp4"),
        receiptJson: path.join(dir, "motion", "x.json"),
        dryRun: true,
      }),
    /chain_requires_cform/,
  );
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: "x",
        wavFile: path.join(dir, "SH01.wav"),
        refImageFiles: [path.join(dir, "A.png")],
        multishot: { script: "x", shots: ["SH01"], framesPerShot: 119, referenceImageFile: path.join(dir, "A.png") },
        outMp4: path.join(dir, "motion", "x.mp4"),
        receiptJson: path.join(dir, "motion", "x.json"),
        dryRun: true,
      }),
    /multishot is standalone/,
  );
});
