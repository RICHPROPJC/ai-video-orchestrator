import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { assertSheetGates, expandBoards } from "./boards-expand";
import type { CallSheet } from "./types";
import { boardsSceneSchema, type BoardsScene } from "./boards-contract";
import {
  assertBeatTotal,
  dialogueSeconds,
  outlineSchema,
  sceneBeatsSchema,
  type Outline,
  type Script,
} from "./script-contract";
import { loadCallSheet } from "./writer";

const ROSTER = ["Cast-A", "Cast-B"];
const SHOT_SEC = 6;

function sceneId(i: number) {
  return `SC${String(i + 1).padStart(2, "0")}`;
}

function outlineOf(sceneCount: number, targetSec: number): Outline {
  return {
    thinking: "三場，兩個角色，一條線。",
    title: "fixture",
    logline: "a fixture script for the expansion gates",
    mood: "plain",
    language: "zh-Hant",
    world: {
      location: "an interior",
      timeOfDay: "night",
      weather: "clear",
      grade: "low key, cool shadows",
      refs: ["reference-one"],
    },
    characters: [
      { id: "A", name: "Cast-A", role: "role-one", wardrobe: "dark coat", palette: ["#111111", "#222222", "#333333"], voice: { pitchHz: 190, gender: "f" }, heightM: 1.05, speaks: true },
      { id: "B", name: "Cast-B", role: "role-two", wardrobe: "light shirt", palette: ["#444444", "#555555", "#666666"], voice: { pitchHz: 120, gender: "m" }, heightM: 0.92, speaks: true },
    ],
    scenes: Array.from({ length: sceneCount }, (_, i) => ({
      id: sceneId(i),
      heading: `INT. SPACE ${i + 1}`,
      location: "an interior",
      timeOfDay: "night" as const,
      weather: "clear" as const,
      summary: `scene ${i + 1} of the fixture`,
      targetSec: targetSec / sceneCount,
    })),
    targetSec,
  };
}

function scriptOf(sceneCount: number, beatsPerScene: number, targetSec: number): Script {
  const outline = outlineOf(sceneCount, targetSec);
  const scenes = outline.scenes.map((scene, s) => ({
    sceneId: scene.id,
    thinking: "拆四拍。",
    beats: Array.from({ length: beatsPerScene }, (_, b) => {
      const spoken = b % 2 === 0;
      return {
        id: `${scene.id}.B${String(b + 1).padStart(2, "0")}`,
        action: `beat ${s + 1}-${b + 1} action`,
        ...(spoken ? { dialogue: `line ${s + 1}-${b + 1}`, speaker: b % 4 === 0 ? "Cast-A" : "Cast-B" } : {}),
      };
    }),
  }));
  return { outline, scenes };
}

function boardsOf(script: Script): BoardsScene[] {
  return script.scenes.map((scene, s) => ({
    sceneId: scene.sceneId,
    thinking: "一拍一鏡。",
    shots: scene.beats.map((beat, b) => ({
      beatId: beat.id,
      size: (["wide", "full", "medium", "closeup"] as const)[(s + b) % 4]!,
      angle: (["eye", "high", "low"] as const)[b % 3]!,
      side: (["frontal", "leftQuarter", "rightQuarter"] as const)[s % 3]!,
      durationSec: SHOT_SEC,
      action: beat.action,
      dialogue: beat.dialogue ?? "",
      ...(beat.speaker ? { speaker: beat.speaker } : {}),
      cast: [
        { characterId: "A", slot: "L" as const, depth: "mid" as const, facing: 1 as const, gait: "plant" as const, stance: "stand" as const },
        { characterId: "B", slot: "R" as const, depth: "near" as const, facing: -1 as const, gait: "plant" as const, stance: "crouch" as const },
      ],
    })),
  }));
}

const SCENES = 3;
const BEATS = 4;
const TARGET = SCENES * BEATS * SHOT_SEC;

function fixture() {
  const script = scriptOf(SCENES, BEATS, TARGET);
  return { script, boards: boardsOf(script) };
}

test("SH ids run in cut order across every scene, two digits, never restarting", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  assert.equal(sheet.shots.length, SCENES * BEATS);
  assert.deepEqual(
    sheet.shots.map((s) => s.id).slice(0, 4),
    ["SH01", "SH02", "SH03", "SH04"],
  );
  assert.equal(sheet.shots.at(-1)!.id, "SH12");
  assert.deepEqual(sheet.shots.map((s) => s.index), Array.from({ length: 12 }, (_, i) => i + 1));
  assert.deepEqual(sheet.shots.slice(0, 4).map((s) => s.scene), ["SC01", "SC01", "SC01", "SC01"]);
  assert.equal(sheet.shots[4]!.scene, "SC02");
  for (const shot of sheet.shots) assert.match(shot.id, /^SH\d{2,}$/);
});

