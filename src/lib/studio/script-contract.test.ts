import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import {
  EPISODE_RANGES,
  FEATURE_RANGES,
  maxBeatsIn,
  ACTION_MAX_CHARS,
  assertBeatTotal,
  hasVisibleActionVerb,
  outlineSchema,
  rangesFor,
  sceneBeatsSchema,
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


test("a one-person 12s outline locks at 12s, not a 15s floor", () => {
  const one = {
    ...outlineWith(1, 12, 12),
    characters: [CHARS[0]!],
  };
  const parsed = outlineSchema({ targetSec: 12, castRoster: [], ranges: rangesFor(12) }).safeParse(one);
  assert.equal(parsed.success, true, JSON.stringify(parsed.success ? null : parsed.error!.issues));
  const lifted = outlineSchema({ targetSec: 12, castRoster: [], ranges: rangesFor(12) }).safeParse({
    ...outlineWith(1, 12, 15),
    characters: [CHARS[0]!],
  });
  assert.equal(lifted.success, false);
});

test("short slates are not forced to one scene; episode and feature bands stay", () => {
  assert.deepEqual(rangesFor(16).scenes, [1, 8]);
  assert.deepEqual(rangesFor(30).scenes, [1, 8]);
  assert.equal(rangesFor(31), EPISODE_RANGES);
  assert.equal(rangesFor(154), EPISODE_RANGES);
  assert.equal(rangesFor(360), EPISODE_RANGES);
  assert.equal(rangesFor(361), FEATURE_RANGES);
});

test("beat ceiling follows the grid floor, not a 5s copy", () => {
  assert.equal(maxBeatsIn(16), 6);
  assert.equal(maxBeatsIn(30), 12);
  assert.equal(maxBeatsIn(24), 10);
  const schema = sceneBeatsSchema({ sceneId: "SC01", speakingNames: [], targetSec: 16 });
  const beatsOf = (n: number) => ({
    sceneId: "SC01",
    thinking: "一句。",
    beats: Array.from({ length: n }, (_, b) => ({
      id: `SC01.B${String(b + 1).padStart(2, "0")}`,
      action: "行一步講一句",
    })),
  });
  assert.equal(schema.safeParse(beatsOf(3)).success, true, JSON.stringify(schema.safeParse(beatsOf(3)).success ? null : schema.safeParse(beatsOf(3)).error!.issues));
  assert.equal(schema.safeParse(beatsOf(1)).success, true);
  assert.equal(schema.safeParse(beatsOf(7)).success, false, "16s holds at most 6 beats on the grid floor");
});

test("a 16s outline may be one scene or two; it is not locked to exactly one", () => {
  const ok = outlineSchema({ targetSec: 16, castRoster: [], ranges: rangesFor(16) }).safeParse(outlineWith(1, 16));
  assert.equal(ok.success, true, JSON.stringify(ok.success ? null : ok.error!.issues));
  const two = outlineSchema({ targetSec: 16, castRoster: [], ranges: rangesFor(16) }).safeParse(outlineWith(2, 16, 8));
  assert.equal(two.success, true, JSON.stringify(two.success ? null : two.error!.issues));

  const outline = outlineWith(1, 16);
  const scenes = (n: number) => [
    {
      sceneId: "SC01",
      thinking: "廣告三拍。",
      beats: Array.from({ length: n }, (_, b) => ({
        id: `SC01.B${String(b + 1).padStart(2, "0")}`,
        action: "行一步講一句",
      })),
    },
  ];
  assert.doesNotThrow(() => assertBeatTotal({ outline, scenes: scenes(3) }, rangesFor(16)));
  assert.throws(() => assertBeatTotal({ outline, scenes: scenes(41) }, rangesFor(16)), /41 beats/);
});

test("T38: a long literary action is rejected — a beat is one short filmable move", () => {
  assert.equal(ACTION_MAX_CHARS, 48);
  // SH01-style literary sentence, >48 chars: zod must reject on length alone
  const literary =
    "沉默喺兩個人之間脹大，窗外冷光斜斜切過檯面嗰杯涼透嘅茶，茶漡邊緣凝住一圈陰影，所有講唔出口嘅說話都壓喺呢一秒之間，時間好似停咗。";
  assert.ok(literary.length > ACTION_MAX_CHARS, `fixture must exceed the cap (${literary.length})`);
  const schema = sceneBeatsSchema({ sceneId: "SC01", speakingNames: [], targetSec: 60 });
  const beatsOf = (action: string) => ({
    sceneId: "SC01",
    thinking: "一句。",
    beats: [0, 1, 2, 3].map((b) => ({
      id: `SC01.B${String(b + 1).padStart(2, "0")}`,
      action: b === 0 ? action : "行一步講一句",
    })),
  });
  const bad = schema.safeParse(beatsOf(literary));
  assert.equal(bad.success, false, "the long literary action must fail zod");
  assert.ok(
    !bad.success && bad.error.issues.some((i) => i.path.join(".").startsWith("beats.0.action")),
    JSON.stringify(bad.success ? [] : bad.error.issues.map((i) => [i.path, i.message])),
  );
});

test("T38: 押跪水泥地，提筆畫勾 passes; a verbless action fails", () => {
  const schema = sceneBeatsSchema({ sceneId: "SC01", speakingNames: [], targetSec: 60 });
  const beatsOf = (action: string) => ({
    sceneId: "SC01",
    thinking: "一句。",
    beats: [0, 1, 2, 3].map((b) => ({
      id: `SC01.B${String(b + 1).padStart(2, "0")}`,
      action: b === 0 ? action : "行一步講一句",
    })),
  });
  assert.equal(hasVisibleActionVerb("押跪水泥地，提筆畫勾"), true);
  assert.equal(schema.safeParse(beatsOf("押跪水泥地，提筆畫勾")).success, true);
  // short but pure description — no verb a camera can see
  assert.equal(hasVisibleActionVerb("寂靜而漫長的張力"), false);
  const verbless = schema.safeParse(beatsOf("寂靜而漫長的張力"));
  assert.equal(verbless.success, false, "a verbless action must fail the refine");
  assert.ok(
    !verbless.success && verbless.error.issues.some((i) => i.message.includes("鏡頭見得到嘅動詞")),
    JSON.stringify(verbless.success ? [] : verbless.error.issues.map((i) => i.message)),
  );
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
