import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildH3Graph, h3SizeForAspect, BINDINGS, BINDINGS_CFORM, COND_VISUAL } from "./h3-r2v-graph";
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

const base = {
  script: "__PROMPT__",
  frames: 260,
  steps: 8,
  seed: 42,
  filenamePrefix: "video/SLATECREW/__SHOT__",
  blockoutName: "__VIDEO__",
  wavName: "__AUDIO__",
  models,
};

/** §5b C-form: Video 1 asset present — zero keyframes, portrait ref_image_0. */
const cform = { ...base, bindings: BINDINGS_CFORM, refImageNames: ["__PORTRAIT_A__"] };

/** §5b A-form: no Video 1 — still-to-video keyframes two ends. */
const aform = {
  ...base,
  bindings: BINDINGS,
  blockoutName: undefined,
  kfStartName: "__KF_START__",
  kfEndName: "__KF_END__",
};

test("C-form deep-equals the production golden (§5b, CFORM_0921)", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v.api.json"), "utf8"),
  );
  const built = buildH3Graph({ ...cform });
  assert.deepEqual(built, golden);
});

/** ECOM1A: callsheet aspect 9:16 — the 544×960 portrait canvas rides EVERY node
 *  (r2v + VHS_LoadVideo motion ref), golden-locked like the 16:9 recipe. */
test("9:16 C-form deep-equals the portrait golden (ECOM1A probe: verify/motion/H3.object_info.node1.CFORM-ECOM.json)", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v-916.api.json"), "utf8"),
  );
  const built = buildH3Graph({ ...cform, width: 544, height: 960 });
  assert.deepEqual(built, golden);
});

test("ECOM1A: VHS_LoadVideo __VIDEO__ canvas stays in sync with the sampler canvas", () => {
  const g = buildH3Graph({ ...cform, width: 544, height: 960 });
  assert.equal(g.blender_vid.inputs.custom_width, g.r2v.inputs.width);
  assert.equal(g.blender_vid.inputs.custom_height, g.r2v.inputs.height);
  assert.equal(g.blender_vid.inputs.video, "__VIDEO__");
  // half-sized opts are refused: latent and motion ref must agree on one canvas
  assert.throws(() => buildH3Graph({ ...cform, width: 500, height: 880 }), /graph_size_invalid/);
  assert.throws(() => buildH3Graph({ ...cform, width: 544 }), /graph_size_invalid/);
});

test("ECOM1A: h3SizeForAspect — probe-backed sizes, default 16:9, unknown refuses", () => {
  assert.deepEqual(h3SizeForAspect("9:16"), { width: 544, height: 960 });
  assert.deepEqual(h3SizeForAspect("16:9"), { width: 864, height: 480 });
  assert.deepEqual(h3SizeForAspect(undefined), { width: 864, height: 480 });
  assert.throws(() => h3SizeForAspect("4:5"), /aspect_unsupported/);
});

test("A-form deep-equals the still-to-video golden (§5b keyframes lane)", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v-still2video.api.json"), "utf8"),
  );
  const built = buildH3Graph({ ...aform });
  assert.deepEqual(built, golden);
});