test("expansion turns grammar into geometry: camera from the preset, marks from the grid", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  const shot = sheet.shots[0]!;
  assert.equal(shot.size, "wide");
  assert.equal(shot.camera.lensMm, 24);
  assert.equal(shot.camera.pos.y, -9);
  assert.ok(shot.camera.lookAt.z < shot.camera.pos.z);
  assert.equal(shot.marks.length, 2);
  assert.equal(shot.marks[1]!.stance, "crouch");
  assert.equal(shot.heading, "WIDE / INT. SPACE 1");
  assert.equal(shot.beatId, "SC01.B01");
});

test("a shot is never shorter than its line, and the sheet clock is the sum", () => {
  const { script, boards } = fixture();
  boards[0]!.shots[0]!.dialogue = "a".repeat(60);
  script.scenes[0]!.beats[0]!.dialogue = "a".repeat(60);
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  assert.equal(sheet.shots[0]!.durationSec, dialogueSeconds("a".repeat(60)));
  assert.ok(sheet.shots[0]!.durationSec > SHOT_SEC);
  const sum = sheet.shots.reduce((a, s) => a + s.durationSec, 0);
  assert.ok(Math.abs(sheet.durationSec - sum) < 0.01);
});

test("voiceover is the spoken lines in cut order", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  assert.equal(sheet.voiceover, sheet.shots.map((s) => s.dialogue).filter(Boolean).join(" "));
  assert.ok(sheet.voiceover.startsWith("line 1-1"));
});

test("the expanded sheet round-trips through loadCallSheet's own gates", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "boards-expand-"));
  const file = path.join(dir, "callsheet.json");
  fs.writeFileSync(file, JSON.stringify(sheet, null, 2));
  const reread = loadCallSheet(file);
  assert.equal(reread.shots.length, sheet.shots.length);
  assert.deepEqual(reread.shots.map((s) => s.id), sheet.shots.map((s) => s.id));
  assert.equal(reread.characters[0]!.heightM, 1.05);
});

test("the duration gate refuses a sheet that misses the slate's clock", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  assert.doesNotThrow(() => assertSheetGates(sheet, { script, targetSec: TARGET }));
  assert.throws(() => assertSheetGates(sheet, { script, targetSec: TARGET * 2 }), /callsheet runs/);
});

test("the beat-coverage gate refuses a sheet that drops a beat", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  const short: CallSheet = { ...sheet, shots: sheet.shots.filter((s) => s.beatId !== "SC02.B03") };
  assert.throws(() => assertSheetGates(short, { script, targetSec: TARGET }), /SC02\.B03 has no shot/);
});

test("a line spoken twice is refused by the sheet gate", () => {
  const { script, boards } = fixture();
  const sheet = expandBoards({ script, boards, targetSec: TARGET });
  const doubled: CallSheet = { ...sheet, shots: [...sheet.shots, { ...sheet.shots[0]!, id: "SH13", index: 13 }] };
  assert.throws(() => assertSheetGates(doubled, { script, targetSec: TARGET }), /spoken in 2 shots|cut order wants/);
});

test("boards for a missing scene throw instead of quietly shortening the film", () => {
  const { script, boards } = fixture();
  assert.throws(() => expandBoards({ script, boards: boards.slice(0, 2), targetSec: TARGET }), /boards missing for SC03/);
});

test("the outline schema holds the roster, the scene clock and the scene count", () => {
  const schema = outlineSchema({ targetSec: TARGET, castRoster: ROSTER, ranges: { scenes: [3, 3], totalBeats: [12, 12] } });
  const good = outlineOf(SCENES, TARGET);
  assert.equal(schema.safeParse(good).success, true);

  const offRoster = structuredClone(good);
  offRoster.characters[0]!.name = "Not-On-Roster";
  const r1 = schema.safeParse(offRoster);
  assert.equal(r1.success, false);
  assert.match(JSON.stringify(r1.error!.issues), /not in the roster/);

  const offClock = structuredClone(good);
  offClock.scenes[0]!.targetSec = 120;
  assert.match(JSON.stringify(schema.safeParse(offClock).error!.issues), /sums to 168\.0s/);

  const tooManyScenes = outlineOf(5, TARGET);
  assert.match(JSON.stringify(schema.safeParse(tooManyScenes).error!.issues), /wants 3–3 scenes/);
});

test("the beats schema binds speakers to speaking cast and ids to their scene", () => {
  const schema = sceneBeatsSchema({ sceneId: "SC01", speakingNames: ROSTER, targetSec: TARGET / SCENES });
  const script = scriptOf(SCENES, BEATS, TARGET);
  assert.equal(schema.safeParse(script.scenes[0]).success, true);

  const strayScene = structuredClone(script.scenes[0]!);
  strayScene.beats[0]!.id = "SC09.B01";
  assert.match(JSON.stringify(schema.safeParse(strayScene).error!.issues), /must start with SC01\.B/);

  const strangerSpeaks = structuredClone(script.scenes[0]!);
  strangerSpeaks.beats[0]!.speaker = "Nobody";
  assert.match(JSON.stringify(schema.safeParse(strangerSpeaks).error!.issues), /not a speaking character/);

  const mute = structuredClone(script.scenes[0]!);
  delete mute.beats[0]!.dialogue;
  assert.match(JSON.stringify(schema.safeParse(mute).error!.issues), /drop the speaker or write the line/);
});

