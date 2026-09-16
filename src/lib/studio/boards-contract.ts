import { z } from "zod";
import { BEAT_ID_RE, CHARACTER_ID_RE, SCENE_ID_RE, dialogueSeconds, omittable, type Beat } from "./script-contract";
import { isRoomNoun, negativePoison } from "./keyframe-prompt";

/** One shot is one H3 submit: the frame grid (17k+5, k 7–21) cannot render
 *  anything shorter or longer, so boards may not ask for it. */
export const SHOT_SEC_MIN = 5.2;
export const SHOT_SEC_MAX = 15;
const SHOT_ACTION_MAX = 60;
const CAST_PER_SHOT_MAX = 3;

/** Each scene is held to its own share of the slate's clock; the shares are
 *  normalised before they get here, so holding every scene holds the film. */
export const SCENE_BUDGET_TOLERANCE = 0.09;

const castSchema = z.object({
  characterId: z.string().regex(CHARACTER_ID_RE),
  slot: z.enum(["L", "C", "R"]),
  depth: z.enum(["near", "mid", "far"]),
  facing: z.union([z.literal(1), z.literal(-1)]),
  gait: z.enum(["plant", "walk", "reach", "turn"]),
  stance: z.enum(["stand", "lean", "crouch"]),
  stanceEnd: omittable(z.enum(["stand", "lean", "crouch"])),
  travelTo: omittable(z.enum(["L", "C", "R"])),
});

const propSchema = z.object({
  name: z.string().min(1).max(20),
  heldBy: omittable(z.string().regex(CHARACTER_ID_RE)),
  shape: z.array(z.string().min(1).max(12)).min(1).max(5),
  forbid: z.array(z.string().min(1).max(12)).max(8),
});

const boardShotShape = z.object({
  beatId: z.string().regex(BEAT_ID_RE),
  size: z.enum(["wide", "full", "medium", "closeup", "insert"]),
  angle: z.enum(["eye", "high", "low"]),
  side: z.enum(["frontal", "leftQuarter", "rightQuarter"]),
  durationSec: z.number().min(SHOT_SEC_MIN).max(SHOT_SEC_MAX),
  action: z.string().min(1).max(SHOT_ACTION_MAX),
  dialogue: z.string().nullish().transform((v) => v ?? ""),
  speaker: omittable(z.string().min(1).max(12)),
  cast: z.array(castSchema).min(1).max(CAST_PER_SHOT_MAX),
  props: omittable(z.array(propSchema).max(3)),
  /** T32 rev2: per-shot scene slot the boards seat authors — location (and
   * optionally its own light angle) the stills prompt must follow. Chau 17:48:
   * negatives 阿圖按道具/場景類別填；毒詞（霓虹/neon/night）連 negative 都落閘。
   * T32b C5（Chau 22:24）：location 要係 2–8 字場所名詞，機構全名歸 heading。 */
  require: omittable(
    z.object({
      location: z.string().min(2).max(8),
      angle: omittable(z.enum(["eye", "high", "low"])),
      negatives: omittable(z.array(z.string().min(1).max(12)).min(1).max(6)),
    })
      .refine((req) => isRoomNoun(req.location), {
        message: "location 要係 2–8 字場所名詞（地下室、宿舍、走廊），唔係機構全名",
        path: ["location"],
      })
      .refine((req) => !negativePoison(req.negatives ?? []), {
        message: "negatives 唔可以有霓虹/neon/night — 負面詞毒畫面（T29 法）",
        path: ["negatives"],
      }),
  ),
});

const boardsSceneShape = z.object({
  sceneId: z.string().regex(SCENE_ID_RE),
  thinking: z.string().min(1).max(400),
  shots: z.array(boardShotShape).min(1).max(30),
});

export type BoardShot = z.infer<typeof boardShotShape>;
export type BoardsScene = z.infer<typeof boardsSceneShape>;

