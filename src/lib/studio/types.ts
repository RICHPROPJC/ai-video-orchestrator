export type JobStatus =
  | "queued"
  | "running"
  | "blocked"
  | "locked"
  | "failed"
  | "dry-run"
  | "boarded"
  | "blockout-ready"
  | "stills-ready"
  | "motion-ready";

export type AgentId =
  | "producer"
  | "writer"
  | "boards"
  | "art"
  | "layout"
  | "stills"
  | "pictureQc"
  | "motion"
  | "voice"
  | "soundQc"
  | "editor"
  | "delivery";

export type Vec2 = { x: number; y: number };
export type Vec3 = { x: number; y: number; z: number };

export type ShotSize =
  | "wide"
  | "full"
  | "medium"
  | "closeup"
  | "insert";

export type ProduceInput = {
  brief: string;
  durationSec?: number;
  aspect?: "16:9" | "9:16" | "1:1";
  language?: "auto" | "zh-Hant" | "zh-Hans" | "yue" | "en";
  voiceClonePath?: string;
  wavDir: string;
  portraitsDir?: string;
  blockoutDir?: string;
  gapSec?: number;
  dryRun?: boolean;
  /** stop early: boards = seats have written the callsheet (no wavs yet),
   *  blockout = grey blockout + f0 done (no U1.5 / QC / H3),
   *  stills = after photo QC GREEN, motion = after H3 downloads (before mux) */
  until?: "boards" | "blockout" | "stills" | "motion";
  /** C-scene-hop: burn H3 for ONE scene only (must match SCxx). Motion-lane
   *  filter — stills/QC/layout stay full-slate. Omitted = all shots. */
  scene?: string;
  /** reuse this slate's callsheet and finished artefacts instead of starting over */
  resume?: boolean;
  /** names the writer may cast speaking parts from (data file, never in src) */
  castRosterPath?: string;
  /** load this callsheet JSON instead of letting the seats author one */
  callSheetPath?: string;
  /** H3 graph shape: default A = official path (Video 1 motion-only + H3Keyframes
   *  anchors; identity burned into the still by U1.5 /edit). B/BKF = documented
   *  FALLBACK (card C ②, 0919): the character-image ref route is officially
   *  legitimate (samples #17/#22/#23/#31/#34) but is only for shots with NO
   *  still-pinned identity. C = verify alternate (zero refs). */
  graphVariant?: "a" | "b" | "bkf" | "c";
  /** test-only H3 sampler steps override; live default stays config.motion.steps (4) */
  steps?: number;
  /** L1b: drama id under projects/<drama>/ — seats write this film there, not Cursor folders */
  drama?: string;
  /** episode surface, e.g. EP01 — playbooks/events live under the drama dir */
  episode?: string;
};

export type JobEvent = {
  ts: string;
  agent: AgentId | "system";
  level: "info" | "warn" | "error" | "pass" | "fail";
  message: string;
  data?: Record<string, unknown>;
  /** D1a topology: which pipeline step emitted this event, its upstream steps
   *  (boards → keyframe-prompt → require), the seat that wrote it, and which
   *  trace constraint ids were checked at that step. emit passes them through
   *  when present; think/speak text is never rewritten. */
  step_id?: string;
  parent_steps?: string[];
  seat?: string;
  constraints_checked?: string[];
};

/** A4 events law: a per-stage line carries these keys inside JobEvent.data —
 *  shot, stage, eye, verdict, proof (repo-relative artefact path; absent when
 *  the stage proves nothing on disk) and ms (the stage's own wall clock).
 *  Stage events land in data verbatim; emit dual-writes them to
 *  projects/<ep>/events.jsonl. Tests lock all six. */
export type StageFacts = {
  shot: string;
  stage: string;
  eye: string;
  verdict: "pass" | "fail" | "info";
  proof?: string;
  ms?: number;
};

export type Character = {
  id: string;
  name: string;
  role: string;
  wardrobe: string;
  palette: [string, string, string];
  voice: { pitchHz: number; gender: "f" | "m" | "n" };
  /** blockout mannequin height in metres — data decides, src has no per-name constants */
  heightM?: number;
};

export type Stance = "stand" | "lean" | "crouch";

/** §0b angle-ref law (Chau 0920): which angle version a shot's Image ref slots
 *  carry — "45" = the three-quarter ref (a frontal ref on a sideways shot
 *  drags the face back to camera). Absent = "front". 90° is prompt-forbidden,
 *  never a value here. */
