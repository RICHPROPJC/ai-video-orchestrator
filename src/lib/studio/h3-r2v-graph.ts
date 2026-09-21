import type { ComfyGraph } from "./comfy";

// v6-parity constants — shotdag h3_submit.py, verbatim values (receipts in
// NOTES_h3_graph.md "v6 parity"). Defaults with receipts, not locked numbers.
const WIDTH = 864;
const HEIGHT = 480;
const LORA_STRENGTH = 1.0;
const SAMPLER = "euler"; // turbo 8-step v1.0（Chau 0921裁）
const SCHEDULER = "simple";
const REF_IMAGE_SIZE = "max"; // 2048px short edge
const SIGMA_VIDEO = 12.0;
const SIGMA_AUDIO = 3.0;
const SOLATTN_TAU = 0.5;
const FBC_THRESHOLD = 0.15;
const FBC_START = 2;
const FBC_END = 2;
const FBC_SKIP = 2;
export const COND_VISUAL = 0.999;
const COND_AUDIO = 1.0;
const VOICE_MAX_SECONDS = 16.0; // covers the 17k+5 max (~15.1s)
const BLOCKOUT_VHS = {
  force_rate: 24.0,
  frame_load_cap: 32,
  skip_first_frames: 0,
  select_every_nth: 10,
};

/** copied from shotdag h3_submit.BINDINGS — the grey-model <Video 1> contract.
 *  A-form (no Video 1, keyframes two ends) only: it names the start/end
 *  keyframe images, which the C-form graph never wires. */
export const BINDINGS =
  "The start and end keyframe images are the physical beginning and near-end of this " +
  "shot: faces, costumes and props come only from them and continue exactly. " +
  "The grey placeholders of <Video 1> are motion-only: follow positions and timing, " +
  "ignore their appearance. Do not add people.";

/** C-form contract (§5b, E2E SC-0921-9V4Y SH01.c8, tg 17976 — verbatim minus
 *  the scene sentence, which rides the prose): <Picture 1> (the angle portrait
 *  in ref_image_0) is the identity reference; <Video 1> is motion only. */
export const BINDINGS_CFORM =
  "<Picture 1> is the sole appearance and identity reference. " +
  "<Video 1> is motion only: follow its positions, choreography and timing, " +
  "ignore its appearance, clothing, background and lighting entirely — " +
  "it is never a look reference. Do not add people.";

export type H3GraphModels = {
  textEncoder: string;
  encoderType: string;
  videoVae: string;
  audioVae: string;
  ref2va: string;
  fl2va: string;
  turboLora: string;
};

export type H3GraphVariant = "a" | "b" | "bkf" | "c";

export type BuildH3GraphOpts = {
  script: string;
  bindings: string;
  frames: number;
  steps: number;
  seed: number;
  filenamePrefix: string;
  /** A-form only (no Video 1): the U1.5 still anchoring H3Keyframes at 0%. */
  kfStartName?: string;
  kfEndName?: string;
  /** §5b routing field: a Video 1 asset present → C-form (zero H3Keyframes,
   *  ref_images.ref_image_0 = angle portrait); absent → A-form (H3Keyframes
   *  0%/100%). Passing keyframe names together with a Video 1 throws. */
  blockoutName?: string;
  wavName: string;
  models: H3GraphModels;
  /** default A — the production path; §5b splits it by the Video 1 asset:
   *  with Video 1 the graph is C-form (zero keyframes, ref_image_0 = angle
   *  portrait, Video 1 motion-only); without it A-form still-to-video
   *  (H3Keyframes 0%/100%). B/BKF are DOCUMENTED FALLBACK (card C ②, 0919):
   *  the character-image ref path is officially legitimate (samples
   *  #17/#22/#23/#31/#34), but on the A path identity is already burned into
   *  the still via U1.5 /edit, so the ref lock moves earlier — B/BKF serve
   *  shots with NO still-pinned identity. C stays a verify alternate (zero
   *  refs). B/BKF/C never take a Video 1. */
  variant?: H3GraphVariant;
  /** ref_images.ref_image_N upload names — C-form: angle portrait(s) first
   *  (per refAngle); B/BKF: still first, then portraits. */
  refImageNames?: string[];
  /** A only (card C ③b): UI/infographic shot photo refs — the law-d channel
   *  (text/screen shots MAY feed H3 refs). Mapping prose goes with them
   *  (cookbook case02 Image-N numbering + sample #34 mapping table). Story
   *  shots pass nothing: story ref_images stay empty. */
  uiPhotoNames?: string[];
  /** A only (card C ③a): montage beat-cut timing ref → ref_audios.ref_audio_1
   *  (sample #31: cuts land on the beats of an audio timing reference). The
   *  dialogue wav keeps ref_audio_0 untouched — exactly one dialogue wav. */
  audioTimingRefName?: string;
  /** default COND_VISUAL 0.999. C8b probe may lower this; do not change the golden default. */
  visualStrength?: number;
  /** T42 prose mode (packet-decided in h3-prose). Receipt metadata only —
   *  node ids and values stay identical to the v6 golden in BOTH modes;
   *  prose text reaches the graph via the split node input, not here. */
  proseMode?: "action-short" | "identity-long";
};