export function boardsSceneSchema(ctx: {
  sceneId: string;
  beats: Beat[];
  characters: { id: string; name: string }[];
  budgetSec: number;
}) {
  const byBeat = new Map(ctx.beats.map((b) => [b.id, b]));
  const cast = new Set(ctx.characters.map((c) => c.id));
  const idByName = new Map(ctx.characters.map((c) => [c.name, c.id]));
  return boardsSceneShape.superRefine((scene, report) => {
    if (scene.sceneId !== ctx.sceneId) {
      report.addIssue({ code: "custom", path: ["sceneId"], message: `this envelope is scene ${ctx.sceneId}, not ${scene.sceneId}` });
    }
    const dialogueShotsPerBeat = new Map<string, number>();
    for (const [i, shot] of scene.shots.entries()) {
      const at = (...path: (string | number)[]) => ["shots", i, ...path];
      const beat = byBeat.get(shot.beatId);
      if (!beat) {
        report.addIssue({ code: "custom", path: at("beatId"), message: `beat ${shot.beatId} is not in scene ${ctx.sceneId}` });
        continue;
      }
      const beatLine = beat.dialogue?.trim() ?? "";
      const shotLine = shot.dialogue.trim();
      if (shotLine && shotLine !== beatLine) {
        report.addIssue({ code: "custom", path: at("dialogue"), message: `dialogue must be the beat's line verbatim: ${JSON.stringify(beatLine)}` });
      }
      if (shotLine && shot.speaker !== beat.speaker) {
        report.addIssue({ code: "custom", path: at("speaker"), message: `speaker must be the beat's speaker ${JSON.stringify(beat.speaker)}` });
      }
      if (shotLine) dialogueShotsPerBeat.set(shot.beatId, (dialogueShotsPerBeat.get(shot.beatId) ?? 0) + 1);
      const needed = dialogueSeconds(shotLine);
      if (shotLine && shot.durationSec + 1e-9 < needed) {
        report.addIssue({
          code: "custom",
          path: at("durationSec"),
          message: `${shotLine.length} chars need ≥ ${needed.toFixed(1)}s of screen time, not ${shot.durationSec}s`,
        });
      }
      const seats = new Set<string>();
      for (const [j, member] of shot.cast.entries()) {
        if (!cast.has(member.characterId)) {
          report.addIssue({ code: "custom", path: at("cast", j, "characterId"), message: `${member.characterId} is not a character of this script` });
        }
        const seatKey = `${member.slot}/${member.depth}`;
        if (seats.has(seatKey)) {
          report.addIssue({ code: "custom", path: at("cast", j, "slot"), message: `two figures cannot share slot ${seatKey} in one shot` });
        }
        seats.add(seatKey);
      }
      const ids = new Set(shot.cast.map((c) => c.characterId));
      if (ids.size !== shot.cast.length) {
        report.addIssue({ code: "custom", path: at("cast"), message: "the same character is cast twice in one shot" });
      }
      const speakerId = shot.speaker ? idByName.get(shot.speaker) : undefined;
      if (shotLine && speakerId && !ids.has(speakerId)) {
        report.addIssue({ code: "custom", path: at("cast"), message: `${shot.speaker} speaks here, so ${speakerId} must be on screen` });
      }
      for (const [j, prop] of (shot.props ?? []).entries()) {
        if (prop.heldBy && !ids.has(prop.heldBy)) {
          report.addIssue({ code: "custom", path: at("props", j, "heldBy"), message: `${prop.heldBy} is not cast in this shot, so cannot hold ${prop.name}` });
        }
      }
    }
    const runtime = scene.shots.reduce((a, s) => a + s.durationSec, 0);
    const lo = ctx.budgetSec * (1 - SCENE_BUDGET_TOLERANCE);
    const hi = ctx.budgetSec * (1 + SCENE_BUDGET_TOLERANCE);
    if (runtime < lo || runtime > hi) {
      report.addIssue({
        code: "custom",
        path: ["shots"],
        message: `this scene must run ${lo.toFixed(1)}–${hi.toFixed(1)}s (budget ${ctx.budgetSec.toFixed(1)}s); your shots add up to ${runtime.toFixed(1)}s`,
      });
    }
    for (const beat of ctx.beats) {
      if (!scene.shots.some((s) => s.beatId === beat.id)) {
        report.addIssue({ code: "custom", path: ["shots"], message: `beat ${beat.id} has no shot covering it` });
      }
      const line = beat.dialogue?.trim() ?? "";
      const count = dialogueShotsPerBeat.get(beat.id) ?? 0;
      if (line && count !== 1) {
        report.addIssue({ code: "custom", path: ["shots"], message: `beat ${beat.id}'s line must be spoken in exactly one shot, found ${count}` });
      }
    }
  });
}