test("C-form golden: Video 1 wired, zero keyframe nodes, portrait at ref_image_0", () => {
  const g = buildH3Graph({ ...cform });
  assert.deepEqual(g.r2v.inputs["ref_videos.ref_video_0"], ["blender_vid", 0]);
  assert.deepEqual(g.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.equal(g.ref_img_0.inputs.image, "__PORTRAIT_A__");
  for (const key of ["keyframes", "kf_start_in", "kf_end_in", "kf_strength", "cond_combine"]) {
    assert.equal(key in g, false, `${key} must not exist on the C-form`);
  }
  // no H3Keyframes anywhere, never the retired H3KeyframeInject
  for (const node of Object.values(g)) {
    assert.notEqual(node.class_type, "H3Keyframes");
    assert.notEqual(node.class_type, "H3KeyframeInject");
  }
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_cs", 0]);
  assert.deepEqual(g.split.inputs.bindings, BINDINGS_CFORM);
  assert.match(BINDINGS_CFORM, /<Picture 1> is the sole appearance and identity reference/);
  assert.match(BINDINGS_CFORM, /<Video 1> is motion only/);
});

test("§5b prohibition: Video 1 + keyframes in one build refuses to emit (prompt_too_thin family)", () => {
  assert.throws(
    () => buildH3Graph({ ...cform, kfStartName: "__KF_START__" }),
    /keyframes_video1_coexist/,
  );
  assert.throws(
    () => buildH3Graph({ ...cform, kfEndName: "__KF_END__" }),
    /keyframes_video1_coexist/,
  );
});

test("A-form without kfStartName refuses to emit (0% anchor is mandatory)", () => {
  assert.throws(
    () => buildH3Graph({ ...aform, kfStartName: undefined }),
    /a-form requires kfStartName/,
  );
});

test("FBC/SolAttn ride ONLY the 4-step road (§5b: 8-step v1.0 structurally crashes FBC)", () => {
  for (const steps of [8, 20, 6]) {
    const g = buildH3Graph({ ...cform, steps });
    assert.equal("fbc_ref2va" in g, false, `steps=${steps} must not wire FBC`);
    assert.equal("solattn_ref2va" in g, false, `steps=${steps} must not wire SolAttn`);
    assert.equal("fbc_fl2va" in g, false);
    assert.deepEqual(g.lora_a.inputs.model, ["ref2va", 0], `steps=${steps} lora reads the loader directly`);
    assert.equal(g.sched_a.inputs.steps, steps);
  }
  const turbo4 = buildH3Graph({ ...cform, steps: 4 });
  assert.equal(turbo4.fbc_ref2va.class_type, "H3FirstBlockCache");
  assert.equal(turbo4.solattn_ref2va.class_type, "SolAttnMiniMaxH3Patcher");
  assert.deepEqual(turbo4.solattn_ref2va.inputs.model, ["fbc_ref2va", 0]);
  assert.deepEqual(turbo4.lora_a.inputs.model, ["solattn_ref2va", 0]);
  assert.equal(turbo4.sched_a.inputs.steps, 4);
});

test("A-form: official H3Keyframes node, positions one entry per anchor", () => {
  const g = buildH3Graph({ ...aform });
  assert.equal(g.keyframes.class_type, "H3Keyframes");
  assert.equal("kfinject" in g, false);
  assert.equal("blender_vid" in g, false);
  assert.equal("ref_videos.ref_video_0" in g.r2v.inputs, false);
  const we = g.keyframes.inputs as Record<string, unknown>;
  assert.equal(we.positions, "0%, 100%");
  assert.deepEqual(we.image_1, ["kf_start_in", 0]);
  assert.deepEqual(we.image_2, ["kf_end_in", 0]);
  const withoutEnd = buildH3Graph({ ...aform, kfEndName: undefined });
  const wo = withoutEnd.keyframes.inputs as Record<string, unknown>;
  assert.equal(wo.positions, "0%");
  assert.equal("image_2" in wo, false);
  assert.equal("kf_end_in" in withoutEnd, false);
  // one positions entry per connected anchor (node invariant, h3_keyframes.py)
  for (const graph of [g, withoutEnd]) {
    const kf = graph.keyframes.inputs as Record<string, unknown>;
    const anchors = ["image_1", "image_2", "image_3", "image_4", "image_5", "image_6", "images_batch"]
      .filter((k) => k in kf);
    assert.equal(
      String(kf.positions).split(",").length,
      anchors.length,
      `${kf.positions} must have one entry per anchor`,
    );
  }
});

test("A-form keyframes positive is combined with the refs conditioning chain", () => {
  const g = buildH3Graph({ ...aform });
  assert.deepEqual(g.keyframes.inputs.prompt, ["split", 0]);
  assert.deepEqual(g.kf_strength.inputs.conditioning, ["keyframes", 0]);
  assert.deepEqual(g.cond_combine.inputs.conditioning_1, ["cond_cs", 0]);
  assert.deepEqual(g.cond_combine.inputs.conditioning_2, ["kf_strength", 0]);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_combine", 0]);
  // latent stays the r2v empty AV latent (H3Keyframes emits the same shape)
  assert.deepEqual(g.samp_a.inputs.latent_image, ["r2v", 1]);
});

test("steps and length are numbers, not coerced strings", () => {
  for (const args of [cform, aform]) {
    const g = buildH3Graph({ ...args });
    assert.equal(typeof g.r2v.inputs.length, "number");
    assert.equal(typeof g.sched_a.inputs.steps, "number");
    assert.equal(typeof g.noise_a.inputs.noise_seed, "number");
  }
  assert.equal(typeof buildH3Graph({ ...aform }).keyframes.inputs.length, "number");
});

test("audio is exactly one dialogue wav (ref_audio_0) unless a timing ref is given", () => {
  const g = buildH3Graph({ ...cform });
  const audioKeys = Object.keys(g.r2v.inputs).filter((k) => k.startsWith("ref_audios."));
  assert.deepEqual(audioKeys, ["ref_audios.ref_audio_0"], "dialogue wav stays the only audio ref");
});

test("card ③a: montage timing ref rides as ref_audio_1 after the portrait (sample #31)", () => {
  const g = buildH3Graph({ ...cform, audioTimingRefName: "__TIMING__.wav" });
  assert.deepEqual(g.timing_in.inputs.audio, "__TIMING__.wav");
  assert.deepEqual(g.timing_guard.inputs.audio, ["timing_in", 0]);
  assert.deepEqual(g.r2v.inputs["ref_audios.ref_audio_0"], ["voice_guard", 0], "dialogue wav untouched");
  assert.deepEqual(g.r2v.inputs["ref_audios.ref_audio_1"], ["timing_guard", 0]);
  const without = buildH3Graph({ ...cform });
  assert.equal("timing_in" in without, false);
});

test("card ③b: UI photo refs ride after the identity slots on the C-form", () => {
  const ui = buildH3Graph({
    ...cform,
    refImageNames: undefined,
    uiPhotoNames: ["__UI_BOARD__.png", "__UI_CARD__.png"],
  });
  assert.deepEqual(ui.r2v.inputs["ref_images.ref_image_0"], ["ref_img_0", 0]);
  assert.deepEqual(ui.r2v.inputs["ref_images.ref_image_1"], ["ref_img_1", 0]);
  assert.equal(ui.ref_img_0.inputs.image, "__UI_BOARD__.png");
  const noRefs = buildH3Graph({ ...cform, refImageNames: undefined });
  const refKeys = Object.keys(noRefs.r2v.inputs).filter((k) => k.startsWith("ref_images."));
  assert.deepEqual(refKeys, [], "no portrait, no ui refs → ref_images stays empty");
});

test("variant B (documented fallback): ref_images populated, no Video 1, no keyframes", () => {
  const g = buildH3Graph({
    ...base,
    bindings: "",
    blockoutName: undefined,
    variant: "b",
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
    ...base,
    bindings: "",
    blockoutName: undefined,
    variant: "bkf",
    kfStartName: "__STILL__",
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
  const g = buildH3Graph({
    ...base,
    bindings: "",
    blockoutName: undefined,
    variant: "c",
    kfStartName: "__STILL__",
  });
  assert.equal("blender_vid" in g, false);
  assert.equal("ref_img_0" in g, false);
  assert.equal("ref_videos.ref_video_0" in g.r2v.inputs, false);
  assert.equal("ref_images.ref_image_0" in g.r2v.inputs, false);
  assert.ok(g.keyframes);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["cond_combine", 0]);
});

test("C8b knob: visualStrength override reaches every cond entry; 0.999 default unchanged", () => {
  const defC = buildH3Graph({ ...cform });
  const lowC = buildH3Graph({ ...cform, visualStrength: 0.4 });
  assert.equal(defC.cond_cs.inputs.visual_strength, 0.999);
  assert.equal(lowC.cond_cs.inputs.visual_strength, 0.4);
  const defA = buildH3Graph({ ...aform });
  const lowA = buildH3Graph({ ...aform, visualStrength: 0.4 });
  assert.equal(defA.cond_cs.inputs.visual_strength, COND_VISUAL);
  assert.equal(defA.kf_strength.inputs.visual_strength, COND_VISUAL);
  assert.equal(lowA.cond_cs.inputs.visual_strength, 0.4);
  assert.equal(lowA.kf_strength.inputs.visual_strength, 0.4);
});

/** MULTISHOT_WIRE_0921: cross-shot shapes — golden + pack-topology wiring +
 *  the refuse matrix. MS-A = chain_s2 build_graph verbatim; chained topology
 *  = pack H3_HardMode_Chained links (dec_v→H3LastFrame→ms.start_image,
 *  ConcatAV match_to_a). */
test("chained golden deep-equals + pack topology wiring (H3LastFrame→ms.start_image, ConcatAV)", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v-chained.api.json"), "utf8"),
  );
  const built = buildH3Graph({
    ...cform,
    chain: { script: "__MS_P2__\n---\n__MS_P3__", shotCount: 2, framesPerShot: 119, referenceImageName: "__MS_PORTRAIT__", voiceRefName: "__MS_WAV__" },
  });
  assert.deepEqual(built, golden);
  // pack wiring: shot 1's decoded video → H3LastFrame → ms.start_image
  assert.deepEqual(built.lastf.inputs.images, ["dec_v", 0]);
  assert.deepEqual(built.ms.inputs.start_image, ["lastf", 0]);
  // MS-A params
  assert.equal(built.ms.inputs.seed_per_shot, true);
  assert.equal(built.ms.inputs.chain_gain_control, "flatten");
  assert.equal(built.ms.inputs.self_anchor_voice, false);
  assert.equal(built.ms.inputs.two_pass_upscale, false);
  assert.equal(built.ms.inputs.steps, 8);
  assert.equal(built.ms.inputs.sampler_name, "euler");
  assert.deepEqual(built.ms.inputs.model, ["sigma_lora_a", 0], "ref2va chain (fl2va has no reference rows)");
  assert.equal(built.ms.inputs.shot_count, 2);
  assert.equal(built.ms.inputs.frames_per_shot, 119);
  assert.deepEqual(built.ms.inputs.reference_images, ["ms_hero_in", 0]);
  assert.deepEqual(built.ms.inputs.voice_ref, ["ms_voice_guard", 0]);
  // seam: stage B matched to stage A (pack default match_to_a)
  assert.deepEqual(built.concat.inputs.images_a, ["dec_v", 0]);
  assert.deepEqual(built.concat.inputs.audio_a, ["dec_a", 0]);
  assert.deepEqual(built.concat.inputs.images_b, ["ms", 0]);
  assert.deepEqual(built.concat.inputs.audio_b, ["ms", 1]);
  assert.equal(built.concat.inputs.match_b, "match_to_a");
  // the final take IS the concat
  assert.deepEqual(built.cv.inputs.images, ["concat", 0]);
  assert.deepEqual(built.cv.inputs.audio, ["concat", 1]);
  assert.deepEqual(built.save.inputs.video, ["cv", 0]);
});

