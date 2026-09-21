import test from "node:test";
import assert from "node:assert/strict";
import {
  assertH3Plan,
  assertH3SubmitWiring,
  clinicH3Plans,
  planH3Shot,
  sameVisualWorld,
  H3_KEYFRAME_STATIONS,
  H3_LANES,
  H3_SLOT_CAP,
} from "./h3-slots";
import type { Shot } from "./types";

const cam = { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0.4, z: 1.1 }, lensMm: 35 };
const mark = {
  characterId: "A",
  start: { x: 50, y: 50 },
  end: { x: 50, y: 50 },
  facing: 1,
  handL: { x: 44, y: 40 },
  handR: { x: 56, y: 40 },
  footL: { x: 47, y: 80 },
  footR: { x: 53, y: 80 },
  gait: "plant" as const,
};

function shot(over: Partial<Shot> & { id: string; location: string }): Shot {
  return {
    index: 1,
    heading: "h",
    size: "medium",
    action: "stand",
    dialogue: "全句一次",
    durationSec: 4,
    camera: cam,
    marks: [mark],
    stillPrompt: "",
    motionPrompt: "",
    ...over,
  };
}

test("four lanes and 3+3+3 slot caps", () => {
  assert.deepEqual([...H3_LANES], ["layout", "stills", "audio", "motion"]);
  assert.deepEqual(H3_SLOT_CAP, { audio: 3, photo: 3, video: 3 });
});

test("full mode percents: 0% and 100% wired, 50% generate-through not in kfinject", () => {
  assert.equal(H3_KEYFRAME_STATIONS[0]?.at, "0%");
  assert.equal(H3_KEYFRAME_STATIONS[0]?.take, "this shot U1.5 still");
  assert.equal(H3_KEYFRAME_STATIONS[1]?.at, "50%");
  assert.match(H3_KEYFRAME_STATIONS[1]?.node ?? "", /not wired/);
  assert.equal(H3_KEYFRAME_STATIONS[2]?.at, "100%");
  for (const s of H3_KEYFRAME_STATIONS) {
    assert.equal(s.never, "previous shot last frame");
  }
});

/** §5b C-form plan: Video 1 asset present — zero keyframes, portrait identity. */
test("C-form plan: blockout routes to form c — zero keyframes, angle portrait at ref_image_0", () => {
  const plan = planH3Shot({
    shot: shot({ id: "SH01", location: "茶餐廳門口" }),
    wav: "audio/SH01.h3.wav",
    blockout: "blockout/SH01.mp4",
    ourStill: "stills/SH01.png",
    anglePortraits: [{ characterId: "A", angle: "45", file: "portraits/A_45.png" }],
  });
  assertH3Plan(plan);
  assert.equal(plan.form, "c");
  assert.equal(plan.keyframes, null);
  assert.equal(plan.slots.video[0]!.bind, "ref_videos.ref_video_0");
  assert.equal(plan.slots.video[0]!.file, "blockout/SH01.mp4");
  assert.equal(plan.slots.photo[0]!.bind, "ref_images.ref_image_0");
  assert.equal(plan.slots.photo[0]!.file, "portraits/A_45.png");
  assert.match(plan.slots.photo[0]!.role, /45° portrait/);
  assert.equal(plan.slots.audio[0]!.file, "audio/SH01.h3.wav");
  assert.ok(plan.missKeyframe.never.some((s) => /coexist/i.test(s)));
});

/** §5b A-form plan: no Video 1 asset — still-to-video keyframes two ends. */
test("A-form plan: no blockout routes to form a — 0%/100% our stills, audio this shot only", () => {
  const plan = planH3Shot({
    shot: shot({ id: "SH01", location: "茶餐廳門口" }),
    wav: "audio/SH01.h3.wav",
    ourStill: "stills/SH01.png",
  });
  assertH3Plan(plan);
  assert.equal(plan.form, "a");
  assert.equal(plan.generation, "this_shot");
  assert.equal(plan.keyframes!.start.at, "0%");
  assert.equal(plan.keyframes!.start.file, "stills/SH01.png");
  assert.equal(plan.keyframes!.end.at, "100%");
  assert.equal(plan.slots.audio[0]!.file, "audio/SH01.h3.wav");
  assert.equal(plan.slots.photo.length, 0);
  assert.equal(plan.slots.video.length, 0);
});

test("location hop forbids prev last frame as identity — that is how the old scene gets eaten", () => {
  const prev = shot({ id: "SH01", location: "旺角街景" });
  const next = shot({ id: "SH02", location: "茶餐廳門口", props: [{ name: "長傘", shape: ["長"], forbid: ["叉"] }] });
  const plan = planH3Shot({
    shot: next,
    prev,
    wav: "audio/SH02.h3.wav",
    ourStill: "stills/SH02.png",
  });
  assert.equal(sameVisualWorld(prev, next), false);
  assert.equal(plan.form, "a");
  assert.equal(plan.keyframes!.prevLastFrame.policy, "forbidden");
  assert.match(plan.keyframes!.prevLastFrame.reason, /eats the old scene/);
  assert.equal(plan.keyframes!.start.file, "stills/SH02.png");
  assert.ok(plan.missKeyframe.never.some((s) => /tts/i.test(s)));
  assert.ok(plan.missKeyframe.never.some((s) => /0%/.test(s)));
  assert.ok(plan.missKeyframe.tune.some((s) => /U1\.5 still/.test(s)));
  assert.ok(!plan.missKeyframe.tune.some((s) => /split/.test(s)));
});

