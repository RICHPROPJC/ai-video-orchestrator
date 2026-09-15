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

const cam = { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.1 }, lensMm: 35 };
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

test("0% and 100% are our stills; audio is this shot only", () => {
  const plan = planH3Shot({
    shot: shot({ id: "SH01", location: "茶餐廳門口" }),
    wav: "audio/SH01.h3.wav",
    blockout: "blockout/SH01.mp4",
    ourStill: "stills/SH01.png",
  });
  assertH3Plan(plan);
  assert.equal(plan.generation, "this_shot");
  assert.equal(plan.keyframes.start.at, "0%");
  assert.equal(plan.keyframes.start.file, "stills/SH01.png");
  assert.equal(plan.keyframes.end.at, "100%");
  assert.equal(plan.slots.audio[0]!.file, "audio/SH01.h3.wav");
  assert.equal(plan.slots.photo.length, 0);
  assert.equal(plan.slots.video[0]!.bind, "ref_videos.ref_video_0");
});

test("location hop forbids prev last frame as start — that is how the old scene gets eaten", () => {
  const prev = shot({ id: "SH01", location: "旺角街景" });
  const next = shot({ id: "SH02", location: "茶餐廳門口", props: [{ name: "長傘", shape: ["長"], forbid: ["叉"] }] });
  const plan = planH3Shot({
    shot: next,
    prev,
    wav: "audio/SH02.h3.wav",
    blockout: "blockout/SH02.mp4",
    ourStill: "stills/SH02.png",
  });
  assert.equal(sameVisualWorld(prev, next), false);
  assert.equal(plan.keyframes.prevLastFrame.policy, "forbidden");
  assert.match(plan.keyframes.prevLastFrame.reason, /eats the old scene/);
  assert.equal(plan.keyframes.start.file, "stills/SH02.png");
  assert.ok(plan.missKeyframe.never.some((s) => /tts/i.test(s)));
  assert.ok(plan.missKeyframe.never.some((s) => /0%/.test(s)));
  assert.ok(plan.missKeyframe.tune.some((s) => /U1\.5 still/.test(s)));
  assert.ok(!plan.missKeyframe.tune.some((s) => /split/.test(s)));
});

test("clinic hop vs hold", () => {
  const { hold, hop } = clinicH3Plans();
  assert.equal(hold.keyframes.prevLastFrame.policy, "inspect_only");
  assert.equal(hop.keyframes.prevLastFrame.policy, "forbidden");
});

test("submit wiring: prev last as kf_start fails loud — do not tune TTS", () => {
  const prev = shot({ id: "SH01", location: "旺角街景" });
  const next = shot({ id: "SH02", location: "茶餐廳門口" });
  const plan = planH3Shot({
    shot: next,
    prev,
    wav: "audio/SH02.h3.wav",
    blockout: "blockout/SH02.mp4",
    ourStill: "stills/SH02.png",
  });
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "motion/SH01.last.png",
        kfEnd: "stills/SH02.png",
        wav: "audio/SH02.h3.wav",
        blockout: "blockout/SH02.mp4",
        prevShotId: "SH01",
      }),
    /eats the old scene|must be our still/,
  );
  assert.throws(
    () =>
      assertH3SubmitWiring(plan, {
        kfStart: "stills/SH02.png",
        wav: "audio/SH02.h3.wav",
        blockout: "blockout/SH02.mp4",
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
        blockout: "blockout/SH02.mp4",
        refVideoFiles: ["motion/SH01.mp4"],
        prevShotId: "SH01",
      }),
    /previous H3 mp4/,
  );
  assertH3SubmitWiring(plan, {
    kfStart: "stills/SH02.png",
    kfEnd: "stills/SH02.png",
    wav: "audio/SH02.h3.wav",
    blockout: "blockout/SH02.mp4",
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
  });
  assertH3SubmitWiring(plan, {
    kfStart: "stills/SH010.png",
    wav: "audio/SH010.h3.wav",
    blockout: "blockout/SH010.mp4",
    prevShotId: "SH01",
  });
});
