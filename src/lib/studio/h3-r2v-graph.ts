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
  frame_load_cap: 56,
  skip_first_frames: 0,
  select_every_nth: 1,
};
// Sol 0926 裁決 E：舊值（cap32/nth10）令 56 幀參考片抽到 6 幀、native R2V
// 再裁到 5、Qwen 每 12 幀取 1 —— 文字編碼器最後只見 1 幀，Video1 動作資訊
// 歸零。全幀入（nth1/cap56）先可以叫做餵咗條片。

/** copied from shotdag h3_submit.BINDINGS — the grey-model <Video 1> contract.
 *  A-form (no Video 1, keyframes two ends) only: it names the start/end
 *  keyframe images, which the C-form graph never wires. */
export const BINDINGS =
  "The start and end keyframe images are the physical beginning and near-end of this " +
  "shot: faces, costumes and props come only from them and continue exactly. " +
  "The grey placeholders of <Video 1> are motion-only: follow positions and timing, " +
  "ignore their appearance. Do not add people.";

/** C-form contract (§5b, E2E SC-0921-9V4Y SH01.c8, tg 17976；Sol 0926 裁決 E
 *  改寫)：正面對應素材角色——<Picture 1>＝本鏡 GREEN 劇照（同一人同一場同一
 *  道具，一切視覺外觀以佢為準）；keyframe 圖＝本鏡首尾時間錨；<Video 1>＝同
 *  一個人嘅排練參考（跟位＋時機，外觀係灰替身絕不參考）。全程一個人。 */
export const BINDINGS_CFORM =
  "<Picture 1> is this shot's own reference photograph: the same single person, " +
  "wardrobe, place and props exactly as pictured — every visual look follows it. " +
  "The keyframe images are this same shot's start and end moments. " +
  "<Video 1> is that same person rehearsing the move: follow its positions, " +
  "choreography and timing only — its grey stand-in look, background and " +
  "lighting are never a look reference. One person on screen from the first " +
  "frame to the last.";

