import path from "node:path";
import type { Shot } from "./types";

/** Factory order into one H3 submit. Not four ffmpeg edits. */
export const H3_LANES = ["layout", "stills", "audio", "motion"] as const;
export type H3Lane = (typeof H3_LANES)[number];

/** MiniMaxH3ReferenceToVideo slot caps — three of each, different jobs. */
export const H3_SLOT_CAP = { audio: 3, photo: 3, video: 3 } as const;

export type H3SlotKind = "audio" | "photo" | "video";
export type H3SlotFill = {
  index: 0 | 1 | 2;
  kind: H3SlotKind;
  bind: string;
  file: string;
  role: string;
};

export type KeyframeSource = "our_still" | "our_end_still";
export type PrevLastPolicy = "forbidden" | "inspect_only";

/** §5b plan form, routed by the Video 1 asset (the blockout mp4):
 *  - "c": Video 1 present — zero H3Keyframes, identity rides
 *    ref_images.ref_image_0 = the character's angle portrait (per refAngle)
 *  - "a": no Video 1 — still-to-video, H3Keyframes 0%/100% on our U1.5 stills
 *  The two never coexist (E2E SC-0921-9V4Y: keyframes × Video 1 = 4/8/20步全滅). */
export type H3PlanForm = "a" | "c";

/** One character's identity ref on the C-form — the angle-version portrait
 *  the refAngle column picks (front | 45). */
export type AnglePortrait = { characterId: string; angle: "front" | "45"; file: string };

/**
 * Full-mode percent of THIS generation (one 鏡), not the whole spine.
 * v6 wires only 0% + 100% on H3KeyframeInject. 50% is generate-through.
 * Do not add a percent field to kfinject — that would break the golden graph.
 */
export const H3_KEYFRAME_STATIONS = [
  {
    at: "0%",
    node: "H3KeyframeInject.start_image",
    take: "this shot U1.5 still",
    never: "previous shot last frame",
  },
  {
    at: "50%",
    node: "not wired in v6",
    take: "keep generating through this shot (ref2va)",
    never: "previous shot last frame",
    note: "MiniMax H3Keyframes positions like '0%, 50%, 100%' — not in workflows/h3-r2v.api.json",
  },
  {
    at: "100%",
    node: "H3KeyframeInject.end_image",
    take: "this shot U1.5 still (or planned end still of this shot)",
    never: "previous shot last frame",
  },
] as const;

export type H3KeyframeStation = (typeof H3_KEYFRAME_STATIONS)[number];

export type H3KeyframePlan = {
  /** H3KeyframeInject start_image = frame 0 of THIS generation. */
  start: { at: "0%"; source: KeyframeSource; file: string };
  /** Optional last-frame anchor of THIS generation — still OUR still, not prev last. */
  end: { at: "100%"; source: KeyframeSource; file: string };
  /** Previous shot last frame. Never kf_start. Default: stay out of every visual slot. */
  prevLastFrame: { policy: PrevLastPolicy; reason: string };
};

export type H3ShotPlan = {
  shotId: string;
  /** §5b form of this plan — the Video 1 asset decides (see H3PlanForm). */
  form: H3PlanForm;
  /** One H3 generate = this 鏡. Next 鏡 is a new generate with its own 0–100%. */
  generation: "this_shot";
  sampler: "ref2va";
  /** fl2va is loaded for first-last generate-through; sampler stays ref2va (v6). */
  fl2vaLoaded: true;
  lanes: Record<H3Lane, string>;
  slots: { audio: H3SlotFill[]; photo: H3SlotFill[]; video: H3SlotFill[] };
  /** null on the C-form — zero keyframe nodes, identity rides ref_image_0. */
  keyframes: H3KeyframePlan | null;
  stations: typeof H3_KEYFRAME_STATIONS;
  missKeyframe: { tune: string[]; never: string[] };
};

export function sameVisualWorld(prev: Shot | undefined, shot: Shot): boolean {
  if (!prev) return true;
  if (prev.location !== shot.location) return false;
  const a = (prev.props ?? []).map((p) => p.name).join("|");
  const b = (shot.props ?? []).map((p) => p.name).join("|");
  return a === b;
}

function fileName(file: string) {
  return path.basename(file);
}

/**
 * One shot, one H3 submit, in one §5b form — the Video 1 asset routes:
 *  - C-form (blockout given): Video 1 = this blockout in ref_video_0 (motion
 *    only), zero keyframes, photos = angle portraits in ref_image_N (per
 *    refAngle), identity pin names <Picture 1>.
 *  - A-form (no blockout): still-to-video — 0% / 100% keyframes = THIS shot's
 *    U1.5 stills, photos empty (identity is kfinject, not a prev-last ref).
 * Audio = this wav in ref_audio_0 (one AuK take, not spine) in both forms.
 */
