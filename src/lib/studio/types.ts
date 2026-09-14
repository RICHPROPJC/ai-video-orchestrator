export type JobStatus =
  | "queued"
  | "running"
  | "blocked"
  | "locked"
  | "failed"
  | "dry-run"
  | "boarded"
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
   *  stills = after photo QC GREEN, motion = after H3 downloads (before mux) */
  until?: "boards" | "stills" | "motion";
  /** C-scene-hop: burn H3 for ONE scene only (must match SCxx). Motion-lane
   *  filter — stills/QC/layout stay full-slate. Omitted = all shots. */
  scene?: string;
  /** reuse this slate's callsheet and finished artefacts instead of starting over */
  resume?: boolean;
  /** names the writer may cast speaking parts from (data file, never in src) */
  castRosterPath?: string;
  /** load this callsheet JSON instead of letting the seats author one */
  callSheetPath?: string;
  /** H3 graph shape: default A (Video 1 + kfinject); B/BKF/C for verify/ab experiments */
  graphVariant?: "a" | "b" | "bkf" | "c";
  /** test-only H3 sampler steps override; live default stays config.motion.steps (4) */
  steps?: number;
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

export type ShotProp = {
  name: string;
  /** characterId of the mark whose hands hold it */
  heldBy?: string;
  shape: string[];
  forbid: string[];
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
  props?: ShotProp[];
  stillPrompt: string;
  motionPrompt: string;
  /** which scene and beat the seats cut this shot from */
  scene?: string;
  beatId?: string;
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
  pictureQc: { label: "畫檢", en: "Picture QC", desk: "SenseNova MARS-8B" },
  motion: { label: "生片", en: "Motion", desk: "MiniMax H3" },
  voice: { label: "聲線", en: "Voice", desk: "TTS + clone" },
  soundQc: { label: "聲檢", en: "Sound QC", desk: "SenseVoice" },
  editor: { label: "剪接", en: "Editor", desk: "照分鏡次序" },
  delivery: { label: "交片", en: "Delivery", desk: "Picture lock" },
};
