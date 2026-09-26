import test from "node:test";
import assert from "node:assert/strict";
import { boardsSceneSchema } from "./boards-contract";
import { expandBoards } from "./boards-expand";
import type { Script } from "./script-contract";
import type { BoardsScene } from "./boards-contract";

/** Card D 掣1: require.facts {claim, source, fetched_at}[] is packet-authored
 *  (same register as front-lane require.negatives) — zod gates the shape on
 *  the BoardShot chain and expandBoards threads it verbatim into Shot; code
 *  assembles, never authors. */

const script: Script = {
  outline: {
    thinking: "一場一鏡。",
    title: "facts-schema-fixture",
    logline: "one screen shot",
    mood: "plain",
    language: "zh-Hant",
    world: { location: "office", timeOfDay: "day", weather: "clear", grade: "flat", refs: [] },
    characters: [
      { id: "A", name: "Cast-A", role: "role", wardrobe: "shirt", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" }, heightM: 1.7, speaks: false },
    ],
    scenes: [{ id: "SC01", heading: "INT. OFFICE", location: "office", timeOfDay: "day", weather: "clear", summary: "one shot", targetSec: 6 }],
    targetSec: 6,
  },
  scenes: [{ sceneId: "SC01", thinking: "一拍", beats: [{ id: "SC01.B01", action: "睇螢幕" }] }],
};

const baseShot = {
  beatId: "SC01.B01",
  size: "medium" as const,
  angle: "eye" as const,
  side: "frontal" as const,
  durationSec: 6,
  action: "螢幕顯示樓價指數圖表",
  dialogue: "",
  cast: [{ characterId: "A", slot: "L" as const, depth: "mid" as const, facing: 1 as const, gait: "plant" as const, stance: "stand" as const }],
};

const FACTS = [
  { claim: "2026年6月私人住宅售價指數報323.2點", source: "https://example.hk/rvd", fetched_at: "2026-09-19" },
  { claim: "指數連升13個月", source: "https://example.hk/rvd", fetched_at: "2026-09-19" },
];

function sceneWith(shotExtra: Record<string, unknown>): BoardsScene {
  return {
    sceneId: "SC01",
    thinking: "一拍一鏡",
    shots: [{ ...baseShot, ...shotExtra }],
  } as unknown as BoardsScene;
}

const ctx = { sceneId: "SC01", beats: script.scenes[0]!.beats, characters: [{ id: "A", name: "Cast-A" }], budgetSec: 6 };

test("require.facts rows pass zod and thread verbatim into the expanded Shot", () => {
  const parsed = boardsSceneSchema(ctx).parse(sceneWith({ require: { facts: FACTS, factsRequired: true } }));
  assert.equal(parsed.shots[0]!.require?.facts?.length, 2);
  const sheet = expandBoards({ script, boards: [parsed], targetSec: 6 });
  const shot = sheet.shots[0]!;
  assert.deepEqual(shot.require?.facts, FACTS, "code copies packet facts through, never authors");
  assert.equal(shot.require?.factsRequired, true);
});

test("fetched_at must be YYYY-MM-DD — a sloppier date fails the packet", () => {
  const bad = [...FACTS];
  bad[0] = { ...bad[0]!, fetched_at: "19/09/2026" };
  const res = boardsSceneSchema(ctx).safeParse(sceneWith({ require: { facts: bad } }));
  assert.equal(res.success, false);
  assert.ok(JSON.stringify(res.error?.issues).includes("fetched_at"));
});

test("empty source row is rejected — a fact without provenance is not a fact", () => {
  const bad = [{ claim: "323.2點", source: "", fetched_at: "2026-09-19" }];
  const res = boardsSceneSchema(ctx).safeParse(sceneWith({ require: { facts: bad } }));
  assert.equal(res.success, false);
});

test("require stays omittable — a normal shot without facts is still a legal packet", () => {
  const parsed = boardsSceneSchema(ctx).parse(sceneWith({}));
  assert.equal(parsed.shots[0]!.require, undefined);
  const sheet = expandBoards({ script, boards: [parsed], targetSec: 6 });
  assert.equal(sheet.shots[0]!.require, undefined);
});