export function planH3Shot(opts: {
  shot: Shot;
  prev?: Shot;
  wav: string;
  /** §5b routing field: present → C-form; absent → A-form still-to-video. */
  blockout?: string;
  ourStill: string;
  ourEndStill?: string;
  /** C-form: per-character angle portraits for ref_images.ref_image_N. */
  anglePortraits?: AnglePortrait[];
}): H3ShotPlan {
  const shotId = opts.shot.id;
  const endFile = opts.ourEndStill ?? opts.ourStill;
  const form: H3PlanForm = opts.blockout ? "c" : "a";
  const locationHop = Boolean(opts.prev && opts.prev.location !== opts.shot.location);
  const prevLast: H3KeyframePlan["prevLastFrame"] = locationHop
    ? {
        policy: "forbidden",
        reason: `${shotId} location changed (${opts.prev!.location} → ${opts.shot.location}): prev last frame as kf_start/ref_image eats the old scene and misses our still`,
      }
    : {
        policy: "inspect_only",
        reason: `${shotId} same world: prev last frame may be looked at after render, never as kf_start or ref_image — identity is our portrait/still, never prev last`,
      };

  return {
    shotId,
    form,
    generation: "this_shot",
    sampler: "ref2va",
    fl2vaLoaded: true,
    lanes: {
      layout: form === "c"
        ? `${shotId} blockout → ref_videos.ref_video_0 (Video 1 motion only)`
        : `${shotId} no Video 1 asset — still-to-video lane`,
      stills: form === "c"
        ? `${shotId} angle portrait(s) → ref_images.ref_image_N (<Picture 1> identity; refAngle ${opts.shot.refAngle ?? "front"})`
        : `${shotId} U1.5 still → H3Keyframes 0% and 100%`,
      audio: `${shotId} wav → ref_audios.ref_audio_0 (one take, this shot, not spine)`,
      motion: `H3 generate ${shotId} only; concat -c copy later, no xfade`,
    },
    slots: {
      audio: [
        {
          index: 0,
          kind: "audio",
          bind: "ref_audios.ref_audio_0",
          file: opts.wav,
          role: "this shot's one AuK /tts take (full line, not spliced)",
        },
      ],
      photo: (opts.anglePortraits ?? []).map((p, i) => ({
        index: i as 0 | 1 | 2,
        kind: "photo" as const,
        bind: `ref_images.ref_image_${i}`,
        file: p.file,
        role: `${p.characterId} ${p.angle}° portrait — <Picture ${i + 1}> identity, appearance only (C-form, §5b)`,
      })),
      video: form === "c"
        ? [
            {
              index: 0,
              kind: "video",
              bind: "ref_videos.ref_video_0",
              file: opts.blockout!,
              role: "this shot grey blockout — motion only, ignore look",
            },
          ]
        : [],
    },
    keyframes: form === "c"
      ? null
      : {
          start: { at: "0%", source: "our_still", file: opts.ourStill },
          end: { at: "100%", source: opts.ourEndStill ? "our_end_still" : "our_still", file: endFile },
          prevLastFrame: prevLast,
        },
    stations: H3_KEYFRAME_STATIONS,
    missKeyframe: form === "c"
      ? {
          tune: [
            "ref_image_0 = this character's angle portrait (refAngle column picks front/45°)",
            "Video 1 = this blockout only (positions/timing, never look)",
            "identity pin in prose names <Picture 1>, not a keyframe image",
            "keep Video 1 length = wav snap frames",
          ],
          never: [
            "do not retune or split AuK /tts",
            "do not wire H3Keyframes together with Video 1 (§5b coexist ban)",
            "do not swap the 45° shot's portrait for the frontal version (B-lane face-drag regression)",
            "do not put previous H3 mp4 in ref_video_1",
          ],
        }
      : {
          tune: [
            "kf_start file = this U1.5 still (not prev last frame)",
            "drop prev last frame from every photo/video slot",
            "no Video 1 asset — motion comes from the prose action line",
            "identity pin in prose (same SKU, not a morph)",
            "keep keyframes length = wav snap frames",
          ],
          never: [
            "do not retune or split AuK /tts",
            "do not xfade/setpts two H3 clips to fake the keyframe",
            "do not put prev last frame at 0%",
            "do not put previous H3 mp4 in ref_video_1",
          ],
        },
  };
}