/** v6-parity R2V graph in two §5b forms, routed by the Video 1 asset:
 *
 *  C-form (Video 1 present — the motion-shot production recipe, E2E
 *  SC-0921-9V4Y SH01.c8, tg 17976): zero H3Keyframes nodes, identity rides
 *  ref_images.ref_image_0 = the character's angle portrait (per refAngle),
 *  <Video 1> blockout via VHS_LoadVideo carries motion only, BINDINGS_CFORM
 *  on the split node, and the guider's conditioning is cond_cs alone.
 *
 *  A-form (no Video 1 — still-to-video): official H3Keyframes anchors 0%
 *  (and 100% with kfEnd), combined with the r2v conditioning via
 *  ConditioningCombine, zero story ref_images, BINDINGS names the stills.
 *
 *  Shared: turbo LoRA via H3LoraStack, SigmaShift model chain (FBC/SolAttn
 *  only on the 4-step road), H3EpisodeSplit script, H3FreeTextEncoder +
 *  H3ConditionStrength conditioning, voice via LoadAudio->H3ReferenceAudio —
 *  all constants identical to shotdag h3_submit (0919 card C ① swapped ONLY
 *  the keyframe mechanism: H3KeyframeInject start/end → official H3Keyframes
 *  node; CFORM_0921 then split the two forms).
 *
 *  H3Keyframes (live node1 object_info, ComfyUI-H3-Multishot h3_keyframes.py):
 *  required clip/vae/prompt/width/height/length/positions, optional image_1–6
 *  + images_batch. Keyframe anchoring rides the conditioning
 *  (minimax_keyframes + minimax_frame_count; the latent output is the same
 *  _empty_av_latent the r2v emits). images_batch is a batch of ANCHORS —
 *  several frames at each end to pin complex motion, or frames kept from a
 *  source video — NOT a slot for arbitrary stills; when it is ever wired,
 *  one positions entry per anchor across both (anchors batch comes AFTER the
 *  image_N slots). % positioning is native to positions, so no percent field
 *  exists anywhere else. */
