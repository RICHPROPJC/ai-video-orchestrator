import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import {
  EPISODE_RANGES,
  FEATURE_RANGES,
  assertBeatTotal,
  outlineSchema,
  rangesFor,
  type ScriptRanges,
} from "./script-contract";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const CHARS = [
  {
    id: "A", name: "陳默", role: "領袖", wardrobe: "中山裝",
    palette: ["#111111", "#222222", "#333333"] as [string, string, string],
    voice: { pitchHz: 110, gender: "m" as const }, heightM: 1, speaks: true,
  },
  {
    id: "B", name: "國運", role: "系統", wardrobe: "光",
    palette: ["#111111", "#222222", "#333333"] as [string, string, string],
    voice: { pitchHz: 200, gender: "n" as const }, heightM: 0.9, speaks: true,
  },
];

/** N scenes splitting targetSec evenly — every other gate green by design so
 *  each test fails on exactly the one band it is about. */
function outlineWith(nScenes: number, targetSec: number, eachSec?: number) {
  const per = eachSec ?? targetSec / nScenes;
  return {
    thinking: "拆場。",
    title: "鐵腕",
    logline: "重生者坐上權力。",
    mood: "冷峻",
    language: "zh-Hant" as const,
    world: { location: "華京", timeOfDay: "night" as const, weather: "rain" as const, grade: "冷藍灰調", refs: ["紙牌屋"] },
    characters: CHARS,
    scenes: Array.from({ length: nScenes }, (_, i) => ({
      id: `SC${String(i + 1).padStart(2, "0")}`,
      heading: `場${i + 1}`,
      location: `地${i + 1}`,
      timeOfDay: "night" as const,
      weather: "rain" as const,
      summary: `事${i + 1}`,
      targetSec: per,
    })),
    targetSec,
  };
}

test("rangesFor: 300s episodes get 4–8 scenes / 28–60 beats, 600s feature band unchanged", () => {
  assert.deepEqual(rangesFor(300), { scenes: [4, 8], totalBeats: [28, 60] });
  assert.deepEqual(rangesFor(300), EPISODE_RANGES);
  assert.deepEqual(rangesFor(600), FEATURE_RANGES);
  assert.deepEqual(rangesFor(600), { scenes: [6, 14], totalBeats: [60, 110] });
  // the threshold is ≤360, not <600: anything at or under is an episode
  assert.deepEqual(rangesFor(360), EPISODE_RANGES);
  assert.deepEqual(rangesFor(361), FEATURE_RANGES);
});

test("outlineSchema at 300s rejects 3 and 9 scenes", () => {
  const three = outlineSchema({ targetSec: 300, castRoster: [], ranges: rangesFor(300) }).safeParse(outlineWith(3, 300));
  assert.equal(three.success, false);
  assert.match(three.error!.issues.map((i) => i.message).join(" "), /4–8 scenes, got 3/);

  const nine = outlineSchema({ targetSec: 300, castRoster: [], ranges: rangesFor(300) }).safeParse(outlineWith(9, 300));
  assert.equal(nine.success, false);
  assert.match(nine.error!.issues.map((i) => i.message).join(" "), /4–8 scenes, got 9/);
});

test("outlineSchema at 300s accepts 5 scenes summing to 300", () => {
  const five = outlineSchema({ targetSec: 300, castRoster: [], ranges: rangesFor(300) }).safeParse(outlineWith(5, 300));
  assert.equal(five.success, true, JSON.stringify(five.success ? null : five.error!.issues));
});

test("outlineSchema at 300s keeps the existing ±10% sum band (270–330)", () => {
  const under = outlineSchema({ targetSec: 300, castRoster: [], ranges: rangesFor(300) }).safeParse(outlineWith(5, 300, 50));
  assert.equal(under.success, false);
  assert.match(under.error!.issues.map((i) => i.message).join(" "), /sums to 250\.0s; the slate wants 300s \(allowed 270–330s\)/);

  const over = outlineSchema({ targetSec: 300, castRoster: [], ranges: rangesFor(300) }).safeParse(outlineWith(5, 300, 70));
  assert.equal(over.success, false);
  assert.match(over.error!.issues.map((i) => i.message).join(" "), /allowed 270–330s/);
});

test("assertBeatTotal at 300s wants 28–60 beats across the covered scenes", () => {
  const outline = outlineWith(5, 300);
  const beats = (perScene: number[]) => ({
    outline,
    scenes: outline.scenes.map((s, i) => ({
      sceneId: s.id,
      thinking: `場${i + 1}拍法。`,
      beats: Array.from({ length: perScene[i]! }, (_, b) => ({
        id: `${s.id}.B${String(b + 1).padStart(2, "0")}`,
        action: "行一步講一句",
      })),
    })),
  });
  assertBeatTotal(beats([6, 6, 6, 6, 6]), rangesFor(300)); // 30 in 28–60
  assert.throws(() => assertBeatTotal(beats([4, 4, 4, 4, 4]), rangesFor(300)), /20 beats; a 300s slate wants 28–60/);
  assert.throws(() => assertBeatTotal(beats([13, 13, 13, 13, 13]), rangesFor(300)), /65 beats; a 300s slate wants 28–60/);
});

if (bareBun) {
  // IIFE, not top-level await: tsx transpiles this file as CJS
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