export function assertH3Plan(plan: H3ShotPlan): void {
  if (plan.generation !== "this_shot") {
    throw new Error(`${plan.shotId}: H3 generate is this 鏡, not the whole spine`);
  }
  if (plan.slots.audio.length !== 1 || plan.slots.audio[0]?.index !== 0) {
    throw new Error(`${plan.shotId}: H3 audio must be exactly ref_audio_0 for this shot`);
  }
  if (plan.slots.audio.length > H3_SLOT_CAP.audio) throw new Error("audio slots overflow");
  if (plan.slots.photo.length > H3_SLOT_CAP.photo) throw new Error("photo slots overflow");
  if (plan.slots.video.length > H3_SLOT_CAP.video) throw new Error("video slots overflow");
  if (plan.form === "c") {
    if (plan.keyframes !== null) {
      throw new Error(`${plan.shotId}: C-form plans carry no keyframes (§5b: keyframes × Video 1 coexist ban)`);
    }
    if (plan.slots.video.length !== 1 || plan.slots.video[0]?.bind !== "ref_videos.ref_video_0") {
      throw new Error(`${plan.shotId}: C-form requires the blockout as ref_video_0 (motion only)`);
    }
    return;
  }
  if (plan.keyframes?.start.at !== "0%" || plan.keyframes?.start.source !== "our_still") {
    throw new Error(`${plan.shotId}: 0% keyframe must be our U1.5 still`);
  }
  if (plan.keyframes?.end.at !== "100%") {
    throw new Error(`${plan.shotId}: 100% keyframe must stay on this shot's still`);
  }
  if (plan.keyframes?.prevLastFrame.policy === "forbidden" && plan.slots.photo.length) {
    throw new Error(`${plan.shotId}: location hop forbids photo refs (prev last would eat the old scene)`);
  }
}

/**
 * Fail loud when the submit about to POST would eat the old scene — or would
 * emit the §5b dead shape (Video 1 + H3Keyframes in one graph). Missed
 * identity anchor → retune these files. Never TTS.
 */
export function assertH3SubmitWiring(
  plan: H3ShotPlan,
  wiring: {
    kfStart?: string;
    kfEnd?: string;
    wav: string;
    blockout?: string;
    refImageFiles?: string[];
    refVideoFiles?: string[];
    prevShotId?: string;
  },
): void {
  assertH3Plan(plan);
  if (plan.form === "c" && (wiring.kfStart || wiring.kfEnd)) {
    throw new Error(
      `keyframes_video1_coexist: ${plan.shotId} is C-form (Video 1 in ref_video_0) but the wiring carries ` +
        `keyframe stills — keyframes × Video 1 is the §5b model-level double exposure; drop one`,
    );
  }
  if (plan.form === "a" && wiring.blockout) {
    throw new Error(
      `${plan.shotId}: plan is A-form (no Video 1 asset) but the wiring carries a blockout — re-route the plan`,
    );
  }
  if (fileName(wiring.wav) !== fileName(plan.slots.audio[0]!.file)) {
    throw new Error(`${plan.shotId}: ref_audio_0 must be this shot's wav, not the spine`);
  }
  const prevId = wiring.prevShotId;
  /** Exact stem match only — never startsWith(prevId) (SH01 must not hit SH010). */
  const stemOf = (file: string) => fileName(file).replace(/\.[^.]+$/, "");
  const isPrevAsset = (file: string) => {
    if (!prevId) return false;
    const stem = stemOf(file);
    return stem === prevId || stem === `${prevId}_last` || stem === `${prevId}.last`;
  };
  if (plan.form === "c") {
    if (fileName(wiring.blockout ?? "") !== fileName(plan.slots.video[0]!.file)) {
      throw new Error(`${plan.shotId}: Video 1 must be this shot's blockout`);
    }
    const wired = wiring.refImageFiles ?? [];
    for (const [i, slot] of plan.slots.photo.entries()) {
      if (fileName(wired[i] ?? "") !== fileName(slot.file)) {
        throw new Error(
          `${plan.shotId}: ref_image_${i} is ${fileName(wired[i] ?? "(none)")}, must be the angle portrait ${fileName(slot.file)}`,
        );
      }
    }
    if (plan.keyframes === null && prevId) {
      for (const f of [...(wiring.refImageFiles ?? []), ...(wiring.refVideoFiles ?? [])]) {
        if (isPrevAsset(f)) {
          throw new Error(`${plan.shotId}: prev still/mp4 (${prevId}) must not ride a C-form ref slot`);
        }
      }
    }
    return;
  }
  const ourStart = fileName(plan.keyframes!.start.file);
  const ourEnd = fileName(plan.keyframes!.end.file);
  if (fileName(wiring.kfStart ?? "") !== ourStart) {
    throw new Error(
      `${plan.shotId}: kf_start is ${fileName(wiring.kfStart ?? "(none)")}, must be our still ${ourStart} — generation will miss the set keyframe`,
    );
  }
  if (wiring.kfEnd && fileName(wiring.kfEnd) !== ourEnd) {
    throw new Error(`${plan.shotId}: kf_end is ${fileName(wiring.kfEnd)}, must be our still ${ourEnd}`);
  }
  if (prevId && isPrevAsset(wiring.kfStart ?? "")) {
    throw new Error(`${plan.shotId}: kf_start is prev last/still (${prevId}) — eats the old scene`);
  }
  if (plan.keyframes!.prevLastFrame.policy === "forbidden" && prevId) {
    for (const f of wiring.refImageFiles ?? []) {
      if (isPrevAsset(f)) {
        throw new Error(`${plan.shotId}: location hop forbids prev still as ref_image`);
      }
    }
    for (const f of wiring.refVideoFiles ?? []) {
      if (isPrevAsset(f)) {
        throw new Error(`${plan.shotId}: do not put previous H3 mp4 in a video slot`);
      }
    }
  }
}

