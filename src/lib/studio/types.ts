export type JobStatus =
  | "queued"
  | "running"
  | "blocked"
  | "locked"
  | "failed";

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
};

export type JobEvent = {
  ts: string;
  agent: AgentId | "system";
  level: "info" | "warn" | "error" | "pass" | "fail";
  message: string;
  data?: Record<string, unknown>;
};

export type Character = {
  id: string;
  name: string;
  role: string;
  wardrobe: string;
  palette: [string, string, string];
  voice: { pitchHz: number; gender: "f" | "m" | "n" };
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
  }[];
  stillPrompt: string;
  motionPrompt: string;
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
    voice?: string;
    blenderScript?: string;
    blockingPreview?: string;
    pictureLock?: string;
    callSheet?: string;
    continuity?: string;
    narrativePlan?: string;
    vault?: string;
    qcReport?: string;
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
