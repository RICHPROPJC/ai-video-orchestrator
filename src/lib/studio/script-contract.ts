import { z } from "zod";
import { shotSecMin } from "./frame-grid";

export const CHARACTER_ID_RE = /^[A-Z]$/;
export const SCENE_ID_RE = /^SC\d{2}$/;
export const BEAT_ID_RE = /^SC\d{2}\.B\d{2}$/;

/** 0927 Chau 令：字數唔係閘——對白/action 幾長由故事定（同一句對白可以好長，
 *  §1）。上限淨係防模型噴垃圾嘅極寬欄位，唔再係嗰條片調出嚟嘅死數。 */
export const DIALOGUE_MAX_CHARS = 200;
export const ACTION_MAX_CHARS = 200;

/** T38 visible-verb starter list (跪／押／提／畫／坐／站… curated, extensible
 *  by card): an action must contain at least one verb a camera can see, so
 *  description cannot pose as action. Lenient by design — any listed char
 *  passes; the refine message teaches the fix on retry. */
export const VISIBLE_ACTION_VERBS =
  "站坐跪躺臥蹲企走跑行轉停退追拉推扯拖拽抓握提拎揹背扛抬舉伸縮放擱掛遞收拋扔擲撿拾掉按壓押指點畫寫塗擦抹掃洗倒灑撒撕拍打踢踏踩跳跌撲滾爬滑衝撞倚靠挨扶摟抱攬揮搖望看望瞧瞄盯聽聞嗅咬嚼吞喝飲扭擰咳嘆笑喊叫唱講哭戴脫著解鬆綁鎖扣"
  // SC-CREATIVE-OS-0927 P0：表情/現象動詞補覆蓋（瞇眼冤案類別）——診斷用，
  // 唔再阻塞 schema。冷凝水滑落（brief 主體事件）由 滑/滴/淌 覆蓋。
  + "瞇捽震顫抖凝閃漾冒滾沸噴濺沁透融淌滴敲叩篤";
export function hasVisibleActionVerb(action: string): boolean {
  return [...VISIBLE_ACTION_VERBS].some((v) => action.includes(v));
}
const BEATS_PER_SCENE_MIN = 4;
const BEATS_PER_SCENE_MAX = 12;

/** The shape of a 10-minute slate. A fixture may ask for a smaller one, so the
 *  counts are a knob with this default rather than a constant in the schema. */
export type ScriptRanges = { scenes: [number, number]; totalBeats: [number, number] };
/** 0927：場數/beat 數由故事定——band 淨係 schema 形狀，上下限放到唔約束。 */
export const FEATURE_RANGES: ScriptRanges = { scenes: [1, 200], totalBeats: [1, 2000] };
/** 5-minute episodes are a different slate, not a squeezed feature: ≤360s
 *  wants 4–8 scenes / 28–60 beats; anything longer is the 600s feature band. */
export const EPISODE_RANGES: ScriptRanges = { scenes: [1, 200], totalBeats: [1, 2000] };
export const EPISODE_MAX_SEC = 360;

/** Short slates are not forced into one scene. Scene count comes from the story. */
export const SHORT_RANGES: ScriptRanges = { scenes: [1, 200], totalBeats: [1, 2000] };
/** Kept so older ad-band callers still import. rangesFor no longer selects it from duration. */
export const AD_RANGES: ScriptRanges = { scenes: [1, 1], totalBeats: [3, 6] };
export const AD_MAX_SEC = 30;

export function rangesFor(targetSec: number): ScriptRanges {
  if (targetSec <= AD_MAX_SEC) return SHORT_RANGES;
  return targetSec <= EPISODE_MAX_SEC ? EPISODE_RANGES : FEATURE_RANGES;
}

/** Story beat count is not the H3 generate floor. shotSecMin() stays the grid. */
export function beatsFloorFor(_targetSec: number): number {
  return 1;
}

export const SECONDS_PER_BEAT_FLOOR = shotSecMin();

/** scene targetSec clamp bounds by band. */
export function sceneClampBounds(targetSec: number): { min: number; max: number } {
  const floor = shotSecMin();
  return targetSec <= AD_MAX_SEC
    ? { min: Math.min(floor, targetSec), max: Math.max(targetSec, floor) }
    : { min: SCENE_TARGET_MIN, max: SCENE_TARGET_MAX };
}
export const SCENE_TARGET_MIN = 1;
export const SCENE_TARGET_MAX = 3600;
const TARGET_TOLERANCE = 0.1;

export function maxBeatsIn(sceneTargetSec: number): number {
  return Math.floor(sceneTargetSec / beatsFloorFor(sceneTargetSec));
}

/** Spoken pace, not a slow read. 0.23s/char + 0.6s lead-in made one line
 *  look like 8s, so the writer dropped the rest of the scene's lines. */
