import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildH3Graph, BINDINGS } from "./h3-r2v-graph";
import { defaultConfig } from "./config";

const models = {
  textEncoder: defaultConfig.motion.textEncoder,
  encoderType: "minimax",
  videoVae: defaultConfig.motion.videoVae,
  audioVae: defaultConfig.motion.audioVae,
  ref2va: defaultConfig.motion.checkpoint,
  fl2va: defaultConfig.motion.fl2va,
  turboLora: defaultConfig.motion.turboLora,
};

const args = {
  script: "__PROMPT__",
  bindings: BINDINGS,
  frames: 260,
  steps: 4,
  seed: 42,
  filenamePrefix: "video/SLATECREW/__SHOT__",
  kfStartName: "__KF_START__",
  blockoutName: "__VIDEO__",
  wavName: "__AUDIO__",
  models,
};

test("builder deep-equals the H3Keyframes golden fixture (card C ①, 0919)", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v.api.json"), "utf8"),
  );
  const built = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.deepEqual(built, golden);
});

test("golden uses the official H3Keyframes node, never H3KeyframeInject", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.equal(g.keyframes.class_type, "H3Keyframes");
  assert.equal("kfinject" in g, false);
  for (const node of Object.values(g)) {
    assert.notEqual(node.class_type, "H3KeyframeInject");
  }
});

test("positions: one entry per anchor — '0%, 100%' with end, '0%' without", () => {
  const withEnd = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  const withoutEnd = buildH3Graph({ ...args });
  const we = withEnd.keyframes.inputs as Record<string, unknown>;
  const wo = withoutEnd.keyframes.inputs as Record<string, unknown>;
  assert.equal(we.positions, "0%, 100%");
  assert.deepEqual(we.image_1, ["kf_start_in", 0]);
  assert.deepEqual(we.image_2, ["kf_end_in", 0]);
  assert.equal(wo.positions, "0%");
  assert.equal("image_2" in wo, false);
  assert.equal("kf_end_in" in withoutEnd, false);
  // one positions entry per connected anchor (node invariant, h3_keyframes.py)
  for (const g of [withEnd, withoutEnd]) {
    const kf = g.keyframes.inputs as Record<string, unknown>;
    const anchors = ["image_1", "image_2", "image_3", "image_4", "image_5", "image_6", "images_batch"]
      .filter((k) => k in kf);
    assert.equal(
      String(kf.positions).split(",").length,
      anchors.length,
      `${kf.positions} must have one entry per anchor`,
    );
  }
});

test("keyframes positive is combined with the refs conditioning chain", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.deepEqual(g.keyframes.inputs.prompt, ["split", 0]);
  assert.deepEqual(g.kf_strength.inputs.conditioning, ["keyframes", 0]);
  assert.deepEqual(g.cond_combine.inputs.conditioning_1, ["cond_cs", 0]);
  assert.deepEqual(g.cond_combine.inputs.conditioning_2, ["kf_strength", 0]);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_combine", 0]);
  // latent stays the r2v empty AV latent (H3Keyframes emits the same shape)
  assert.deepEqual(g.samp_a.inputs.latent_image, ["r2v", 1]);
});

test("steps and length are numbers, not coerced strings", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.equal(typeof g.r2v.inputs.length, "number");
  assert.equal(typeof g.sched_a.inputs.steps, "number");
  assert.equal(typeof g.keyframes.inputs.length, "number");
  assert.equal(typeof g.noise_a.inputs.noise_seed, "number");
});

test("variant A: zero story ref_images, Video 1 wired, keyframes guider", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__", variant: "a" });
  const hits = Object.entries(g).flatMap(([n, node]) =>
    Object.keys(node.inputs).filter((k) => k.includes("ref_images")).map((k) => `${n}.${k}`),
  );
  assert.deepEqual(hits, []);
  assert.ok(g.blender_vid);
  assert.deepEqual(g.r2v.inputs["ref_videos.ref_video_0"], ["blender_vid", 0]);
  assert.deepEqual(g.r2v.inputs["ref_audios.ref_audio_0"], ["voice_guard", 0]);
  assert.deepEqual(g.samp_a.inputs.latent_image, ["r2v", 1]);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_combine", 0]);
  assert.deepEqual(g.split.inputs.bindings, BINDINGS);
});