export function buildH3Graph(opts: BuildH3GraphOpts): ComfyGraph {
  const variant = opts.variant ?? "a";
  const m = opts.models;
  // §5b (CHAU_FULL_FLOW_LAW, E2E SC-0921-9V4Y six-way A/B): H3Keyframes ×
  // <Video 1> coexistence is a model-level fight — 4/8/20 steps all failed
  // (double exposure / identity morph). The Video 1 asset is THE routing
  // field: present → C-form (zero keyframes, ref_image_0 = angle portrait),
  // absent → A-form still-to-video (H3Keyframes 0%/100%). Refuse to emit the
  // dead coexistence shape — same refuse-to-emit family as prompt_too_thin.
  const hasVideo1 = Boolean(opts.blockoutName);
  if (hasVideo1 && (opts.kfStartName || opts.kfEndName)) {
    throw new Error(
      `keyframes_video1_coexist: <Video 1> (${opts.blockoutName}) and H3Keyframes ` +
        `(${opts.kfStartName ?? ""}${opts.kfEndName ? " + kf_end" : ""}) cannot ride one graph — ` +
        `model-level double exposure (§5b, E2E SC-0921-9V4Y 4/8/20步全滅); ` +
        `Video 1 in → C-form zero keyframes, keyframes in → no Video 1`,
    );
  }
  if (variant === "a" && !hasVideo1 && !opts.kfStartName) {
    throw new Error(
      `a-form requires kfStartName: no Video 1 asset means still-to-video — H3Keyframes anchors 0% on the U1.5 still`,
    );
  }
  const g: ComfyGraph = {
    clip: { class_type: "H3ClipLoaderAny", inputs: { clip_name: m.textEncoder, type: m.encoderType } },
    vvae: { class_type: "VAELoader", inputs: { vae_name: m.videoVae } },
    avae: { class_type: "VAELoader", inputs: { vae_name: m.audioVae } },
    ref2va: { class_type: "H3ModelLoaderAny", inputs: { model_name: m.ref2va } },
    fl2va: { class_type: "H3ModelLoaderAny", inputs: { model_name: m.fl2va } },
    split: { class_type: "H3EpisodeSplit", inputs: { script: opts.script, bindings: opts.bindings } },
  };
  // model chain per loader: turbo-4 road keeps the accel patch
  // (H3ModelLoaderAny -> H3FirstBlockCache -> SolAttn -> H3LoraStack ->
  // MiniMaxH3SigmaShift); any other step count (8-step v1.0, §5b B1v3) skips
  // FBC/SolAttn entirely — the patch is hard-locked to the 4-step schedule
  // and crashes structurally off it (tensor 17428≠17418).
  const turbo4 = opts.steps === 4;
  for (const [tag, loader] of [["lora_a", "ref2va"], ["lora_b", "fl2va"]] as const) {
    if (turbo4) {
      g[`fbc_${loader}`] = {
        class_type: "H3FirstBlockCache",
        inputs: {
          model: [loader, 0],
          threshold: FBC_THRESHOLD,
          start_step: FBC_START,
          end_dense_steps: FBC_END,
          max_consecutive_skips: FBC_SKIP,
        },
      };
      g[`solattn_${loader}`] = {
        class_type: "SolAttnMiniMaxH3Patcher",
        inputs: { model: [`fbc_${loader}`, 0], enabled: true, tau: SOLATTN_TAU, thresh_type: "diag" },
      };
    }
    const loraInputs: Record<string, unknown> = { model: [turbo4 ? `solattn_${loader}` : loader, 0] };
    for (let i = 1; i <= 4; i += 1) {
      loraInputs[`lora_${i}`] = i === 1 ? m.turboLora : "None";
      loraInputs[`strength_${i}`] = LORA_STRENGTH;
    }
    g[tag] = { class_type: "H3LoraStack", inputs: loraInputs };
    g[`sigma_${tag}`] = {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: [tag, 0], shift_video: SIGMA_VIDEO, shift_audio: SIGMA_AUDIO },
    };
  }
  const modelA = ["sigma_lora_a", 0];
  // voice: LoadAudio -> H3ReferenceAudio -> ref_audios.ref_audio_0
  g.voice_in = { class_type: "LoadAudio", inputs: { audio: opts.wavName } };
  g.voice_guard = {
    class_type: "H3ReferenceAudio",
    inputs: { audio: ["voice_in", 0], max_seconds: VOICE_MAX_SECONDS },
  };
  if (variant === "a" && hasVideo1) {
    g.blender_vid = {
      class_type: "VHS_LoadVideo",
      inputs: { video: opts.blockoutName!, custom_width: WIDTH, custom_height: HEIGHT, ...BLOCKOUT_VHS },
    };
  }
  const r2vInputs: Record<string, unknown> = {
    clip: ["clip", 0],
    vae: ["vvae", 0],
    audio_vae: ["avae", 0],
    prompt: ["split", 0],
    width: WIDTH,
    height: HEIGHT,
    length: opts.frames,
    ref_image_size: REF_IMAGE_SIZE,
    "ref_audios.ref_audio_0": ["voice_guard", 0],
  };
  if (variant === "a" && hasVideo1) {
    r2vInputs["ref_videos.ref_video_0"] = ["blender_vid", 0];
    if (opts.audioTimingRefName) {
      // card ③a (sample #31): the montage beat-cut timing reference. It rides
      // as <Audio 2> (presentation order); the dialogue wav keeps <Audio 1>.
      g.timing_in = { class_type: "LoadAudio", inputs: { audio: opts.audioTimingRefName } };
      g.timing_guard = {
        class_type: "H3ReferenceAudio",
        inputs: { audio: ["timing_in", 0], max_seconds: VOICE_MAX_SECONDS },
      };
      r2vInputs["ref_audios.ref_audio_1"] = ["timing_guard", 0];
    }
  }
  const refImageNames = [...(opts.refImageNames ?? []), ...(variant === "a" ? opts.uiPhotoNames ?? [] : [])];
  for (const [i, name] of refImageNames.entries()) {
    const nodeId = `ref_img_${i}`;
    g[nodeId] = { class_type: "LoadImage", inputs: { image: name } };
    r2vInputs[`ref_images.ref_image_${i}`] = [nodeId, 0];
  }
  g.r2v = { class_type: "MiniMaxH3ReferenceToVideo", inputs: r2vInputs };
  g.cond_evict = {
    class_type: "H3FreeTextEncoder",
    inputs: { conditioning: ["r2v", 0], clip: ["clip", 0] },
  };
  g.cond_cs = {
    class_type: "H3ConditionStrength",
    inputs: {
      conditioning: ["cond_evict", 0],
      visual_strength: opts.visualStrength ?? COND_VISUAL,
      audio_strength: COND_AUDIO,
    },
  };
  let condOut: [string, number] = ["cond_cs", 0];
  // keyframes lane: BKF/C alternates plus A-form (variant a WITHOUT Video 1 —
  // §5b: the H3Keyframes lane belongs to still-to-video; a Video 1 shot is
  // C-form and never wires keyframes).
  const keyform = variant === "bkf" || variant === "c" || (variant === "a" && !hasVideo1);
  if (keyform) {
    // official H3Keyframes (card C ①): the anchors ARE the clip's own frames,
    // pinned by positions — % is native here. One positions entry per anchor.
    g.kf_start_in = { class_type: "LoadImage", inputs: { image: opts.kfStartName! } };
    const kfInputs: Record<string, unknown> = {
      clip: ["clip", 0],
      vae: ["vvae", 0],
      prompt: ["split", 0],
      width: WIDTH,
      height: HEIGHT,
      length: opts.frames,
      positions: "0%",
      image_1: ["kf_start_in", 0],
    };
    if (variant === "a" && opts.kfEndName) {
      g.kf_end_in = { class_type: "LoadImage", inputs: { image: opts.kfEndName } };
      kfInputs.positions = "0%, 100%";
      kfInputs.image_2 = ["kf_end_in", 0];
    }
    g.keyframes = { class_type: "H3Keyframes", inputs: kfInputs };
    // anchor strength: the official H3_Keyframes example applies
    // H3ConditionStrength to the keyframes positive; v6 applied 0.999/1.0 to
    // the single entry — the faithful translation applies it to each entry.
    g.kf_strength = {
      class_type: "H3ConditionStrength",
      inputs: {
        conditioning: ["keyframes", 0],
        visual_strength: opts.visualStrength ?? COND_VISUAL,
        audio_strength: COND_AUDIO,
      },
    };
    g.cond_combine = {
      class_type: "ConditioningCombine",
      inputs: { conditioning_1: ["cond_cs", 0], conditioning_2: ["kf_strength", 0] },
    };
    condOut = ["cond_combine", 0];
  }
  g.noise_a = { class_type: "RandomNoise", inputs: { noise_seed: opts.seed } };
  g.sampler_sel = { class_type: "KSamplerSelect", inputs: { sampler_name: SAMPLER } };
  g.sched_a = {
    class_type: "BasicScheduler",
    inputs: { model: modelA, scheduler: SCHEDULER, steps: opts.steps, denoise: 1.0 },
  };
  g.guider_a = { class_type: "BasicGuider", inputs: { model: modelA, conditioning: condOut } };
  g.samp_a = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["noise_a", 0],
      guider: ["guider_a", 0],
      sampler: ["sampler_sel", 0],
      sigmas: ["sched_a", 0],
      latent_image: ["r2v", 1],
    },
  };
  g.dec_v = { class_type: "VAEDecode", inputs: { samples: ["samp_a", 0], vae: ["vvae", 0] } };
  g.dec_a = { class_type: "VAEDecodeAudio", inputs: { samples: ["samp_a", 0], vae: ["avae", 0] } };
  g.lastf = { class_type: "H3LastFrame", inputs: { images: ["dec_v", 0] } }; // orphan: inspect after render, never next kf_start
  g.cv = { class_type: "CreateVideo", inputs: { images: ["dec_v", 0], fps: 24, audio: ["dec_a", 0] } };
  g.save = {
    class_type: "SaveVideo",
    inputs: { video: ["cv", 0], filename_prefix: opts.filenamePrefix, format: "auto", codec: "auto" },
  };
  return g;
}