export const SECONDS_PER_CHAR = 0.12;
export const DIALOGUE_LEAD_IN = 0.15;

export function dialogueSeconds(line: string): number {
  const text = line.trim();
  if (!text) return 0;
  return text.length * SECONDS_PER_CHAR + DIALOGUE_LEAD_IN;
}

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, "must be a #rrggbb colour");

/** Models in JSON mode write `null` for a key they mean to leave out; that is
 *  the same thing here, and retrying three times over it teaches nobody. */
export function omittable<T extends z.ZodTypeAny>(inner: T) {
  return z.preprocess((v) => (v === null || v === "" ? undefined : v), inner.optional());
}

/** heightM is the blockout mannequin's scale, not a person's height: blender
 *  puts hands at 0.85·h, and above the lens that ray has no floor to reach. */
export const characterSchema = z.object({
  id: z.string().regex(CHARACTER_ID_RE, "id must be one capital letter A–Z"),
  name: z.string().min(1).max(12),
  role: z.string().min(1).max(40),
  wardrobe: z.string().min(1).max(120),
  palette: z.tuple([hex, hex, hex]),
  voice: z.object({
    pitchHz: z.number().min(60).max(400),
    gender: z.enum(["f", "m", "n"]),
  }),
  heightM: z.number().min(0.8).max(1.2),
  publicName: omittable(z.string().min(1).max(24)),
  speaks: z.boolean(),
});

export const sceneSchema = z.object({
  id: z.string().regex(SCENE_ID_RE, "scene id must be SCxx"),
  heading: z.string().min(1).max(60),
  location: z.string().min(1).max(60),
  timeOfDay: z.enum(["dawn", "day", "dusk", "night"]),
  weather: z.enum(["clear", "rain", "wind", "neon"]),
  summary: z.string().min(1).max(200),
  // band bounds live in sceneClampBounds / outlineSchema — the shape only
  // guards the sanity floor so ad slates (15–30s scenes) parse too
  targetSec: z.number().min(1).max(SCENE_TARGET_MAX),
});

export const worldSchema = z.object({
  location: z.string().min(1).max(60),
  timeOfDay: z.enum(["dawn", "day", "dusk", "night"]),
  weather: z.enum(["clear", "rain", "wind", "neon"]),
  grade: z.string().min(1).max(160),
  refs: z.array(z.string().min(1).max(60)).min(1).max(6),
});

const outlineShape = z.object({
  thinking: z.string().min(1).max(600),
  title: z.string().min(1).max(40),
  logline: z.string().min(1).max(200),
  mood: z.string().min(1).max(80),
  language: z.enum(["zh-Hant", "yue", "en"]),
  world: worldSchema,
  characters: z.array(characterSchema).min(1).max(12),
  scenes: z.array(sceneSchema).min(1),
  targetSec: z.number().positive(),
});

export type Outline = z.infer<typeof outlineShape>;

function duplicates(ids: string[]): string[] {
  const seen = new Set<string>();
  return [...new Set(ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false))))];
}

/** Roster and the run's real target come from the packet, so the gate is a
 *  factory — a failed check is fed straight back to the seat as a retry. */
export function outlineSchema(ctx: { targetSec: number; castRoster: string[]; ranges?: ScriptRanges }) {
  const roster = new Set(ctx.castRoster);
  const [sceneMin, sceneMax] = (ctx.ranges ?? FEATURE_RANGES).scenes;
  return outlineShape.superRefine((outline, report) => {
    if (outline.scenes.length < sceneMin || outline.scenes.length > sceneMax) {
      report.addIssue({
        code: "custom",
        path: ["scenes"],
        message: `a ${ctx.targetSec}s slate wants ${sceneMin}–${sceneMax} scenes, got ${outline.scenes.length}`,
      });
    }
    const dupChars = duplicates(outline.characters.map((c) => c.id));
    if (dupChars.length) {
      report.addIssue({ code: "custom", path: ["characters"], message: `duplicate character ids: ${dupChars.join(", ")}` });
    }
    const dupNames = duplicates(outline.characters.map((c) => c.name));
    if (dupNames.length) {
      report.addIssue({ code: "custom", path: ["characters"], message: `duplicate character names: ${dupNames.join(", ")}` });
    }
    const dupScenes = duplicates(outline.scenes.map((s) => s.id));
    if (dupScenes.length) {
      report.addIssue({ code: "custom", path: ["scenes"], message: `duplicate scene ids: ${dupScenes.join(", ")}` });
    }
    // 0927：「至少一人講嘢」已拆——無對白片（産品示範／MV）全 speaks:false 合法。
    for (const [i, c] of outline.characters.entries()) {
      if (c.speaks && roster.size && !roster.has(c.name)) {
        report.addIssue({
          code: "custom",
          path: ["characters", i, "name"],
          message: `speaking character must be cast from castRoster: '${c.name}' is not in the roster`,
        });
      }
    }
    // 0927：總長 band 檢查已拆——成片秒數係各場劇情加總，機器時鐘（wav/幀格）
    // 先係真源，唔用先驗死數束縛。
    void TARGET_TOLERANCE;
  });
}