test("audio is exactly one dialogue wav (ref_audio_0) unless a timing ref is given", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  const audioKeys = Object.keys(g.r2v.inputs).filter((k) => k.startsWith("ref_audios."));
  assert.deepEqual(audioKeys, ["ref_audios.ref_audio_0"], "dialogue wav stays the only audio ref");
});

test("card ③a: montage timing ref rides as ref_audio_1 (sample #31 cuts land on beats)", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__", audioTimingRefName: "__TIMING__.wav" });
  assert.deepEqual(g.timing_in.inputs.audio, "__TIMING__.wav");
  assert.deepEqual(g.timing_guard.inputs.audio, ["timing_in", 0]);
  assert.deepEqual(g.r2v.inputs["ref_audios.ref_audio_0"], ["voice_guard", 0], "dialogue wav untouched");
  assert.deepEqual(g.r2v.inputs["ref_audios.ref_audio_1"], ["timing_guard", 0]);
  const without = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.equal("timing_in" in without, false);
});

test("card ③b: UI photo refs open the ref_images channel on A; story shots stay empty", () => {
  const ui = buildH3Graph({
    ...args,
    kfEndName: "__KF_END__",
    uiPhotoNames: ["__UI_BOARD__.png", "__UI_CARD__.png"],
  });
  assert.deepEqual(ui.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.deepEqual(ui.r2v.inputs["ref_images.ref_image_1"], ["ref_img_1", 0]);
  assert.deepEqual(ui.ref_img_0.inputs.image, "__UI_BOARD__.png");
  const story = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  const storyKeys = Object.keys(story.r2v.inputs).filter((k) => k.startsWith("ref_images."));
  assert.deepEqual(storyKeys, [], "story shot photo refs stay empty (look is pinned by the still)");
});

test("variant B (documented fallback): ref_images populated, no Video 1, no keyframes", () => {
  const g = buildH3Graph({
    ...args,
    variant: "b",
    bindings: "",
    refImageNames: ["__STILL__", "__PORTRAIT__"],
  });
  assert.equal("blender_vid" in g, false);
  assert.equal("keyframes" in g, false);
  assert.deepEqual(g.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.deepEqual(g.r2v.inputs["ref_images.ref_image_1"], ["ref_img_1", 0]);
  assert.equal("ref_videos.ref_video_0" in g.r2v.inputs, false);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_cs", 0]);
  assert.equal(g.split.inputs.bindings, "");
});

test("variant BKF (documented fallback): ref_images + start anchor, no Video 1", () => {
  const g = buildH3Graph({
    ...args,
    variant: "bkf",
    bindings: "",
    refImageNames: ["__STILL__"],
  });
  assert.equal("blender_vid" in g, false);
  assert.ok(g.keyframes);
  const kf = g.keyframes.inputs as Record<string, unknown>;
  assert.equal(kf.positions, "0%");
  assert.equal("image_2" in kf, false);
  assert.deepEqual(g.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_combine", 0]);
});

test("variant C: zero refs, start anchor, no Video 1", () => {
  const g = buildH3Graph({ ...args, variant: "c", bindings: "" });
  assert.equal("blender_vid" in g, false);
  assert.equal("ref_img_0" in g, false);
  assert.equal("ref_videos.ref_video_0" in g.r2v.inputs, false);
  assert.equal("ref_images.ref_image_0" in g.r2v.inputs, false);
  assert.ok(g.keyframes);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_combine", 0]);
});

test("C8b knob: visualStrength override reaches both cond entries; 0.999 default unchanged", () => {
  const def = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  const low = buildH3Graph({ ...args, kfEndName: "__KF_END__", visualStrength: 0.4 });
  assert.equal(def.cond_cs.inputs.visual_strength, 0.999);
  assert.equal(def.kf_strength.inputs.visual_strength, 0.999);
  assert.equal(low.cond_cs.inputs.visual_strength, 0.4);
  assert.equal(low.kf_strength.inputs.visual_strength, 0.4);
});
