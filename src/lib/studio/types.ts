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
  /** MULTISHOT_WIRE: skip the motion-select step (no decider call, no mocap
   *  bake — the workbench grey blockouts stand). */
  noMotionSelect?: boolean;
  /** CAPGAP_0927: 可見分鏡板 0 格預設係 capability gap（job blocked）。人手
   *  確認照行先開呢道門（CLI --allow-no-storyboard）；預設 false。 */
  allowNoStoryboard?: boolean;
  dryRun?: boolean;
  /** stop early: boards = seats have written the callsheet (no wavs yet),
   *  blockout = grey blockout + f0 done (no U1.5 / QC / H3),
   *  stills = after photo QC GREEN, motion = after H3 downloads (before mux) */
  until?: "boards" | "blockout" | "stills" | "motion";
  /** 最薄選鏡入口：只行呢一鏡嘅正式 stills→H3→mux 閉環（--only SH03） */
  only?: string;
  /** C-scene-hop: burn H3 for ONE scene only (must match SCxx). Motion-lane
   *  filter — stills/QC/layout stay full-slate. Omitted = all shots. */
  scene?: string;
  /** Redo this shot and every later shot. Earlier GREEN stays. */
  shot?: string;
  /** reuse this slate's callsheet and finished artefacts instead of starting over */
  resume?: boolean;
  /** names the writer may cast speaking parts from (data file, never in src) */
  castRosterPath?: string;
  /** §30-1/§31-2 G1（0928）：user/task 採用鎖——caller 明示（原始來源＋全文/
   *  詞級範圍）；plan 漏鎖＝缺口唔解鎖；無鎖合法。舊 brief 引號∩plan 交集
   *  方式已退役。 */
  dialogueLocks?: { rawText: string; scope: "full-line" | "word-level"; source: string }[];
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
  /** Public shelf name. The story name stays; this name must not be a drama noun. */
  publicName?: string;
};

export type Stance = "stand" | "lean" | "crouch" | "sit"; // SC-CREATIVE-OS-0927：sit＝有支撐嘅坐（唔再屈 crouch）

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
  /** A measurement you wrote. Absent means the world stops. */
  sizeM?: number;
  sizeSource?: string;
  proportion?: { of: string; at: "knee" | "waist" | "chest" | "shoulder"; source: string };
  /** Public shelf name. The story name stays; this name must not be a drama noun. */
  publicName?: string;
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
  /** SC-CREATIVE-OS-0927 P1：一鏡多 beat 覆蓋（多對多）；舊消費者照讀 beatId。 */
  beatIds?: string[];
  /** DIALOGUE_RULE_PROVENANCE_0927：邊句對白嘅「聲音」經過呢鏡（beat id，
   *  可以係其他場嘅 beat——跨場景聲橋）。聲音關聯唔係畫面包含：speaker 唔使
   *  喺本鏡 cast（畫外聲／反應鏡合法）。組裝層（boards-expand）據此衍生
   *  audioEvents；舊 sheet 冇呢個 key 照行每鏡一句舊路。 */
  audioBeats?: string[];
  /** 世界暫停／時間感類故事嘅可見前後動作（環境動畫通道）：時鐘指針、窗前
   *  光影條、盒疊等**幾何**環境件 keyframe——blockout 係 WORKBENCH FLAT
   *  （光源 energy 唔可見），所以載體必須係幾何，灰模 QC 先睇得到前後動作。
   *  keys 相對本鏡 f0；跨鏡同一 object 連續 keyframe（時鐘全片一路走）。 */
  envAnim?: EnvAnimTrack[];
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
  /** COMBAT_PORT_0921: causal combat state attached by the boards-stage
   *  combat pass (combat-adapter) — Beat七欄/state relay/ACTION_RISK. Absent
   *  on every non-combat shot; type-only import, erased at runtime
   *  (UiShotSpec precedent). */
  combat?: import("./combat-adapter").CombatShotState;
  /** H3Keyframes positions, the shot's own string (e.g. "0%, 30%, 70%, 100%").
   *  Absent → the factory stops before H3. Not limited to 0% and 100%. */
  keyframePositions?: string;
  /** Cut cells from one sheet (one spawn, then cut). Not one image per shot. */
  keyframeFiles?: string[];
};

/** Which seat wrote the sheet, on which model, with the receipts to prove it. */
export type Provenance = {
  writer: { model: string; receipts: string[] };
  boards: { model: string; receipts: string[] };
  sha256: string;
};

/** DIALOGUE_RULE_PROVENANCE_0927：對白＝聲音事件——自身身份（beatId）、
 *  speaker、文本、共同時間線區間（cut order 累計秒）。畫面鏡頭自有 scene／
 *  visible cast／時間；兩者以時間區間關聯：同一句可跨多鏡／跨場景（先拍講者
 *  再拍聽者、聲橋），一鏡亦可多句或零句。原始 utterance 只按 take 生成一次，
 *  切鏡切片播放，唔重新生成、唔重播、唔將講者改成被拍嘅聽者。
 *  startSec/endSec 由 boards-expand 組裝時寫入；實際音軌時長回填係下遊
 *  dialogue-bed 嘅事（字數估時只係初步估算，唔係硬閘）。 */
