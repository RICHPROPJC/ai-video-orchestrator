import type { ComfyGraph } from "./comfy";
import { snapDurationToFrames } from "./frame-grid";

// v6-parity constants — shotdag h3_submit.py, verbatim values (receipts in
// NOTES_h3_graph.md "v6 parity"). Defaults with receipts, not locked numbers.
const WIDTH = 864;
const HEIGHT = 480;

/** ECOM1A: per-callsheet canvas. node1 probe (verify/motion/H3.object_info.node1.CFORM-ECOM.json,
 *  0922): the H3 node family declares width/height INT min 32 step 32 max 4096+ — no aspect
 *  restriction — and the pack ships portrait defaults of its own (H3KeyframeInject 544×960,
 *  H3MultishotSampler/H3StudioControls 768×1344). 544×960 is the pixel-exact twin of the
 *  README-measured native 960×544 (same 522,240 px — "render native, then upscale"), and it
 *  is the size the pack itself defaults to in portrait. Landscape stays v6-parity 864×480. */
export const H3_GRAPH_SIZES = {
  "16:9": { width: WIDTH, height: HEIGHT },
  "9:16": { width: 544, height: 960 },
} as const;
export type H3GraphAspect = keyof typeof H3_GRAPH_SIZES;

/** callsheet.aspect → graph canvas. Undefined keeps the v6 default; an unknown
 *  non-empty string is a refuse-to-emit (a wrong-size bake burns the take). */
export function h3SizeForAspect(aspect: string | undefined): { width: number; height: number } {
  if (!aspect) return { ...H3_GRAPH_SIZES["16:9"] };
  const size = (H3_GRAPH_SIZES as Record<string, { width: number; height: number }>)[aspect];
  if (!size) {
    throw new Error(
      `aspect_unsupported: ${JSON.stringify(aspect)} — H3 graph sizes are ${Object.keys(H3_GRAPH_SIZES).join(", ")}`,
    );
  }
  return { ...size };
}
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

/** MS-A verified chain params (CHAIN_MS_0921 SHCC.msA, Chau eye "good" =
 *  跨shot接駁定案; node tooltips carry the measurements):
 *  - seed_per_shot ON: one seed per shot holds the face; one seed for all
 *    shots drifted BOTH face and voice
 *  - chain_gain_control "flatten": chained tails anchor the next shot and the
 *    model returns ~1.25-1.47x anchor texture energy — sharpness ratchets
 *    (3.3x over 6 shots) unless flattened per block
 *  - ref2va checkpoint (voice-ref/reference rows were not trained on fl2va) */
export const MS_PARAMS = {
  seedPerShot: true,
  chainGainControl: "flatten",
  selfAnchorVoice: false,
  twoPassUpscale: false,
} as const;

/** cross-shot chain riding a C-form first shot (MULTISHOT_WIRE_0921): the
 *  shots AFTER the first render inside the same graph via H3MultishotSampler,
 *  seeded by shot 1's true endframe (H3LastFrame→start_image — pack
 *  H3_HardMode_Chained topology), H3ConcatAV seam-matching the take. */
export type H3ChainOpts = {
  /** "---"-separated prompt per chained shot (shots 2..N of the segment) */
  script: string;
  /** number of chained shots (the script's prompt count) */
  shotCount: number;
  /** frames per chained shot on H3's 17k+5 grid (119 ≈ 4.96s, step 17) */
  framesPerShot: number;
  /** the identity portrait carried into EVERY chained shot (<Picture 1>) —
   *  exactly one image; multiple refs need a batch node the graph does not own */
  referenceImageName: string;
  /** optional voice anchor wav (<Audio 1> in every chained shot) */
  voiceRefName?: string;
};

/** standalone multishot call (簡單接駁 — no first C-form shot, MS-A shape):
 *  the WHOLE segment renders inside H3MultishotSampler; start_image is the
 *  PREVIOUS segment's true endframe when one exists (uploaded). The node has
 *  no ref_videos input — motion rides the script text and frame chaining. */
export type H3MultishotOpts = {
  script: string;
  shotCount: number;
  framesPerShot: number;
  referenceImageName: string;
  startImageName?: string;
  voiceRefName?: string;
};

