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
  /** One H3 generate = this 鏡. Next 鏡 is a new generate with its own 0–100%. */
  generation: "this_shot";
  sampler: "ref2va";
  /** fl2va is loaded for first-last generate-through; sampler stays ref2va (v6). */
  fl2vaLoaded: true;
  lanes: Record<H3Lane, string>;
  slots: { audio: H3SlotFill[]; photo: H3SlotFill[]; video: H3SlotFill[] };
  keyframes: H3KeyframePlan;
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
 * One shot, one H3 submit.
 * Audio = this wav in ref_audio_0 (one AuK take, not spine).
 * Video = this blockout in ref_video_0 (motion only).
 * Photos empty on variant A — identity is kfinject, not a prev-last ref.
 * 0% / 100% keyframes = THIS shot's U1.5 stills.
 */
export function planH3Shot(opts: {
  shot: Shot;
  prev?: Shot;
  wav: string;
  blockout: string;
  ourStill: string;
  ourEndStill?: string;
}): H3ShotPlan {
  const shotId = opts.shot.id;
  const endFile = opts.ourEndStill ?? opts.ourStill;
  const locationHop = Boolean(opts.prev && opts.prev.location !== opts.shot.location);
  const prevLast: H3KeyframePlan["prevLastFrame"] = locationHop
    ? {
        policy: "forbidden",
        reason: `${shotId} location changed (${opts.prev!.location} → ${opts.shot.location}): prev last frame as kf_start/ref_image eats the old scene and misses our still`,
      }
    : {
        policy: "inspect_only",
        reason: `${shotId} same world: prev last frame may be looked at after render, never as kf_start or ref_image — 0% is our U1.5 still`,
      };

  return {
    shotId,
    generation: "this_shot",
    sampler: "ref2va",
    fl2vaLoaded: true,
    lanes: {
      layout: `${shotId} blockout → ref_videos.ref_video_0 (Video 1 motion only)`,
      stills: `${shotId} U1.5 still → kfinject 0% and 100%`,
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
      photo: [],
      video: [
        {
          index: 0,
          kind: "video",
          bind: "ref_videos.ref_video_0",
          file: opts.blockout,
          role: "this shot grey blockout — motion only, ignore look",
        },
      ],
    },
    keyframes: {
      start: { at: "0%", source: "our_still", file: opts.ourStill },
      end: { at: "100%", source: opts.ourEndStill ? "our_end_still" : "our_still", file: endFile },
      prevLastFrame: prevLast,
    },
    stations: H3_KEYFRAME_STATIONS,
    missKeyframe: {
      tune: [
        "kf_start file = this U1.5 still (not prev last frame)",
        "drop prev last frame from every photo/video slot",
        "Video 1 = this blockout only",
        "identity pin in prose (same SKU, not a morph)",
        "keep kfinject length = wav snap frames",
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
  if (plan.keyframes.start.at !== "0%" || plan.keyframes.start.source !== "our_still") {
    throw new Error(`${plan.shotId}: 0% keyframe must be our U1.5 still`);
  }
  if (plan.keyframes.end.at !== "100%") {
    throw new Error(`${plan.shotId}: 100% keyframe must stay on this shot's still`);
  }
  if (plan.keyframes.prevLastFrame.policy === "forbidden" && plan.slots.photo.length) {
    throw new Error(`${plan.shotId}: location hop forbids photo refs (prev last would eat the old scene)`);
  }
}

/**
 * Fail loud when the submit about to POST would eat the old scene.
 * Missed keyframe → retune these files. Never TTS.
 */
export function assertH3SubmitWiring(
  plan: H3ShotPlan,
  wiring: {
    kfStart: string;
    kfEnd?: string;
    wav: string;
    blockout: string;
    refImageFiles?: string[];
    refVideoFiles?: string[];
    prevShotId?: string;
  },
): void {
  assertH3Plan(plan);
  const ourStart = fileName(plan.keyframes.start.file);
  const ourEnd = fileName(plan.keyframes.end.file);
  if (fileName(wiring.kfStart) !== ourStart) {
    throw new Error(
      `${plan.shotId}: kf_start is ${fileName(wiring.kfStart)}, must be our still ${ourStart} — generation will miss the set keyframe`,
    );
  }
  if (wiring.kfEnd && fileName(wiring.kfEnd) !== ourEnd) {
    throw new Error(`${plan.shotId}: kf_end is ${fileName(wiring.kfEnd)}, must be our still ${ourEnd}`);
  }
  if (fileName(wiring.wav) !== fileName(plan.slots.audio[0]!.file)) {
    throw new Error(`${plan.shotId}: ref_audio_0 must be this shot's wav, not the spine`);
  }
  if (fileName(wiring.blockout) !== fileName(plan.slots.video[0]!.file)) {
    throw new Error(`${plan.shotId}: Video 1 must be this shot's blockout`);
  }
  const prevId = wiring.prevShotId;
  /** Exact stem match only — never startsWith(prevId) (SH01 must not hit SH010). */
  const stemOf = (file: string) => fileName(file).replace(/\.[^.]+$/, "");
  const isPrevAsset = (file: string) => {
    if (!prevId) return false;
    const stem = stemOf(file);
    return stem === prevId || stem === `${prevId}_last` || stem === `${prevId}.last`;
  };
  if (prevId && isPrevAsset(wiring.kfStart)) {
    throw new Error(`${plan.shotId}: kf_start is prev last/still (${prevId}) — eats the old scene`);
  }
  if (plan.keyframes.prevLastFrame.policy === "forbidden" && prevId) {
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
    `${plan.shotId} · generate=${plan.generation} · sampler=${plan.sampler} · fl2va loaded`,
    ...H3_LANES.map((lane) => `lane ${lane}: ${plan.lanes[lane]}`),
    `0% ${plan.keyframes.start.file}`,
    `50% generate-through (not in v6 kfinject)`,
    `100% ${plan.keyframes.end.file}`,
    `prev last: ${plan.keyframes.prevLastFrame.policy}`,
    `  ${plan.keyframes.prevLastFrame.reason}`,
    "slots audio:",
    ...slots("audio"),
    "slots photo:",
    ...slots("photo"),
    "slots video:",
    ...slots("video"),
    "miss keyframe → tune:",
    ...plan.missKeyframe.tune.map((s) => `  ${s}`),
    "miss keyframe → never:",
    ...plan.missKeyframe.never.map((s) => `  ${s}`),
  ];
}

export function clinicH3Plans(): { hold: H3ShotPlan; hop: H3ShotPlan } {
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
  });
  const hop = planH3Shot({
    shot: product,
    prev: street,
    wav: "audio/SH02.h3.wav",
    blockout: "blockout/SH02.mp4",
    ourStill: "stills/SH02.png",
  });
  assertH3Plan(hold);
  assertH3Plan(hop);
  return { hold, hop };
}