export type EnvAnimObject = "clock_hand" | "window_bar" | "stack_box";
export type EnvAnimChannel = "rotate_z" | "pos_z" | "scale_z";
export type EnvAnimTrack = {
  object: EnvAnimObject;
  channel: EnvAnimChannel;
  /** [frame（相對本鏡開頭）, value]：rotate_z 度數（順時針）；pos_z 米；
   *  scale_z 倍率。最少兩點。 */
  keys: [number, number][];
  /** step＝逐格跳（秒針彈跳感）；linear＝連續掃。默認 linear。 */
  interp?: "step" | "linear";
  note?: string;
};

export type AudioEvent = {
  beatId: string;
  speaker: string;
  text: string;
  startSec: number;
  endSec: number;
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
  /** DIALOGUE_RULE_PROVENANCE_0927：對白聲音事件時間線（boards-expand 衍生）。
   *  有呢個 key＝聲音／畫面分離生效（voice hop 逐事件一 take、逐鏡切片；
   *  soundQC 對事件序）；冇（舊 plug callsheet）＝每鏡一句舊路，行為照舊。 */
  audioEvents?: AudioEvent[];
  /** §13.4：聲音契約版本（新編譯 sheet 明示）——events 模式＋必要事件身份
   *  （有對白 beat id 全集）。loadCallSheet 對呢個 gate：audioEvents 整組
   *  遺失／缺必要事件→拒載（來源未知明示待解）。冇呢個 key＝合法 legacy
   *  plug 路照行（唔降級——本來就係佢模式）。 */
  soundContract?: { mode: "events"; expectedDialogueBeats: string[] };
  /** §12 優先2：boards 席聲畫採用收據（scene 級收集）——生成前計劃語義
   *  判斷；adoptionIssues 由 world 併入 placementGaps 行同一有界修訂鏈。 */
  onImageAdoptions?: { placement: string; shotIds: string[]; plan: string; reason: string }[];
  adoptionIssues?: string[];
  voiceover: string;
  scenes?: { id: string; heading: string; summary: string; targetSec: number }[];
  /** One era, ten building types, one 4K board. Absent → the factory does not invent eras. */
  buildings?: { era: string; types: string[]; publicName?: string }[];
  storyboard?: { shotId: string; at: string; file: string; board?: string }[];
  /** 裁決 0928 D：導演 dialogueClock 落點隨 callsheet 落 world 段——
   *  audioTimeline 對照（聲畫對位收據）。舊 callsheet 冇呢欄＝對照跳過。 */
  directorPlacements?: { word?: string; startSec?: number; endSec?: number; onImage?: string }[];
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
  /** 裁決 0928（SEAT-AUDIT-DECISION §4）：冇實際量度＝null（附 note 讀原因），
   *  唔准無量度常數扮相似度結果。 */
  cloneSimilarity: number | null;
  cloneSimilarityNote?: string;
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
  /** V2a（PLAN-v2 0928）：resume 唔清死因——舊 error 搬呢度，唔准靜靚消失 */
  lastError?: string;
  /** V2a：呢份 job.json 最後一次寫入時嘅 owner epoch（guard 比對用） */
  ownerEpoch?: number;
  /** V3（PLAN-v2 0928）§9.1：per-shot blocked 彙總——emit data.blocked 自動
   *  upsert；同 shot 有 pass verdict 自動清。UI／resume 讀同一份狀態。 */
  blockedShots?: { shot: string; stage?: string; reason: string; ts: string }[];
  /** §7②（0928）：聲畫對位缺口——audioTimeline 對照 missing 嘅句子。
   *  resume 時 authorStage 讀到＝強制導演 revise（帶差距回責任席），
   *  唔照食舊 callsheet。修訂成功後 gaps 由新 callsheet 重算清返。 */
  placementGaps?: { utterance: string; text: string; ts: string; attempts?: number; shotIds?: string[] }[];
  /** §13.2：聲畫修復 episode（job 持久）——額度真源。開＝首次 gap 出現；
   *  閉＝gaps 全清零；再現 gap 開新 episode（真正新一輪修復）。attempts＝
   *  episode 內已消耗修訂次數（author 攔截遞增；行內 loop/resume 共用）。
   *  beatId/text/issue 描述係內容映射，唔係開新 episode 條件——改台詞唔重置。 */
  soundRepairEpisode?: { id: string; openedAt: string; source: string; attempts: number } | null;
  /** §25 A（0928）：callsheet 時長修訂 episode（跨 resume／換模型同一額度）
   *  ——author 讀傳 runBoards、每輪 onAttempt patch 遞增；null＝已閉。 */
  callsheetRepairEpisode?: { attempts: number } | null;
  /** root R2 修③（0928）：現行採用 callsheet digest（callsheet.json 落盤時寫）——session turn dependsOn 對比真源；未有 callsheet＝undefined。 */
  callsheetDigest?: string;
  /** §P33 A3（0928）：待採納 revise turn 佇列（sessions.jsonl turnId）——pipeline owner 安全點讀 */
  pendingReviseTurns?: string[];
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
    /** Owning seat of the last blocked decision, plus the tail to redo. */
    redo?: string;
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