export function formatH3Plan(plan: H3ShotPlan): string[] {
  const slots = (kind: H3SlotKind) => {
    const filled = plan.slots[kind];
    const lines = filled.map((s) => `  ${s.bind} = ${s.file} · ${s.role}`);
    for (let i = filled.length; i < H3_SLOT_CAP[kind]; i += 1) {
      lines.push(`  ref_${kind === "photo" ? "images.ref_image" : kind === "audio" ? "audios.ref_audio" : "videos.ref_video"}_${i} = empty`);
    }
    return lines;
  };
  return [
    `${plan.shotId} · form=${plan.form} (§5b) · generate=${plan.generation} · sampler=${plan.sampler} · fl2va loaded`,
    ...H3_LANES.map((lane) => `lane ${lane}: ${plan.lanes[lane]}`),
    ...(plan.keyframes
      ? [
          `0% ${plan.keyframes.start.file}`,
          `50% generate-through (not in v6 kfinject)`,
          `100% ${plan.keyframes.end.file}`,
          `prev last: ${plan.keyframes.prevLastFrame.policy}`,
          `  ${plan.keyframes.prevLastFrame.reason}`,
        ]
      : [
          `keyframes: none — C-form (§5b), identity rides ref_image_0 angle portrait`,
          `prev last: inspect only, never a ref slot`,
        ]),
    "slots audio:",
    ...slots("audio"),
    "slots photo:",
    ...slots("photo"),
    "slots video:",
    ...slots("video"),
    "miss identity → tune:",
    ...plan.missKeyframe.tune.map((s) => `  ${s}`),
    "miss identity → never:",
    ...plan.missKeyframe.never.map((s) => `  ${s}`),
  ];
}

export function clinicH3Plans(): { hold: H3ShotPlan; hop: H3ShotPlan; still: H3ShotPlan } {
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
  const cam = { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0.4, z: 1.1 }, lensMm: 35 };
  const street: Shot = {
    id: "SH01",
    index: 1,
    heading: "street",
    size: "medium",
    location: "旺角街景",
    action: "walk",
    dialogue: "行啦",
    durationSec: 5,
    camera: cam,
    marks: [mark],
    stillPrompt: "",
    motionPrompt: "",
  };
  const product: Shot = {
    ...street,
    id: "SH02",
    index: 2,
    heading: "product",
    location: "茶餐廳門口",
    props: [{ name: "長傘", shape: ["長"], forbid: ["叉"] }],
  };
  const hold = planH3Shot({
    shot: street,
    wav: "audio/SH01.h3.wav",
    blockout: "blockout/SH01.mp4",
    ourStill: "stills/SH01.png",
    anglePortraits: [{ characterId: "A", angle: "front", file: "portraits/A.png" }],
  });
  const hop = planH3Shot({
    shot: product,
    prev: street,
    wav: "audio/SH02.h3.wav",
    blockout: "blockout/SH02.mp4",
    ourStill: "stills/SH02.png",
    anglePortraits: [{ characterId: "A", angle: "front", file: "portraits/A.png" }],
  });
  const still = planH3Shot({
    shot: street,
    wav: "audio/SH01.h3.wav",
    ourStill: "stills/SH01.png",
  });
  assertH3Plan(hold);
  assertH3Plan(hop);
  assertH3Plan(still);
  return { hold, hop, still };
}