export type RefAngle = "front" | "45";

// type-only: UiShotSpec lives with the prose machinery that validates it
// (h3-prose imports Shot/CallSheet back — type level only, erased at runtime)
import type { UiShotSpec } from "./h3-prose";
export type { UiShotSpec };

export type ShotProp = {
  name: string;
  /** characterId of the mark whose hands hold it */
  heldBy?: string;
  shape: string[];
  forbid: string[];
};

/** Chau 0919 search-first PE law: one evidence row behind every number a
 *  frame puts on screen. Packet-authored (boards seat or the PE step writing
 *  wigolo results back) — code assembles these verbatim, never authors them. */
export type ShotFact = {
  claim: string;
  source: string;
  /** YYYY-MM-DD, the day the evidence was fetched */
  fetched_at: string;
};

export type ShotRequire = {
  /** evidence rows for text/data screens; a facts-needing shot with none refuses to emit */
  facts?: ShotFact[];
  /** the seat marks this shot a text/data screen even when the action words don't say it */
  factsRequired?: boolean;
  /** packet scene room — the ONE scene truth source (Fable 1d9bb51):
   *  keyframeEditPrompt reads require.location ?? shot.location, sheet tail
   *  last. Prompt and photo-qc gate on this single field. Compound place
   *  words are the point (地下室檔案室, not 地下室): the word the eye must
   *  find is the word the packet wrote — never enum-locked to one room. */
  location?: string;
  /** B-lane freeze-frame sentence — the pose held at its instant, zero
   *  process verbs. Packet-authored (boards copies the verified sentence);
   *  the prompt carries it verbatim, riding after the brief band. */
  action?: string;
  /** body-part spatial sentence at 體重由邊度承住 grade (POSE_LEXICON
   *  register) — the packet copies the lexicon sentence, code only assembles;
   *  the vocabulary itself never moves into src. */
  pose?: string;
  /** background-creep lock (§0b 0920 編輯漂移, Chau 批①): the 【不變】 list —
   *  background walls / set dressing / left-right object positions every edit
   *  hop must hold unchanged. Packet-authored, one clause per item; rides
   *  after the brief band with the other extras. */
  unchanged?: string[];
  /** T32 camera line — eye/high/low picks the still's light sentence
   *  (keyframe-prompt 均勻/低位/頂光); boards-expand copies shot.angle in. */
  angle?: "eye" | "high" | "low";
  /** packet-authored ban list per 道具/場景類別 — keyframeEditPrompt
   *  echoes it as 唔準/唔好 lines (Chau 17:48). */
  negatives?: string[];
};

export type Shot = {
  id: string;
  index: number;
  heading: string;
  size: ShotSize;
  location: string;
  action: string;
  dialogue: string;
  speaker?: string;
  durationSec: number;
  camera: {
    pos: Vec3;
    lookAt: Vec3;
    lensMm: number;
  };
  marks: {
    characterId: string;
    start: Vec2;
    end: Vec2;
    facing: number;
    handL: Vec2;
    handR: Vec2;
    footL: Vec2;
    footR: Vec2;
    gait: "plant" | "walk" | "reach" | "turn";
    stance?: Stance;
    stanceEnd?: Stance;
  }[];
  /** callsheet column: the angle of the refs this shot's Image slots hold;
   *  keyframeEditPrompt aims the facing sentence at the ref when "45".
   *  Optional — absent reads as "front". */
  refAngle?: RefAngle;
  props?: ShotProp[];
  /** T32 rev2: 阿圖 packet 場景 slot — boards author this per shot (sealed+zod);
   * the stills scene sentence reads it, sheet tail is only the fallback.
   * Chau 17:48: negatives are packet data (bans authored per 道具/場景類別). */
  require?: ShotRequire;
  stillPrompt: string;
  motionPrompt: string;
  /** which scene and beat the seats cut this shot from */
  scene?: string;
  beatId?: string;
  /** card ③b: UI/infographic shot marker — the only gate that opens the H3
   *  photo channel (law: 文字圖／手機畫面等 UI 反而可以俾 H3 ref). Story shots
   *  leave this unset and stay ref-free, marker or not. */
  uiShot?: boolean;
  /** card ③b prose spec: mapping table + on-screen text engineering; forces
   *  identity-long prose */
  uiSpec?: UiShotSpec;
  /** card ③b photo refs on disk (UI screenshots / data cards) — live submit
   *  uploads them to ref_images.ref_image_N, dry-run names them. Paths are
   *  used as given; live submit throws on a missing file. */
  uiRefs?: string[];
};