export type H3GraphModels = {
  textEncoder: string;
  encoderType: string;
  videoVae: string;
  audioVae: string;
  ref2va: string;
  fl2va: string | null; // P34 P0：null＝未採用（A-form 孤 loader 已刪；真路由 P1 批二）
  turboLora: string;
  /** §P34 P1：PDD Acc patch 檔（ref2va 8-step；node1 部署實核） */
  pddAccFile?: string;
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

/** §P34 批二（0928）：typed route/recipe——路由決策與 graph 構造分開。
 *  route 由已採納任務決策（caller）傳落；graph builder 照 route 構造；
 *  submit receipt 記實際採用 route（§5 收據誠實）。未接線 route
 *  （fl2va／mixed／pdd-8step）＝submit 入口具名 throw blocked——graph 唔
 *  構造唔降級唔 fallback（同 request 指定 route 而能力缺＝blocked）。
 *  turboAccel 唔係獨立 route：steps=4 行 FBC+SolAttn 快路、其他直落——
 *  turbo patch hard-locked 4-step schedule（離開即 tensor 爆）。 */
export type H3RouteRecipe =
  | { kind: "ref2va-still"; steps: number }     // A-form：靜畫起動（H3Keyframes 0/100）
  | { kind: "ref2va-video1"; steps: number }    // C-form：Video 1 motion-only ref
  | { kind: "ref2va-multishot"; steps: number } // MS-A standalone：整段 H3MultishotSampler
  | { kind: "fl2va"; steps: number }            // 未接線：blocked（FL2VA patch 後 model 無可達 SaveVideo consumer）
  | { kind: "mixed" }                           // 部署未核：blocked（兩 base 同次採用無合法接法已核）
  | { kind: "pdd-8step" };                      // 未接線：blocked（MiniMaxH3PDDAccApply source 零接線）

/** 未傳 route 時由現有欄位推（向後兼容）——receipt 記 derived:true 標明
 *  呢個 route 係推導唔係任務決策採納。 */
export function resolveRoute(opts: {
  variant?: H3GraphVariant;
  steps: number;
  multishot?: unknown;
  chain?: unknown;
}): { route: H3RouteRecipe; derived: true } {
  if (opts.multishot) return { route: { kind: "ref2va-multishot", steps: opts.steps }, derived: true };
  // A＝still 起動；C＝有 Video 1（blockoutName）——§5b 分流照舊
  return { route: { kind: opts.variant === "c" ? "ref2va-video1" : "ref2va-still", steps: opts.steps }, derived: true };
}

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
  /** Percent anchors. Sol 0926 裁決 E：KF＋Video 1 共存合法——寫咗 positions，
   *  首尾 0%/100% 行 H3KeyframeInject 同一 conditioning entry（keyform/
   *  injectable 分支）；冇 positions 而同時有走位片＋鍵格檔先 throw。 */
  keyframePositions?: string;
  /** §5b routing field: a Video 1 asset present → C-form; absent → A-form
   * (H3Keyframes 0%/100%). Keyframe names + Video 1 together throw only
   * without positions (keyframes_need_positions). */
  blockoutName?: string;
  wavName: string;
  models: H3GraphModels;
  /** §P34 批二：任務決策採納嘅 typed route——有就照佢構造＋receipt 記
   *  derived:false；冇就用 resolveRoute 推（向後兼容）＋receipt derived:true。 */
  route?: H3RouteRecipe;
  /** §P34 P1 第四刀（§4）：H3 native latent 升階——true 時 samp_a 輸出經
   *  MiniMaxH3LatentUpscaleCombined（部署已核：learned film_epoch200＋
   *  samples/model/noise/sigmas）先 decode；唔用 RealESRGAN 冒充 H3 原生。
   *  冇傳＝唔升階（維持現狀，唔默認開）。 */
  nativeUpscale?: boolean;
  /** default A — the production path; §5b splits it by the Video 1 asset:
   *  with Video 1 the graph is C-form (Video 1 motion-only; zero keyframes
   *  only when no positions — written positions coexist KF via
   *  H3KeyframeInject, Sol 0926 E); without it A-form still-to-video
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
 *  SC-0921-9V4Y SH01.c8, tg 17976): identity rides ref_images.ref_image_0
 *  = the character's angle portrait (per refAngle), <Video 1> blockout via
 *  VHS_LoadVideo carries motion only, BINDINGS_CFORM on the split node.
 *  Zero H3Keyframes only when no positions — written positions + 0%/100%
 *  coexist KF via H3KeyframeInject on the r2v conditioning entry (Sol 0926
 *  裁決 E); refs/KF never ride ConditioningCombine side by side there.
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
  // §P34/R6（0928）README 兩-pass：pdd8＋nativeUpscale＝PDD hi-res fix——pass1
  // render 喺 final÷1.5（864×480→576×320，兩個 /32 對齊），AVLatentUpscaleBy
  // ×1.5 返 final（node snap patch grid）。final÷1.5 非 /32 整數＝具名拒（9:16
  // 544÷1.5 唔整——兩-pass 未支援）；chain（multishot）同兩-pass 未定義組合同拒。
  const twoPass = Boolean(opts.route?.kind === "pdd-8step" && opts.nativeUpscale);
  if (twoPass && opts.chain) {
    throw new Error("h3_route_blocked: pdd-8step native upscale 兩-pass 同 chain（multishot）未定義組合——named unsupported");
  }
  if (twoPass && (width % 48 !== 0 || height % 48 !== 0)) {
    throw new Error(`h3_native_upscale_size_invalid: 兩-pass pass1＝final÷1.5 要 /32 對齊（final ${width}x${height}÷1.5＝${width / 1.5}x${height / 1.5} 唔整數）——呢個尺寸未支援，具名拒`);
  }
  const passW = twoPass ? Math.round(width / 1.5) : width;
  const passH = twoPass ? Math.round(height / 1.5) : height;
  // 鍵格同參考片可以一齊入。冇寫百分比就同時塞鍵格檔同走位片，先拒。
  // 灰模片只入 ref_videos，唔當鍵格。
  const hasVideo1 = Boolean(opts.blockoutName);
  const positions = opts.keyframePositions?.trim() ?? "";
  if (!positions && hasVideo1 && (opts.kfStartName || opts.kfEndName || opts.kfExtraNames?.length)) {
    throw new Error(
      `keyframes_need_positions: 冇寫 positions 就同時有走位片 (${opts.blockoutName}) 同鍵格檔 ` +
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
    // P34 P0（0928）：fl2va 孤 loader 刪——本 route 構造過 fl2va→fbc→solattn
    // →lora_b→sigma_lora_b 但零 consumer（r2v/sampler 全食 sigma_lora_a），
    // 「定義 loader＝已用 FL2VA」係假宣稱。FL2VA 真正 consumer＝P1 批二
    // typed route（各自 patch 後 model 可達 SaveVideo）先返。
    ref2va: { class_type: "H3ModelLoaderAny", inputs: { model_name: m.ref2va } },
    split: { class_type: "H3EpisodeSplit", inputs: { script: opts.script, bindings: opts.bindings } },
  };
  // model chain per loader: turbo-4 road keeps the accel patch
  // (H3ModelLoaderAny -> H3FirstBlockCache -> SolAttn -> H3LoraStack ->
  // MiniMaxH3SigmaShift); any other step count (8-step v1.0, §5b B1v3) skips
  // FBC/SolAttn entirely — the patch is hard-locked to the 4-step schedule
  // and crashes structurally off it (tensor 17428≠17418).
  const turbo4 = opts.steps === 4;
  for (const [tag, loader] of [["lora_a", "ref2va"]] as const) { // P34 P0：fl2va 鏈隨孤 loader 刪
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
  // §P34 P1（node1 object_info 實核 0928）：pdd-8step route＝ref2va lora 鏈尾
  // 落 MiniMaxH3PDDAccApply（pdd_file=Ref2VA-Acc-8Step；nfe 8＝trained block
  // size 4；partition_check=error——fl2va/ref2va 同 key set 錯配 silently
  // wrong，呢個閘係防錯配唔係合流）；scheduler 配套 PDDAccScheduler（同
  // nfe——on_off_grid 語義：sigma 唔喺 trained boundary 就 error）。
  const pdd8 = opts.route?.kind === "pdd-8step";
  if (pdd8) {
    // §P36 README 實讀（0928，golden pdd_acc_t2v_basic.json 對返）：PDD 路＝
    // loader→SigmaShift(12/3)→PDDAccApply——**零 LoraStack**（README：distills
    // don't stack，Remove turbo 等 LoRA）；sigmas 由 Apply 嘅 sigmas output 出
    // （PDDAccScheduler 係 standalone partial-denoise 場合，唔係呢度）。
    // root R7 檔缺守衛撤回（0928 磁碟複核推翻舊判斷）：node1 models/pdd_acc/
    // 實況兩款齊——MiniMax-H3-Ref2VA-Acc-8Step.safetensors（0907 original
    // 1.37GB）＋ minimax_h3_fl2va_pdd_acc_8step_comfyui.safetensors（0928
    // comfyui 轉換款 1.66GB）。「淨 fl2va 款」係 P36 誤判。磁碟存在性唔喺
    // graph builder 寫死判（遠端磁碟、時刻會變）——交 ComfyUI queue 驗證層
    // （missing input 實證會拒，唔燒 GPU）＋收據層寫實際 pdd_file 供對賬。
    const pddFile = opts.models.pddAccFile ?? "MiniMax-H3-Ref2VA-Acc-8Step.safetensors";
    g.sigma_pdd = {
      class_type: "MiniMaxH3SigmaShift",
      inputs: { model: ["ref2va", 0], shift_video: SIGMA_VIDEO, shift_audio: SIGMA_AUDIO },
    };
    g.pdd_apply = {
      class_type: "MiniMaxH3PDDAccApply",
      inputs: {
        model: ["sigma_pdd", 0],
        pdd_file: pddFile,
        nfe: "8",
        lora_strength: 1.0,
        head_strength: 1.0,
        on_off_grid: "error",
        partition_check: "error",
      },
    };
  }
  const modelOut = pdd8 ? (["pdd_apply", 0] as [string, number]) : modelA;
  // voice: LoadAudio -> H3ReferenceAudio -> ref_audios.ref_audio_0
  g.voice_in = { class_type: "LoadAudio", inputs: { audio: opts.wavName } };
  g.voice_guard = {
    class_type: "H3ReferenceAudio",
    inputs: { audio: ["voice_in", 0], max_seconds: VOICE_MAX_SECONDS },
  };
  if (variant === "a" && hasVideo1) {
    g.blender_vid = {
      class_type: "VHS_LoadVideo",
      inputs: { video: opts.blockoutName!, custom_width: passW, custom_height: passH, ...BLOCKOUT_VHS },
    };
  }
  const r2vInputs: Record<string, unknown> = {
    clip: ["clip", 0],
    vae: ["vvae", 0],
    audio_vae: ["avae", 0],
    prompt: ["split", 0],
    width: passW,
    height: passH,
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
    const injectMarks = positions.split(/[,，]/).map((p) => p.trim()).filter(Boolean);
    // Sol 0926 裁決 E：refs 同 KF 必須入同一 conditioning entry——
    // ConditioningCombine 淨係 c1+c2 並列，node1 deployed merge patch（同
    // kwargs 同時有 minimax_refs＋minimax_keyframes）唔會觸發。首尾兩針行
    // loaded H3KeyframeInject（object_info 只有 start/end，唔假設 disk
    // mid_image 已載入）。任意位置＋refs 嘅同 entry 合流係 TODO：行返
    // H3Keyframes 舊路，唔立互斥禁令。
    const injectable = Boolean(positions) && hasVideo1 && Boolean(opts.kfEndName)
      && injectMarks.length === 2 && injectMarks[0] === "0%" && injectMarks[1] === "100%";
    if (injectable) {
      g.kf_start_in = { class_type: "LoadImage", inputs: { image: opts.kfStartName } };
      g.kf_end_in = { class_type: "LoadImage", inputs: { image: opts.kfEndName! } };
      g.kf_inject = {
        class_type: "H3KeyframeInject",
        inputs: {
          conditioning: ["r2v", 0],
          // live object_info required：conditioning/vae/start_image/width/height/
          // length（Sol 留底 h3-ruling-0926/live-inject-object-info.json）；
          // 第一次 queue 漏 vae 被驗證層拒（冇燒 GPU）。
          vae: ["vvae", 0],
          start_image: ["kf_start_in", 0],
          end_image: ["kf_end_in", 0],
          width: passW,
          height: passH,
          length: opts.frames,
        },
      };
      // Sol 鏈序：R2V → H3KeyframeInject → H3FreeTextEncoder → 單一
      // H3ConditionStrength → Guider（sampler latent 仍 R2V output 1）
      g.cond_evict.inputs.conditioning = ["kf_inject", 0];
    } else {
    const kfInputs: Record<string, unknown> = {
      clip: ["clip", 0],
      vae: ["vvae", 0],
      prompt: ["split", 0],
      width: passW,
      height: passH,
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
  }
  g.noise_a = { class_type: "RandomNoise", inputs: { noise_seed: opts.seed } };
  g.sampler_sel = { class_type: "KSamplerSelect", inputs: { sampler_name: SAMPLER } };
  g.sched_a = {
    class_type: "BasicScheduler",
    inputs: { model: modelA, scheduler: SCHEDULER, steps: opts.steps, denoise: 1.0 },
  };
  // §P36 README：PDD 路 sigmas＝Apply 嘅 sigmas output（trained boundaries），
  // 唔另駁 scheduler
  const sigmasSrc: [string, number] = pdd8 ? ["pdd_apply", 1] : ["sched_a", 0];
  g.guider_a = { class_type: "BasicGuider", inputs: { model: modelOut, conditioning: condOut } };
  g.samp_a = {
    class_type: "SamplerCustomAdvanced",
    inputs: {
      noise: ["noise_a", 0],
      guider: ["guider_a", 0],
      sampler: ["sampler_sel", 0],
      sigmas: sigmasSrc,
      latent_image: ["r2v", 1],
    },
  };
  let decodeSrc: [string, number] = ["samp_a", 0];
  let audioDecodeSrc: [string, number] = ["samp_a", 0];
  if (opts.nativeUpscale && twoPass) {
    // §P34/R6（0928）README 兩-pass（PDD hi-res fix，golden＝pdd_acc_t2v_
    // latent_upscale.json）：AVLatentUpscaleBy ×1.5（video half per-frame
    // resize＋patch-grid snap；audio passes through——core LatentUpscale 處理
    // 唔到 H3 nested AV latent）→ PDDAccScheduler denoise 0.25 partial-denoise
    // refine（round(8*0.25)=淨重跑 last 2 trained blocks＝resume sigma 0.8，
    // stay on trained grid——唔用 Apply sigmas：嗰個係全長）。video 出 refine；
    // audio 出 pass1（README：refine 唔掂 audio）。scheduler nfe 同 Apply
    // partition（"8"）對齊。
    g.upscale_av = {
      class_type: "MiniMaxH3AVLatentUpscaleBy",
      inputs: { samples: ["samp_a", 0], upscale_method: "bislerp", scale_by: 1.5 },
    };
    g.sched_refine = { class_type: "MiniMaxH3PDDAccScheduler", inputs: { nfe: "8", denoise: 0.25 } };
    g.samp_refine = {
      class_type: "SamplerCustomAdvanced",
      inputs: {
        noise: ["noise_a", 0],
        guider: ["guider_a", 0],
        sampler: ["sampler_sel", 0],
        sigmas: ["sched_refine", 0],
        latent_image: ["upscale_av", 0],
      },
    };
    decodeSrc = ["samp_refine", 0];
    audioDecodeSrc = ["samp_a", 0];
  } else if (opts.nativeUpscale) {
    // 非 PDD 路（A-form/turbo4）：learned 款照舊（trained-grid refine 語義只
    // 對 PDD 成立——PDDAccScheduler 係 PDD sigmas emitter）
    g.upscale_native = {
      class_type: "MiniMaxH3LatentUpscaleCombined",
      inputs: {
        samples: ["samp_a", 0],
        method: "learned model",
        learned_model: "h3_clean_latent_upscaler_film_epoch200.safetensors",
        model: modelOut,
        noise: ["noise_a", 0],
        sigmas: sigmasSrc,
        audio_denoise: 0.0,
        noise_resample: "independent",
      },
    };
    decodeSrc = ["upscale_native", 0];
    audioDecodeSrc = ["upscale_native", 0];
  }
  g.dec_v = { class_type: "VAEDecode", inputs: { samples: decodeSrc, vae: ["vvae", 0] } };
  g.dec_a = { class_type: "VAEDecodeAudio", inputs: { samples: audioDecodeSrc, vae: ["avae", 0] } };
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