test("clinic: hold/hop C-form, still A-form", () => {
  const { hold, hop, still } = clinicH3Plans();
  assert.equal(hold.form, "c");
  assert.equal(hold.keyframes, null);
  assert.equal(hop.form, "c");
  assert.equal(still.form, "a");
  assert.ok(still.keyframes);
  assert.equal(still.keyframes!.prevLastFrame.policy, "inspect_only");
  assert.equal(hop.slots.video[0]!.file, "blockout/SH02.mp4");
});

test("§5b prohibition: C-form plan + keyframe wiring refuses (coexist ban at the plan layer)", () => {
  const plan = planH3Shot({
    shot: shot({ id: "SH01", location: "茶餐廳門口" }),
    wav: "audio/SH01.h3.wav",
    blockout: "blockout/SH01.mp4",
    ourStill: "stills/SH01.png",
    anglePortraits: [{ characterId: "A", angle: "front", file: "portraits/A.png" }],
  });
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "stills/SH01.png",
        wav: "audio/SH01.h3.wav",
        blockout: "blockout/SH01.mp4",
        refImageFiles: ["portraits/A.png"],
      }),
    /keyframes_video1_coexist/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfEnd: "stills/SH01.png",
        wav: "audio/SH01.h3.wav",
        blockout: "blockout/SH01.mp4",
        refImageFiles: ["portraits/A.png"],
      }),
    /keyframes_video1_coexist/,
  );
});

test("C-form wiring: wrong portrait or wrong blockout fails loud", () => {
  const plan = planH3Shot({
    shot: shot({ id: "SH01", location: "茶餐廳門口" }),
    wav: "audio/SH01.h3.wav",
    blockout: "blockout/SH01.mp4",
    ourStill: "stills/SH01.png",
    anglePortraits: [{ characterId: "A", angle: "45", file: "portraits/A_45.png" }],
  });
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        wav: "audio/SH01.h3.wav",
        blockout: "blockout/SH01.mp4",
        refImageFiles: ["portraits/A.png"],
      }),
    /must be the angle portrait A_45\.png/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        wav: "audio/SH01.h3.wav",
        blockout: "blockout/SH09.mp4",
        refImageFiles: ["portraits/A_45.png"],
      }),
    /Video 1 must be this shot's blockout/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        wav: "audio/SH01.h3.wav",
        blockout: "blockout/SH01.mp4",
      }),
    /ref_image_0 is \(none\), must be the angle portrait/,
  );
  assertH3SubmitWiring(plan, {
    wav: "audio/SH01.h3.wav",
    blockout: "blockout/SH01.mp4",
    refImageFiles: ["portraits/A_45.png"],
  });
});

test("A-form wiring: prev last as kf_start fails loud — do not tune TTS", () => {
  const prev = shot({ id: "SH01", location: "旺角街景" });
  const next = shot({ id: "SH02", location: "茶餐廳門口" });
  const plan = planH3Shot({
    shot: next,
    prev,
    wav: "audio/SH02.h3.wav",
    ourStill: "stills/SH02.png",
  });
  assert.equal(plan.form, "a");
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "motion/SH01.last.png",
        kfEnd: "stills/SH02.png",
        wav: "audio/SH02.h3.wav",
        prevShotId: "SH01",
      }),
    /eats the old scene|must be our still/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "stills/SH02.png",
        wav: "audio/SH02.h3.wav",
        refImageFiles: ["stills/SH01.png"],
        prevShotId: "SH01",
      }),
    /forbids prev still/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "stills/SH02.png",
        wav: "audio/SH02.h3.wav",
        refVideoFiles: ["motion/SH01.mp4"],
        prevShotId: "SH01",
      }),
    /previous H3 mp4/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "stills/SH02.png",
        wav: "audio/SH02.h3.wav",
        blockout: "blockout/SH02.mp4",
        prevShotId: "SH01",
      }),
    /A-form .* but the wiring carries a blockout/,
  );
  assertH3SubmitWiring(plan, {
    kfStart: "stills/SH02.png",
    kfEnd: "stills/SH02.png",
    wav: "audio/SH02.h3.wav",
    prevShotId: "SH01",
  });
});

test("prevId stem is exact — SH01 must not flag SH010 still", () => {
  const prev = shot({ id: "SH01", location: "旺角街景" });
  const next = shot({ id: "SH010", location: "茶餐廳門口" });
  const plan = planH3Shot({
    shot: next,
    prev,
    wav: "audio/SH010.h3.wav",
    blockout: "blockout/SH010.mp4",
    ourStill: "stills/SH010.png",
    anglePortraits: [{ characterId: "A", angle: "front", file: "portraits/A.png" }],
  });
  assertH3SubmitWiring(plan, {
    wav: "audio/SH010.h3.wav",
    blockout: "blockout/SH010.mp4",
    refImageFiles: ["portraits/A.png"],
    prevShotId: "SH01",
  });
});