test("standalone multishot golden = the MS-A 13-node shape", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v-multishot.api.json"), "utf8"),
  );
  const built = buildH3Graph({
    ...base,
    script: "",
    bindings: "",
    blockoutName: undefined,
    multishot: { script: "__MS_P1__\n---\n__MS_P2__", shotCount: 2, framesPerShot: 119, referenceImageName: "__MS_PORTRAIT__", startImageName: "__MS_ENDFRAME__" },
  });
  assert.deepEqual(built, golden);
  assert.deepEqual(
    Object.keys(built).sort(),
    ["avae", "clip", "cv", "lora_a", "ms", "ms_hero_in", "ms_start_in", "ref2va", "save", "sigma_lora_a", "vvae", "voice_guard", "voice_in"].sort(),
    "exactly the MS-A node set (chain_s2 build_graph)",
  );
  assert.deepEqual(built.ms.inputs.start_image, ["ms_start_in", 0]);
  assert.deepEqual(built.ms.inputs.voice_ref, ["voice_guard", 0]);
  assert.deepEqual(built.cv.inputs.images, ["ms", 0]);
  assert.deepEqual(built.cv.inputs.audio, ["ms", 1]);
  // no r2v block, no Video 1, no keyframes, no FBC anywhere
  for (const key of ["r2v", "blender_vid", "keyframes", "split", "fl2va", "lora_b", "fbc_ref2va", "solattn_ref2va", "cond_cs"]) {
    assert.equal(key in built, false, `${key} must not exist on the standalone multishot shape`);
  }
});

test("multishot refuse matrix: chain needs C-form; chain×multishot; standalone purity", () => {
  assert.throws(
    () => buildH3Graph({ ...aform, chain: { script: "x", shotCount: 1, framesPerShot: 119, referenceImageName: "__P__" } }),
    /chain_requires_cform/,
  );
  assert.throws(
    () =>
      buildH3Graph({
        ...cform,
        chain: { script: "x", shotCount: 1, framesPerShot: 119, referenceImageName: "__P__" },
        multishot: { script: "x", shotCount: 1, framesPerShot: 119, referenceImageName: "__P__" },
      }),
    /exclusive/,
  );
  assert.throws(
    () =>
      buildH3Graph({
        ...cform,
        multishot: { script: "x", shotCount: 1, framesPerShot: 119, referenceImageName: "__P__" },
      }),
    /multishot is standalone.*no Video 1/,
  );
});
