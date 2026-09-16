import type { CallSheet, Character, Shot } from "./types";
import { BLOCKOUT_HEIGHT, BLOCKOUT_WIDTH } from "./blockout";
import { cameraFor } from "./camera-presets";
import { markFor, placeHands } from "./blocking-grid";
import { dialogueSeconds, type Script } from "./script-contract";
import type { BoardShot, BoardsScene } from "./boards-contract";

const STILL_MODEL = "SenseNova U1.5-8B-MoT";
const MOTION_MODEL = "MiniMax H3 R2V";
const DURATION_TOLERANCE = 0.1;
const FRAME = { width: BLOCKOUT_WIDTH, height: BLOCKOUT_HEIGHT };

function shotId(n: number): string {
  return `SH${String(n).padStart(2, "0")}`;
}

function marksFor(shot: BoardShot, heightById: Map<string, number>): Shot["marks"] {
  const camera = cameraFor(shot.size, shot.angle, shot.side);
  return shot.cast.map((member) => {
    const mark = markFor({
      characterId: member.characterId,
      slot: member.slot,
      depth: member.depth,
      facing: member.facing,
      gait: member.gait,
      stance: member.stance,
      stanceEnd: member.stanceEnd,
      travelTo: member.travelTo,
    });
    return placeHands(mark, camera, heightById.get(member.characterId) ?? 1, FRAME);
  });
}

/** Shot ids are the desk's, not the seat's: one run of SHxx in cut order across
 *  every scene, assigned once and never renegotiated. */
export function expandBoards(opts: {
  script: Script;
  boards: BoardsScene[];
  targetSec: number;
  aspect?: CallSheet["aspect"];
}): CallSheet {
  const { outline } = opts.script;
  const heightById = new Map(outline.characters.map((c) => [c.id, c.heightM]));
  const sceneById = new Map(outline.scenes.map((s) => [s.id, s]));
  const ordered = outline.scenes
    .map((s) => opts.boards.find((b) => b.sceneId === s.id))
    .filter((b): b is BoardsScene => Boolean(b));
  if (ordered.length !== outline.scenes.length) {
    const missing = outline.scenes.filter((s) => !opts.boards.some((b) => b.sceneId === s.id)).map((s) => s.id);
    throw new Error(`boards missing for ${missing.join(", ")}`);
  }

  const shots: Shot[] = [];
  for (const board of ordered) {
    const scene = sceneById.get(board.sceneId)!;
    for (const shot of board.shots) {
      const index = shots.length + 1;
      const camera = cameraFor(shot.size, shot.angle, shot.side);
      const line = shot.dialogue.trim();
      shots.push({
        id: shotId(index),
        index,
        heading: `${shot.size.toUpperCase()} / ${scene.heading}`,
        size: shot.size,
        location: scene.location,
        action: shot.action,
        dialogue: line,
        ...(line && shot.speaker ? { speaker: shot.speaker } : {}),
        durationSec: Math.max(shot.durationSec, dialogueSeconds(line)),
        camera,
        marks: marksFor(shot, heightById),
        ...(shot.props?.length ? { props: shot.props } : {}),
        ...(shot.require ? { require: { location: shot.require.location, angle: shot.require.angle ?? shot.angle } } : {}),
        stillPrompt: shot.action,
        motionPrompt: shot.action,
        scene: scene.id,
        beatId: shot.beatId,
      });
    }
  }

  const characters: Character[] = outline.characters.map((c) => ({
    id: c.id,
    name: c.name,
    role: c.role,
    wardrobe: c.wardrobe,
    palette: c.palette,
    voice: c.voice,
    heightM: c.heightM,
  }));

  return {
    title: outline.title,
    logline: outline.logline,
    language: outline.language,
    location: outline.world.location,
    timeOfDay: outline.world.timeOfDay,
    weather: outline.world.weather,
    mood: outline.mood,
    durationSec: Number(shots.reduce((a, s) => a + s.durationSec, 0).toFixed(2)),
    aspect: opts.aspect ?? "16:9",
    characters,
    styleBible: {
      grade: outline.world.grade,
      refs: outline.world.refs,
      stillModel: STILL_MODEL,
      motionModel: MOTION_MODEL,
    },
    shots,
    voiceover: shots.map((s) => s.dialogue).filter(Boolean).join(" "),
    scenes: outline.scenes.map((s) => ({ id: s.id, heading: s.heading, summary: s.summary, targetSec: s.targetSec })),
  };
}

/** Sheet-level gates the per-scene schema cannot see. Throwing here means the
 *  seats have to go again; it never edits the sheet into range. */
export function assertSheetGates(sheet: CallSheet, opts: { script: Script; targetSec: number }): void {
  const sum = sheet.shots.reduce((a, s) => a + s.durationSec, 0);
  const lo = opts.targetSec * (1 - DURATION_TOLERANCE);
  const hi = opts.targetSec * (1 + DURATION_TOLERANCE);
  if (sum < lo || sum > hi) {
    throw new Error(`callsheet runs ${sum.toFixed(1)}s; the slate wants ${opts.targetSec}s (allowed ${lo.toFixed(0)}–${hi.toFixed(0)}s)`);
  }
  const covered = new Set(sheet.shots.map((s) => s.beatId));
  for (const scene of opts.script.scenes) {
    for (const beat of scene.beats) {
      if (!covered.has(beat.id)) throw new Error(`beat ${beat.id} has no shot in the callsheet`);
      const line = beat.dialogue?.trim() ?? "";
      if (!line) continue;
      const spoken = sheet.shots.filter((s) => s.beatId === beat.id && s.dialogue.trim() === line);
      if (spoken.length !== 1) {
        throw new Error(`beat ${beat.id}'s line is spoken in ${spoken.length} shots, must be exactly 1`);
      }
    }
  }
  const ids = sheet.shots.map((s) => s.id);
  if (new Set(ids).size !== ids.length) throw new Error("duplicate shot ids in the callsheet");
  for (const [i, shot] of sheet.shots.entries()) {
    if (shot.id !== shotId(i + 1)) throw new Error(`shot ${i + 1} is ${shot.id}, cut order wants ${shotId(i + 1)}`);
  }
}