/** Which seat wrote the sheet, on which model, with the receipts to prove it. */
export type Provenance = {
  writer: { model: string; receipts: string[] };
  boards: { model: string; receipts: string[] };
  sha256: string;
};

export type CallSheet = {
  title: string;
  logline: string;
  language: "zh-Hant" | "en" | "yue";
  location: string;
  timeOfDay: "dawn" | "day" | "dusk" | "night";
  weather: "clear" | "rain" | "wind" | "neon";
  mood: string;
  durationSec: number;
  aspect: "16:9" | "9:16" | "1:1";
  characters: Character[];
  styleBible: {
    grade: string;
    refs: string[];
    stillModel: string;
    motionModel: string;
  };
  shots: Shot[];
  voiceover: string;
  scenes?: { id: string; heading: string; summary: string; targetSec: number }[];
  provenance?: Provenance;
};

export type QcIssue = {
  code: string;
  severity: "block" | "warn";
  detail: string;
  region?: string;
};

export type SoundQc = {
  provider: string;
  transcript: string;
  language: string;
  emotion: string;
  events: string[];
  wer: number;
  durationSec: number;
  peak: number;
  silenceRatio: number;
  cloneSimilarity: number;
  pass: boolean;
  issues: QcIssue[];
};

export type PictureQc = {
  provider: string;
  target: "stills" | "video";
  overall: number;
  identity: number;
  composition: number;
  hands: number;
  feet: number;
  artifacts: number;
  pass: boolean;
  notes: string;
  issues: QcIssue[];
};

export type ProviderTrace = {
  stills: string;
  motion: string;
  tts: string;
  senseVoice: string;
  mars: string;
  blender: string;
  lipSync: string;
};

export type JobRecord = {
  id: string;
  slate: string;
  createdAt: string;
  updatedAt: string;
  status: JobStatus;
  input: ProduceInput;
  /** set by producer from input.drama — projects/<drama>/ base layer */
  drama?: string;
  /** set by producer from input.episode — EP01…EP10 surface */
  episode?: string;
  progress: number;
  currentAgent?: AgentId;
  callSheet?: CallSheet;
  continuity?: import("./continuity").Continuity;
  narrativePlan?: import("./narrative").NarrativePlan;
  vault?: { docs: number; isolated: true; modalities: Record<string, number> };
  providers?: ProviderTrace;
  soundQc?: SoundQc;
  pictureQcStills?: PictureQc;
  pictureQcVideo?: PictureQc;
  retries: { stills: number; voice: number; motion: number };
  outputs: {
    stills: string[];
    shots: string[];
    blockout: string[];
    receipts: string[];
    voice?: string;
    blenderScript?: string;
    blockingPreview?: string;
    pictureLock?: string;
    callSheet?: string;
    continuity?: string;
    narrativePlan?: string;
    vault?: string;
    qcReport?: string;
    cutPlan?: string;
    concatGate?: string;
    /** h3-prose scene preview (lane/crew motion prose card): motion/scene-preview.mp4 */
    scenePreview?: string;
  };
  error?: string;
};

export const AGENT_META: Record<
  AgentId,
  { label: string; en: string; desk: string }
> = {
  producer: { label: "製片", en: "Producer", desk: "一份 continuity" },
  writer: { label: "編劇", en: "Writer", desk: "故事 / 對白" },
  boards: { label: "分鏡", en: "Boards", desk: "同一 SH id" },
  art: { label: "美術", en: "Art", desk: "Style bible" },
  layout: { label: "走位", en: "Layout", desk: "Blender 手腳 IK" },
  stills: { label: "生圖", en: "Stills", desk: "SenseNova U1.5" },
  pictureQc: { label: "畫檢", en: "Picture QC", desk: "Qwen 27B qwen38" },
  motion: { label: "生片", en: "Motion", desk: "MiniMax H3" },
  voice: { label: "聲線", en: "Voice", desk: "TTS + clone" },
  soundQc: { label: "聲檢", en: "Sound QC", desk: "SenseVoice" },
  editor: { label: "剪接", en: "Editor", desk: "照分鏡次序" },
  delivery: { label: "交片", en: "Delivery", desk: "Picture lock" },
};
