import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { outlineSchema } from "./script-contract";
import { coerceOutline } from "./seat-writer";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

test("coerceOutline maps prose enums and clamps oversize scene clocks", () => {
  const raw = {
    thinking: "拆五場。",
    title: "鐵腕",
    logline: "重生者坐上權力。",
    mood: "冷",
    language: "zh",
    world: {
      location: "華京",
      timeOfDay: "夜→晨→日",
      weather: "陰雨轉晴",
      grade: "冷藍",
      refs: ["紙牌屋"],
    },
    characters: [
      {
        id: "A", name: "陳默", role: "領袖", wardrobe: "中山裝",
        palette: ["#111111", "#222222", "#333333"],
        voice: { pitchHz: 110, gender: "m" }, heightM: 1, speaks: true,
      },
      {
        id: "B", name: "系統", role: "音", wardrobe: "光",
        palette: ["#111111", "#222222", "#333333"],
        voice: { pitchHz: 200, gender: "n" }, heightM: 0.9, speaks: true,
      },
    ],
    scenes: [
      { id: "SC01", heading: "一", location: "宅", timeOfDay: "深夜暴雨", weather: "暴雨", summary: "醒", targetSec: 140 },
      { id: "SC02", heading: "二", location: "府", timeOfDay: "清晨", weather: "陰", summary: "令", targetSec: 140 },
    ],
    targetSec: 600,
  };
  const notes: string[] = [];
  const out = coerceOutline(raw, 600, (line) => notes.push(line)) as {
    language: string;
    world: { timeOfDay: string; weather: string };
    scenes: { timeOfDay: string; weather: string; targetSec: number }[];
  };
  assert.equal(out.language, "zh-Hant");
  assert.equal(out.world.timeOfDay, "night");
  assert.equal(out.world.weather, "rain");
  assert.equal(out.scenes[0]!.timeOfDay, "night");
  assert.equal(out.scenes[0]!.weather, "rain");
  assert.equal(out.scenes[1]!.timeOfDay, "dawn");
  assert.ok(out.scenes.every((s) => s.targetSec >= 24 && s.targetSec <= 120));
  // no silent repair: every coercion is on the record, field + saw + became
  assert.ok(notes.length > 0);
  assert.ok(notes.every((l) => l.startsWith("repair: ")), notes.join(" | "));
  assert.ok(notes.some((l) => l === 'repair: language saw "zh" became "zh-Hant"'), notes.join(" | "));
  assert.ok(notes.some((l) => l.startsWith("repair: scenes[0].targetSec saw 140 became 120")), notes.join(" | "));
  assert.ok(notes.some((l) => l.startsWith("repair: world.timeOfDay saw ")), notes.join(" | "));
});

test("coerceOutline lets the L6WJ attempt-2 enums pass zod except scene count", () => {
  const raw = coerceOutline({
    thinking: "Brief。",
    title: "重生之鐵腕領袖",
    logline: "重生歸來的男人綁定國運系統。",
    mood: "冷峻權謀",
    language: "zh",
    world: {
      location: "華京首府圈",
      timeOfDay: "夜→晨→日",
      weather: "陰雨轉晴",
      grade: "冷藍灰調",
      refs: ["鋼鐵雨"],
    },
    characters: [
      {
        id: "A", name: "陳默", role: "領袖", wardrobe: "中山裝",
        palette: ["#1a1d23", "#8b0000", "#c0c0c0"],
        voice: { pitchHz: 110, gender: "m" }, heightM: 1, speaks: true,
      },
      {
        id: "B", name: "國運", role: "系統", wardrobe: "光",
        palette: ["#00d4ff", "#003366", "#ffffff"],
        voice: { pitchHz: 200, gender: "n" }, heightM: 0.9, speaks: true,
      },
    ],
    scenes: [
      { id: "SC01", heading: "醒", location: "宅", timeOfDay: "夜", weather: "雨", summary: "重生", targetSec: 120 },
      { id: "SC02", heading: "令", location: "府", timeOfDay: "晨", weather: "晴", summary: "任務", targetSec: 120 },
      { id: "SC03", heading: "談", location: "廳", timeOfDay: "夜", weather: "雨", summary: "攻心", targetSec: 140 },
      { id: "SC04", heading: "軍", location: "營", timeOfDay: "日", weather: "晴", summary: "展示", targetSec: 140 },
      { id: "SC05", heading: "權", location: "殿", timeOfDay: "昏", weather: "晴", summary: "坐穩", targetSec: 80 },
    ],
    targetSec: 600,
  }, 600);
  const parsed = outlineSchema({ targetSec: 600, castRoster: [] }).safeParse(raw);
  // the desk does not invent scenes: 5 stays 5, the band fail goes to the seat
  assert.equal((raw as { scenes: unknown[] }).scenes.length, 5);
  assert.equal(parsed.success, false);
  assert.match(parsed.error!.issues.map((i) => i.message).join(" "), /6–14 scenes, got 5/);
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