test("the boards schema covers every beat, quotes the line verbatim and seats the speaker", () => {
  const script = scriptOf(SCENES, BEATS, TARGET);
  const boards = boardsOf(script);
  const schema = boardsSceneSchema({
    sceneId: "SC01",
    beats: script.scenes[0]!.beats,
    characters: script.outline.characters.map((c) => ({ id: c.id, name: c.name })),
    budgetSec: BEATS * SHOT_SEC,
  });
  assert.equal(schema.safeParse(boards[0]).success, true);

  const dropped = structuredClone(boards[0]!);
  dropped.shots = dropped.shots.slice(0, 2);
  assert.match(JSON.stringify(schema.safeParse(dropped).error!.issues), /has no shot covering it/);

  const paraphrased = structuredClone(boards[0]!);
  paraphrased.shots[0]!.dialogue = "a line the writer never wrote";
  assert.match(JSON.stringify(schema.safeParse(paraphrased).error!.issues), /verbatim/);

  const offScreen = structuredClone(boards[0]!);
  offScreen.shots[0]!.cast = [offScreen.shots[0]!.cast[1]!];
  assert.match(JSON.stringify(schema.safeParse(offScreen).error!.issues), /must be on screen/);

  const rushed = structuredClone(boards[0]!);
  rushed.shots[0]!.dialogue = "x".repeat(60);
  script.scenes[0]!.beats[0]!.dialogue = "x".repeat(60);
  const tight = boardsSceneSchema({
    sceneId: "SC01",
    beats: script.scenes[0]!.beats,
    characters: script.outline.characters.map((c) => ({ id: c.id, name: c.name })),
    budgetSec: BEATS * SHOT_SEC,
  });
  assert.match(JSON.stringify(tight.safeParse(rushed).error!.issues), /need ≥ 14\.4s/);
});

test("a prop can only be held by someone in the shot", () => {
  const script = scriptOf(SCENES, BEATS, TARGET);
  const boards = boardsOf(script);
  const schema = boardsSceneSchema({
    sceneId: "SC01",
    beats: script.scenes[0]!.beats,
    characters: script.outline.characters.map((c) => ({ id: c.id, name: c.name })),
    budgetSec: BEATS * SHOT_SEC,
  });
  const held = structuredClone(boards[0]!);
  held.shots[0]!.props = [{ name: "prop-one", heldBy: "C", shape: ["long"], forbid: [] }];
  assert.match(JSON.stringify(schema.safeParse(held).error!.issues), /not cast in this shot/);
});

test("hologram/infograph props cannot forbid screen or 螢幕（§0c law46 boards 端豁免）", () => {
  const script = scriptOf(SCENES, BEATS, TARGET);
  const boards = boardsOf(script);
  const schema = boardsSceneSchema({
    sceneId: "SC01",
    beats: script.scenes[0]!.beats,
    characters: script.outline.characters.map((c) => ({ id: c.id, name: c.name })),
    budgetSec: BEATS * SHOT_SEC,
  });
  // WR1Q SH02 形：光框本身係螢幕——screen 入 forbid＝禁詞殺自己人
  const poison = structuredClone(boards[0]!);
  poison.shots[0]!.props = [{ name: "全息光框", heldBy: "A", shape: ["glow"], forbid: ["phone", "screen", "book"] }];
  assert.match(JSON.stringify(schema.safeParse(poison).error!.issues), /screen／螢幕/);
  const han = structuredClone(boards[0]!);
  han.shots[0]!.props = [{ name: "infograph", heldBy: "A", shape: ["chart"], forbid: ["螢幕"] }];
  assert.equal(schema.safeParse(han).success, false);
  // 剷走 screen 族就過；非 screen 禁詞（phone／book）照寫得
  const ok = structuredClone(boards[0]!);
  ok.shots[0]!.props = [{ name: "全息光框", heldBy: "A", shape: ["glow"], forbid: ["phone", "book"] }];
  assert.equal(schema.safeParse(ok).success, true);
  // 非 system 道具禁 screen 照舊合法——角色亂生螢幕先係犯規
  const spear = structuredClone(boards[0]!);
  spear.shots[0]!.props = [{ name: "長槍", heldBy: "A", shape: ["long"], forbid: ["screen"] }];
  assert.equal(schema.safeParse(spear).success, true, "non-display tool may forbid screen");
});

test("the beat total is gated once every scene is back", () => {
  const script = scriptOf(SCENES, BEATS, TARGET);
  assert.doesNotThrow(() => assertBeatTotal(script, { scenes: [3, 3], totalBeats: [12, 12] }));
  assert.throws(() => assertBeatTotal(script, { scenes: [3, 3], totalBeats: [60, 110] }), /has 12 beats/);
  const missing: Script = { ...script, scenes: script.scenes.slice(0, 2) };
  assert.throws(() => assertBeatTotal(missing, { scenes: [3, 3], totalBeats: [8, 8] }), /missing beats for SC03/);
});
