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
    "Faces, clothes, the props and the field continue exactly from the start keyframe image. Do not add people.",
    '阿月 (left) speaks the line in Audio 1: "你仲記得個門口個燈？". 阿衡 listens.',
  ].join("\n\n");
}

function shotDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-h3-"));
  writeWav(path.join(dir, "SH01.wav"), new Float32Array(22050 * 2), 22050); // 2.0 s → 124 f
  fs.writeFileSync(path.join(dir, "SH01.mp4"), Buffer.from("fake-blockout"));
  fs.writeFileSync(path.join(dir, "SH01.png"), Buffer.from("fake-kf"));
  return dir;
}

test("dry run writes a 124-frame receipt and touches no socket", async () => {
  const dir = shotDir();
  const receiptJson = path.join(dir, "motion", "SH01.h3_submit_dryrun.json");
  const { receipt, receiptFile } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    kfStart: path.join(dir, "SH01.png"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson,
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.dry_run, true);
  assert.equal(receipt.graph_variant, "a");
  assert.equal(receipt.frames, 124);
  assert.equal(receipt.prompt_id, null);
  assert.equal(receipt.uploads.kf_end, null);
  assert.deepEqual(receipt.uploads.ref_images, []);
  assert.deepEqual(receipt.uploads.ui_photos, []);
  assert.equal(receipt.uploads.audio_timing, null);
  assert.equal(receipt.keyframe_positions, "0%");
  assert.ok(receipt.graph && typeof receipt.graph === "object");
  assert.equal(receiptFile, receiptJson);
  const onDisk = JSON.parse(fs.readFileSync(receiptFile, "utf8"));
  assert.equal(onDisk.frames, 124);
  assert.ok(onDisk.prompt.startsWith("# produced_by: slatecrew_h3_submit"));
  // no motion mp4 materialised in dry run
  assert.equal(fs.existsSync(path.join(dir, "motion", "SH01.mp4")), false);
});

test("dry run with kfEnd wires image_2 at 100% on H3Keyframes", async () => {
  const dir = shotDir();
  const kf = path.join(dir, "SH01.png");
  const { receipt } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    kfStart: kf,
    kfEnd: kf,
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
    dryRun: true,
    shot: "SH01",
  });
  assert.ok(receipt.uploads.kf_end);
  assert.equal(receipt.keyframe_positions, "0%, 100%");
  const graph = receipt.graph as { keyframes: { class_type: string; inputs: Record<string, unknown> } };
  assert.equal(graph.keyframes.class_type, "H3Keyframes");
  assert.deepEqual(graph.keyframes.inputs.image_2, ["kf_end_in", 0]);
  assert.equal(graph.keyframes.inputs.positions, "0%, 100%");
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
    kfStart: path.join(dir, "SH01.png"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson,
    dryRun: true,
  });
  assert.match(receiptFile, /_dryrun\.json$/);
  assert.equal(JSON.parse(fs.readFileSync(receiptJson, "utf8")).prompt_id, "real");
});

test("dry run wires UI photo refs and audio timing on variant A (cards ③a/③b)", async () => {
  const dir = shotDir();
  const kf = path.join(dir, "SH01.png");
  fs.writeFileSync(path.join(dir, "ui.png"), Buffer.from("fake-ui"));
  fs.writeFileSync(path.join(dir, "timing.wav"), Buffer.from("fake-timing"));
  const { receipt } = await submitH3Shot({
    prose: validProse(),
    wavFile: path.join(dir, "SH01.wav"),
    blockoutMp4: path.join(dir, "SH01.mp4"),
    kfStart: kf,
    uiPhotoFiles: [path.join(dir, "ui.png")],
    audioTimingFile: path.join(dir, "timing.wav"),
    outMp4: path.join(dir, "motion", "SH01.mp4"),
    receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
    dryRun: true,
    shot: "SH01",
  });
  assert.equal(receipt.uploads.ui_photos.length, 1);
  assert.match(receipt.uploads.ui_photos[0]!, /_ui_0\.png$/);
  assert.match(receipt.uploads.audio_timing!, /_timing\.wav$/);
  const graph = receipt.graph as {
    r2v: { inputs: Record<string, unknown> };
    timing_guard: { inputs: Record<string, unknown> };
  };
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
    blockoutMp4: path.join(dir, "SH01.mp4"),
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
});

test("prose that fails validateProse throws before anything else", async () => {
  const dir = shotDir();
  await assert.rejects(
    () =>
      submitH3Shot({
        prose: "隨便寫，冇 photoreal 冇 <Video 1> 句。",
        wavFile: path.join(dir, "SH01.wav"),
        blockoutMp4: path.join(dir, "SH01.mp4"),
        kfStart: path.join(dir, "SH01.png"),
        outMp4: path.join(dir, "motion", "SH01.mp4"),
        receiptJson: path.join(dir, "motion", "SH01.h3_submit_dryrun.json"),
        dryRun: true,
      }),
    /Photoreal|motion-only/,
  );
});
