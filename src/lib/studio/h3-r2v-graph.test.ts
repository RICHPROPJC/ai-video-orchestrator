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

test("builder deep-equals the shotdag golden fixture", () => {
  const golden = JSON.parse(
    fs.readFileSync(path.resolve(process.cwd(), "workflows/h3-r2v.api.json"), "utf8"),
  );
  const built = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.deepEqual(built, golden);
});

test("kfEndName undefined → no kf_end_in node, no end_image input", () => {
  const withEnd = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  const withoutEnd = buildH3Graph({ ...args });
  assert.ok(withEnd.kf_end_in, "golden variant has kf_end_in");
  assert.deepEqual(withEnd.kfinject.inputs.end_image, ["kf_end_in", 0]);
  assert.equal("kf_end_in" in withoutEnd, false);
  assert.equal("end_image" in withoutEnd.kfinject.inputs, false);
  // everything else identical
  const a = { ...withEnd } as Record<string, unknown>;
  const b = { ...withoutEnd } as Record<string, unknown>;
  delete a.kf_end_in;
  delete b.kf_end_in;
  const ka = (a.kfinject as { inputs: Record<string, unknown> }).inputs;
  const kb = (b.kfinject as { inputs: Record<string, unknown> }).inputs;
  delete ka.end_image;
  delete kb.end_image;
  assert.deepEqual(a, b);
});

test("steps and length are numbers, not coerced strings", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  assert.equal(typeof g.r2v.inputs.length, "number");
  assert.equal(typeof g.sched_a.inputs.steps, "number");
  assert.equal(typeof g.kfinject.inputs.length, "number");
  assert.equal(typeof g.noise_a.inputs.noise_seed, "number");
});

test("zero ref_images keys anywhere in the graph", () => {
  const g = buildH3Graph({ ...args, kfEndName: "__KF_END__" });
  const hits = Object.entries(g).flatMap(([n, node]) =>
    Object.keys(node.inputs).filter((k) => k.includes("ref_images")).map((k) => `${n}.${k}`),
  );
  assert.deepEqual(hits, []);
  assert.deepEqual(g.r2v.inputs["ref_videos.ref_video_0"], ["blender_vid", 0]);
  assert.deepEqual(g.r2v.inputs["ref_audios.ref_audio_0"], ["voice_guard", 0]);
  assert.deepEqual(g.samp_a.inputs.latent_image, ["r2v", 1]);
  assert.deepEqual(g.guider_a.inputs.conditioning, ["kfinject", 0]);
});
