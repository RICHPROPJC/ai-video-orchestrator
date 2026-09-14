import type { ComfyGraph } from "./comfy";

// v6-parity constants — shotdag h3_submit.py, verbatim values (receipts in
// NOTES_h3_graph.md "v6 parity"). Defaults with receipts, not locked numbers.
const WIDTH = 864;
const HEIGHT = 480;
const LORA_STRENGTH = 1.0;
const SAMPLER = "euler"; // official turbo 4-step recipe
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

/** copied from shotdag h3_submit.BINDINGS — the grey-model <Video 1> contract */
export const BINDINGS =
  "The start and end keyframe images are the physical beginning and near-end of this " +
  "shot: faces, costumes and props come only from them and continue exactly. " +
  "The grey placeholders of <Video 1> are motion-only: follow positions and timing, " +
  "ignore their appearance. Do not add people.";

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
  kfStartName: string;
  kfEndName?: string;
  blockoutName: string;
  wavName: string;
  models: H3GraphModels;
  /** default A — current Video 1 + kfinject graph */
  variant?: H3GraphVariant;
  /** B/BKF: still first, then portrait upload names for ref_images.ref_image_N */
  refImageNames?: string[];
  /** default COND_VISUAL 0.999. C8b probe may lower this; do not change the golden default. */
  visualStrength?: number;
};

const KFINJECT_VARIANTS = new Set<H3GraphVariant>(["a", "bkf", "c"]);

/** v6-parity R2V graph: node ids and values identical to shotdag
 *  h3_submit.build_graph (single shot, zero ref_images, turbo LoRA via
 *  H3LoraStack, SolAttn+FBC+SigmaShift model chain, H3EpisodeSplit script,
 *  H3FreeTextEncoder+H3ConditionStrength conditioning, voice via
 *  LoadAudio->H3ReferenceAudio, blockout via VHS_LoadVideo). */
export function buildH3Graph(opts: BuildH3GraphOpts): ComfyGraph {
  const variant = opts.variant ?? "a";
  const m = opts.models;
  const g: ComfyGraph = {
    clip: { class_type: "H3ClipLoaderAny", inputs: { clip_name: m.textEncoder, type: m.encoderType } },
    vvae: { class_type: "VAELoader", inputs: { vae_name: m.videoVae } },
    avae: { class_type: "VAELoader", inputs: { vae_name: m.audioVae } },
    ref2va: { class_type: "H3ModelLoaderAny", inputs: { model_name: m.ref2va } },
    fl2va: { class_type: "H3ModelLoaderAny", inputs: { model_name: m.fl2va } },
    split: { class_type: "H3EpisodeSplit", inputs: { script: opts.script, bindings: opts.bindings } },
  };
  // model chain per loader: H3ModelLoaderAny -> H3FirstBlockCache -> SolAttn ->
  // H3LoraStack(lora_1 = turbo LoRA) -> MiniMaxH3SigmaShift
  for (const [tag, loader] of [["lora_a", "ref2va"], ["lora_b", "fl2va"]] as const) {
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
    const loraInputs: Record<string, unknown> = { model: [`solattn_${loader}`, 0] };
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
  if (variant === "a") {
    g.blender_vid = {
      class_type: "VHS_LoadVideo",
      inputs: { video: opts.blockoutName, custom_width: WIDTH, custom_height: HEIGHT, ...BLOCKOUT_VHS },
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
  if (variant === "a") {
    r2vInputs["ref_videos.ref_video_0"] = ["blender_vid", 0];
  }
  for (const [i, name] of (opts.refImageNames ?? []).entries()) {
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
  if (KFINJECT_VARIANTS.has(variant)) {
    g.kf_start_in = { class_type: "LoadImage", inputs: { image: opts.kfStartName } };
    const kfInputs: Record<string, unknown> = {
      conditioning: ["cond_cs", 0],
      vae: ["vvae", 0],
      start_image: ["kf_start_in", 0],
      width: WIDTH,
      height: HEIGHT,
      length: opts.frames,
    };
    if (variant === "a" && opts.kfEndName) {
      g.kf_end_in = { class_type: "LoadImage", inputs: { image: opts.kfEndName } };
      kfInputs.end_image = ["kf_end_in", 0];
    }
    g.kfinject = { class_type: "H3KeyframeInject", inputs: kfInputs };
    condOut = ["kfinject", 0];
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
  g.lastf = { class_type: "H3LastFrame", inputs: { images: ["dec_v", 0] } }; // v6 keeps this orphan
  g.cv = { class_type: "CreateVideo", inputs: { images: ["dec_v", 0], fps: 24, audio: ["dec_a", 0] } };
  g.save = {
    class_type: "SaveVideo",
    inputs: { video: ["cv", 0], filename_prefix: opts.filenamePrefix, format: "auto", codec: "auto" },
  };
  return g;
}