export type BuildH3GraphOpts = {
  script: string;
  bindings: string;
  frames: number;
  steps: number;
  seed: number;
  filenamePrefix: string;
  /** ECOM1A: canvas by callsheet aspect — undefined keeps the v6-parity
   *  864×480. Both values must ride together on the /32 grid (every node in
   *  the graph — r2v, keyframes, multishot, VHS_LoadVideo — gets the same
   *  pair, or the latent and the motion ref disagree). */
  width?: number;
  height?: number;
  /** A-form only (no Video 1): the U1.5 still anchoring H3Keyframes at 0%.
   *  Also the first keyframe image when keyframePositions is set. */
  kfStartName?: string;
  kfEndName?: string;
  /** Extra keyframe upload names after start/end. The positions string is the shot's own. */
  kfExtraNames?: string[];
  /** Percent anchors. Video 1 coexistence remains disputed: ALIGN-LOCK records
   * both the typed allowance and §5b warning; this change does not adjudicate it. */
  keyframePositions?: string;
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
  /** MULTISHOT_WIRE_0921: chain the shots after this C-form first shot via
   *  H3MultishotSampler (true-endframe start) + H3ConcatAV. C-form only. */
  chain?: H3ChainOpts;
  /** MULTISHOT_WIRE_0921 standalone multishot (簡單接駁, MS-A shape): the
   *  whole segment renders inside H3MultishotSampler — no r2v block, no
   *  Video 1, no keyframes. Mutually exclusive with chain/blockout/kf. */
  multishot?: H3MultishotOpts;
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
function rejectChainedMultishot(chain: unknown): void {
  if (chain) throw new Error("multishot_identity_only: chained Video 1/start-frame generation is outside ALIGN-LOCK");
}

export function buildH3Graph(opts: BuildH3GraphOpts): ComfyGraph {
  const variant = opts.variant ?? "a";
  const m = opts.models;
  // ECOM1A: one canvas for every node in the graph — r2v, H3Keyframes, the
  // multishot samplers and VHS_LoadVideo (the <Video 1> motion ref) must all
  // agree, or the latent and the motion source fight.
  const width = opts.width ?? WIDTH;
  const height = opts.height ?? HEIGHT;
  if ((opts.width === undefined) !== (opts.height === undefined)) {
    throw new Error(`graph_size_invalid: width and height ride together (got ${JSON.stringify({ width: opts.width, height: opts.height })})`);
  }
  if (
    !Number.isInteger(width) || !Number.isInteger(height) ||
    width < 32 || height < 32 || width % 32 !== 0 || height % 32 !== 0 ||
    width > 4096 || height > 4096
  ) {
    throw new Error(
      `graph_size_invalid: ${width}x${height} — H3 canvas needs two /32 ints in 32–4096 (node1 object_info step 32)`,
    );
  }
  // 鍵格同參考片可以一齊入。冇寫百分比就同時塞鍵格檔同走位片，先拒。
  // 灰模片只入 ref_videos，唔當鍵格。
  const hasVideo1 = Boolean(opts.blockoutName);
  const positions = opts.keyframePositions?.trim() ?? "";
  if (!positions && hasVideo1 && (opts.kfStartName || opts.kfEndName || opts.kfExtraNames?.length)) {
    throw new Error(
      `keyframes_video1_coexist: 冇寫 positions 就同時有走位片 (${opts.blockoutName}) 同鍵格檔 ` +
        `(${opts.kfStartName ?? ""}${opts.kfEndName ? " + kf_end" : ""})`,
    );
  }
  // MULTISHOT_WIRE: the two cross-shot shapes are exclusive with everything
  // else the builder knows
  if (opts.chain && opts.multishot) {
    throw new Error("chain and multishot are exclusive: chain rides a C-form first shot, multishot is standalone");
  }
  if (opts.chain && (!opts.blockoutName || variant !== "a")) {
    throw new Error("chain_requires_cform: the chained topology's shot 1 IS the C-form render (Video 1 motion + portrait identity)");
  }
  // ALIGN-LOCK: multi-shot generation accepts identity sheets only.
  rejectChainedMultishot(opts.chain);
  if (opts.chain && opts.chain.shotCount < 1) {
    throw new Error("chain.shotCount must be ≥1 (the shots after the C-form first shot)");
  }
  if (opts.multishot) {
    if (opts.blockoutName || opts.kfStartName || opts.kfEndName || opts.kfExtraNames?.length || positions || opts.multishot.startImageName) {
      throw new Error("multishot is standalone: no Video 1 (the node has no ref_videos input) and no keyframes");
    }
    if (variant !== "a") throw new Error("multishot runs on the production path only (variant a)");
  }
  if (opts.multishot) {
    // standalone multishot (MS-A shape, chain_s2 build_graph verbatim): the
    // ref2va chain carries the reference rows (fl2va was not trained with
    // them); no H3EpisodeSplit — the node takes the raw "---" script, and
    // opts.bindings is unused on this shape
    const ms = opts.multishot;
    const g: ComfyGraph = {
      clip: { class_type: "H3ClipLoaderAny", inputs: { clip_name: m.textEncoder, type: m.encoderType } },
      vvae: { class_type: "VAELoader", inputs: { vae_name: m.videoVae } },
      avae: { class_type: "VAELoader", inputs: { vae_name: m.audioVae } },
      ref2va: { class_type: "H3ModelLoaderAny", inputs: { model_name: m.ref2va } },
    };
    const loraInputs: Record<string, unknown> = { model: ["ref2va", 0] };
    for (let i = 1; i <= 4; i += 1) {
      loraInputs[`lora_${i}`] = i === 1 ? m.turboLora : "None";
      loraInputs[`strength_${i}`] = LORA_STRENGTH;
    }
    g.lora_a = { class_type: "H3LoraStack", inputs: loraInputs };
    g.sigma_lora_a = {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: ["lora_a", 0], shift_video: SIGMA_VIDEO, shift_audio: SIGMA_AUDIO },
    };
    g.voice_in = { class_type: "LoadAudio", inputs: { audio: opts.wavName } };
    g.voice_guard = {
      class_type: "H3ReferenceAudio",
      inputs: { audio: ["voice_in", 0], max_seconds: VOICE_MAX_SECONDS },
    };
    if (ms.startImageName) {
      g.ms_start_in = { class_type: "LoadImage", inputs: { image: ms.startImageName } };
    }
    g.ms_hero_in = { class_type: "LoadImage", inputs: { image: ms.referenceImageName } };
    const msInputs: Record<string, unknown> = {
      model: ["sigma_lora_a", 0],
      clip: ["clip", 0],
      video_vae: ["vvae", 0],
      audio_vae: ["avae", 0],
      script: ms.script,
      shot_count: ms.shotCount,
      width: width,
      height: height,
      frames_per_shot: snapDurationToFrames(ms.framesPerShot / 24),
      seed: opts.seed,
      steps: opts.steps,
      seed_per_shot: MS_PARAMS.seedPerShot,
      reference_images: ["ms_hero_in", 0],
      voice_ref: ["voice_guard", 0],
      sampler_name: SAMPLER,
      scheduler: SCHEDULER,
      self_anchor_voice: MS_PARAMS.selfAnchorVoice,
      two_pass_upscale: MS_PARAMS.twoPassUpscale,
      chain_gain_control: MS_PARAMS.chainGainControl,
    };
    if (ms.startImageName) msInputs.start_image = ["ms_start_in", 0];
    g.ms = { class_type: "H3MultishotSampler", inputs: msInputs };
    g.cv = { class_type: "CreateVideo", inputs: { images: ["ms", 0], audio: ["ms", 1], fps: 24 } };
    g.save = {
      class_type: "SaveVideo",
      inputs: { video: ["cv", 0], filename_prefix: opts.filenamePrefix, format: "auto", codec: "auto" },
    };
    return g;
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
      inputs: { video: opts.blockoutName!, custom_width: width, custom_height: height, ...BLOCKOUT_VHS },
    };
  }
  const r2vInputs: Record<string, unknown> = {
    clip: ["clip", 0],
    vae: ["vvae", 0],
    audio_vae: ["avae", 0],
    prompt: ["split", 0],
    width: width,
    height: height,
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
  // 寫咗 positions 就釘鍵格，有冇走位片都釘。冇走位片、冇 positions 先用兩端 still。
  const keyform = Boolean(positions) || variant === "bkf" || variant === "c" || (variant === "a" && !hasVideo1);
  if (keyform) {
    if (!opts.kfStartName) throw new Error("keyframes require kfStartName");
    const kfInputs: Record<string, unknown> = {
      clip: ["clip", 0],
      vae: ["vvae", 0],
      prompt: ["split", 0],
      width: width,
      height: height,
      length: opts.frames,
      positions: "0%",
      image_1: ["kf_start_in", 0],
    };
    if (positions) {
      const files = [opts.kfStartName, ...(opts.kfEndName ? [opts.kfEndName] : []), ...(opts.kfExtraNames ?? [])].filter((name): name is string => Boolean(name));
      const marks = positions.split(/[,，]/).map((p) => p.trim()).filter(Boolean);
      const token = /^(?:\d+(?:\.\d+)?%|\d+|\d+(?:\.\d+)?%-\d+(?:\.\d+)?%|\d+-\d+)$/;
      if (!files.length || !marks.length || marks.some((p) => !token.test(p))) {
        throw new Error("keyframe_positions_invalid: each mark must be a percentage, a frame index, or a range");
      }
      kfInputs.positions = marks.join(", ");
      let batch: [string, number] | undefined;
      files.forEach((name, i) => {
        const id = i === 0 ? "kf_start_in" : i === 1 && opts.kfEndName ? "kf_end_in" : `kf_img_${i + 1}`;
        g[id] = { class_type: "LoadImage", inputs: { image: name } };
        if (i < 6) kfInputs[`image_${i + 1}`] = [id, 0];
        else if (!batch) batch = [id, 0];
        else {
          const batchId = `kf_batch_${i + 1}`;
          g[batchId] = { class_type: "ImageBatch", inputs: { image1: batch, image2: [id, 0] } };
          batch = [batchId, 0];
        }
      });
      if (batch) kfInputs.images_batch = batch;
    } else {
      g.kf_start_in = { class_type: "LoadImage", inputs: { image: opts.kfStartName } };
      if (variant === "a" && opts.kfEndName) {
        g.kf_end_in = { class_type: "LoadImage", inputs: { image: opts.kfEndName } };
        kfInputs.positions = "0%, 100%";
        kfInputs.image_2 = ["kf_end_in", 0];
      }
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
  // single shot: orphan (inspect after render, never next kf_start); chained:
  // the TRUE endframe seeding H3MultishotSampler (H3_HardMode_Chained wiring)
  g.lastf = { class_type: "H3LastFrame", inputs: { images: ["dec_v", 0] } };
  let takeImages: [string, number] = ["dec_v", 0];
  let takeAudio: [string, number] = ["dec_a", 0];
  if (opts.chain) {
    const c = opts.chain;
    g.ms_hero_in = { class_type: "LoadImage", inputs: { image: c.referenceImageName } };
    if (c.voiceRefName) {
      g.ms_voice_in = { class_type: "LoadAudio", inputs: { audio: c.voiceRefName } };
      g.ms_voice_guard = {
        class_type: "H3ReferenceAudio",
        inputs: { audio: ["ms_voice_in", 0], max_seconds: VOICE_MAX_SECONDS },
      };
    }
    const msInputs: Record<string, unknown> = {
      model: ["sigma_lora_a", 0], // ref2va chain (MS-A): reference rows live here
      clip: ["clip", 0],
      video_vae: ["vvae", 0],
      audio_vae: ["avae", 0],
      script: c.script,
      shot_count: c.shotCount,
      width: width,
      height: height,
      frames_per_shot: snapDurationToFrames(c.framesPerShot / 24),
      seed: opts.seed,
      steps: opts.steps,
      seed_per_shot: MS_PARAMS.seedPerShot,
      start_image: ["lastf", 0], // shot 1's true endframe
      reference_images: ["ms_hero_in", 0],
      sampler_name: SAMPLER,
      scheduler: SCHEDULER,
      self_anchor_voice: MS_PARAMS.selfAnchorVoice,
      two_pass_upscale: MS_PARAMS.twoPassUpscale,
      chain_gain_control: MS_PARAMS.chainGainControl,
    };
    if (c.voiceRefName) msInputs.voice_ref = ["ms_voice_guard", 0];
    g.ms = { class_type: "H3MultishotSampler", inputs: msInputs };
    // seam: stage B (multishot) matched to stage A's texture (pack default)
    g.concat = {
      class_type: "H3ConcatAV",
      inputs: {
        images_a: ["dec_v", 0],
        audio_a: ["dec_a", 0],
        images_b: ["ms", 0],
        audio_b: ["ms", 1],
        match_b: "match_to_a",
      },
    };
    takeImages = ["concat", 0];
    takeAudio = ["concat", 1];
  }
  g.cv = { class_type: "CreateVideo", inputs: { images: takeImages, fps: 24, audio: takeAudio } };
  g.save = {
    class_type: "SaveVideo",
    inputs: { video: ["cv", 0], filename_prefix: opts.filenamePrefix, format: "auto", codec: "auto" },
  };
  return g;
}