const beatShape = z.object({
  id: z.string().regex(BEAT_ID_RE, "beat id must be SCxx.Byy"),
  // SC-CREATIVE-OS-0927 P0：可見動詞白名單由阻塞 refine 降級做非阻塞診斷——
  // 字表永遠追唔到下一個正當事件（瞇眼/冷凝水滑落都被佢屈過），語義可拍性
  // 由創作層同能力層把關，唔迫 writer 換動作過格式。診斷走 actionVerbGaps。
  action: z
    .string()
    .min(1)
    .max(ACTION_MAX_CHARS),
  dialogue: omittable(z.string().max(DIALOGUE_MAX_CHARS)),
  speaker: omittable(z.string().min(1).max(12)),
  emotion: omittable(z.string().min(1).max(20)),
});

/** 非阻塞診斷：邊啲 action 冇詞表覆蓋嘅動詞。只供觀測（seat warn＋收據），
 *  唔影響 schema 通過；覆蓋缺口本身係驗收器要補嘅訊號，唔係 writer 禁語。 */
export function actionVerbGaps(actions: string[]): string[] {
  return actions.filter((a) => !hasVisibleActionVerb(a));
}

const sceneBeatsShape = (min: number) =>
  z.object({
    sceneId: z.string().regex(SCENE_ID_RE),
    thinking: z.string().min(1).max(600),
    beats: z.array(beatShape).min(min),
  });

export type SceneBeats = z.infer<ReturnType<typeof sceneBeatsShape>>;
export type Beat = z.infer<typeof beatShape>;

export function sceneBeatsSchema(ctx: { sceneId: string; speakingNames: string[]; targetSec: number }) {
  const speaking = new Set(ctx.speakingNames);
  const beatsMin = 1; // 0927：beat 數由故事定，唔設下限閘
  const beatCeiling = maxBeatsIn(ctx.targetSec);
  return sceneBeatsShape(beatsMin).superRefine((scene, report) => {
    if (scene.sceneId !== ctx.sceneId) {
      report.addIssue({ code: "custom", path: ["sceneId"], message: `this envelope is scene ${ctx.sceneId}, not ${scene.sceneId}` });
    }
    if (scene.beats.length > beatCeiling) {
      report.addIssue({
        code: "custom",
        path: ["beats"],
        message: `${ctx.targetSec}s of screen time holds at most ${beatCeiling} beats, not ${scene.beats.length}: merge the small ones`,
      });
    }
    const dup = duplicates(scene.beats.map((b) => b.id));
    if (dup.length) report.addIssue({ code: "custom", path: ["beats"], message: `duplicate beat ids: ${dup.join(", ")}` });
    for (const [i, beat] of scene.beats.entries()) {
      if (!beat.id.startsWith(`${ctx.sceneId}.B`)) {
        report.addIssue({ code: "custom", path: ["beats", i, "id"], message: `beat id must start with ${ctx.sceneId}.B` });
      }
      const line = beat.dialogue?.trim() ?? "";
      if (line && !beat.speaker) {
        report.addIssue({ code: "custom", path: ["beats", i, "speaker"], message: "a beat with dialogue needs its speaker" });
      }
      if (!line && beat.speaker) {
        report.addIssue({ code: "custom", path: ["beats", i, "dialogue"], message: "a speaker with no dialogue: drop the speaker or write the line" });
      }
      if (beat.speaker && !speaking.has(beat.speaker)) {
        report.addIssue({
          code: "custom",
          path: ["beats", i, "speaker"],
          message: `'${beat.speaker}' is not a speaking character of this script`,
        });
      }
    }
  });
}

export type Script = { outline: Outline; scenes: SceneBeats[] };

/** Total beat count only exists once every scene is back from the seat. */
export function assertBeatTotal(script: Script, ranges: ScriptRanges = FEATURE_RANGES): void {
  const total = script.scenes.reduce((a, s) => a + s.beats.length, 0);
  const [min, max] = ranges.totalBeats;
  if (total < min || total > max) {
    throw new Error(`script has ${total} beats; a ${script.outline.targetSec}s slate wants ${min}–${max}`);
  }
  const covered = new Set(script.scenes.map((s) => s.sceneId));
  const missing = script.outline.scenes.filter((s) => !covered.has(s.id)).map((s) => s.id);
  if (missing.length) throw new Error(`script is missing beats for ${missing.join(", ")}`);
}
