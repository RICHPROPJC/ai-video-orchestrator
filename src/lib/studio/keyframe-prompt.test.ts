import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { isIndoorLocation, keyframeEditPrompt, keyframeRequire, propNounClass } from "./keyframe-prompt";
import { loadTraceFixture } from "./trace";
import type { CallSheet, Character, Shot, ShotProp } from "./types";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom.)
 *  Story nouns (frozen sheet proper names) live in trace-fixtures/, never
 *  here — the noun-lint fails on any of them in src code. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const baseSheet: CallSheet = {
  title: "t",
  logline: "l",
  language: "zh-Hant",
  location: "亂葬崗",
  timeOfDay: "dusk",
  weather: "wind",
  mood: "m",
  durationSec: 4,
  aspect: "16:9",
  characters: [
    { id: "A", name: "角色一", role: "保險調查員", wardrobe: "深藍乾濕褸", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
    { id: "B", name: "角色二", role: "舊同事", wardrobe: "白襯衫", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
  ],
  styleBible: { grade: "g", refs: [], stillModel: "u15", motionModel: "h3" },
  shots: [],
  voiceover: "",
} satisfies CallSheet;

function shotWithProp(prop?: ShotProp): Shot {
  return {
    id: "SH07",
    index: 6,
    heading: "7",
    size: "medium",
    location: "亂葬崗",
    action: "扯過件外套披上肩",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
      { characterId: "B", start: { x: 70, y: 50 }, end: { x: 70, y: 50 }, facing: 1, handL: { x: 66, y: 45 }, handR: { x: 74, y: 45 }, footL: { x: 68, y: 80 }, footR: { x: 72, y: 80 }, gait: "plant" },
    ],
    ...(prop ? { props: [prop] } : {}),
    stillPrompt: "",
    motionPrompt: "",
  } satisfies Shot;
}

const coat: ShotProp = { name: "軍大衣", heldBy: "A", shape: ["披", "肩"], forbid: ["木犁", "鐵犁鏵"] };
const decree: ShotProp = { name: "通緝令", heldBy: "A", shape: ["紙", "字"], forbid: ["木犁", "鋤頭"] };

test("garment prop: prompt names the coat as clothing, never a plow (SH07 class)", () => {
  const text = keyframeEditPrompt(baseSheet,shotWithProp(coat), { first: false });
  assert.ok(text.includes("軍大衣"), "prop name from sheet");
  assert.ok(text.includes("係一件衣物"), "card: garment-class sentence present");
  assert.ok(!text.includes("木犁"), "card: no 木犁");
  assert.ok(!text.includes("犁"), "no plow character at all — not even the forbid echo");
  assert.ok(/披上|着住/.test(text), "described as clothing on the body (披上／着住)");
});

test("garment prop: later-shot continuity carries the coat, not the 犁", () => {
  const text = keyframeEditPrompt(baseSheet,shotWithProp(coat), { first: false });
  assert.ok(text.includes("Image-2 係上一鏡嘅定格"), "continuity line present");
  assert.ok(text.includes("軍大衣、光線同色調"), "the garment is the carried prop");
  assert.ok(!text.includes("犁"), "no plow in the carry-over list");
});

test("garment prop: require keeps people_count + grey_blocks, no tool gate", () => {
  const req = keyframeRequire(shotWithProp(coat));
  assert.equal(req.people_count, 2);
  assert.equal(req.grey_blocks, false);
  assert.equal("tool" in req, false, "card: require has no tool");
  assert.equal("tool_shape" in req, false);
  assert.equal("tool_forbid" in req, false);
});

test("paper prop (SH09 class): flat document sentence — no 木犁 in prompt, require has no tool", () => {
  const text = keyframeEditPrompt(baseSheet,shotWithProp(decree), { first: false });
  assert.ok(text.includes("通緝令"), "prop name from sheet");
  assert.ok(text.includes("紙本文書"), "described as a flat paper document");
  assert.ok(!text.includes("木犁"), "card: paper-prop fixture ⇒ no 木犁 in prompt");
  assert.ok(!text.includes("犁"), "no plow character at all");
  assert.ok(!text.includes(decree.forbid.join("、")), "no forbid echo for documents either");
  assert.ok(text.includes("通緝令、光線同色調"), "the document is the carried prop");
  const req = keyframeRequire(shotWithProp(decree));
  assert.equal(req.people_count, 2);
  assert.equal("tool" in req, false, "card: require has no tool");
  assert.equal("tool_shape" in req, false);
  assert.equal("tool_forbid" in req, false);
});

test("tool prop (犁): plow sentence + tool gate unchanged", () => {
  const plow: ShotProp = { name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] };
  const text = keyframeEditPrompt(baseSheet,shotWithProp(plow), { first: false });
  assert.ok(text.includes("曲轅犁"), "prop name from sheet");
  assert.ok(text.includes("一件完整木犁"), "plow sentence kept for real tools");
  assert.ok(text.includes("唔係锹、铲、锄"), "forbid list from sheet");
  const req = keyframeRequire(shotWithProp(plow));
  assert.equal(req.tool, "曲轅犁");
  assert.deepEqual(req.tool_shape, ["弯", "木", "插入"]);
  assert.deepEqual(req.tool_forbid, ["锹", "铲", "锄"]);
});

test("tool prop (槍): not a garment or document, keeps the tool gate", () => {
  const spear: ShotProp = { name: "長槍", heldBy: "B", shape: ["长", "杆", "尖"], forbid: ["剑", "戟"] };
  const text = keyframeEditPrompt(baseSheet,shotWithProp(spear), { first: true });
  assert.ok(text.includes("長槍"), "prop name from sheet");
  assert.ok(text.includes("犁"), "one-tool gate vocabulary present");
  assert.equal(keyframeRequire(shotWithProp(spear)).tool, "長槍");
});

test("noun classes: garments and documents never take the held-tool gate; 犁/槍/鋤 do", () => {
  for (const name of ["軍大衣", "蓑衣", "斗篷 cloak", "leather jacket", "silk robe"]) {
    assert.equal(propNounClass(name), "garment", `${name} is a garment`);
    assert.equal("tool" in keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })), false);
  }
  for (const name of ["詔書", "通緝令", "書信", "地圖", "secret letter", "land deed"]) {
    assert.equal(propNounClass(name), "document", `${name} is a document`);
    assert.equal("tool" in keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })), false);
  }
  for (const name of ["曲轅犁", "長槍", "鋤頭"]) {
    assert.equal(propNounClass(name), "tool", `${name} is a held tool`);
    assert.equal(keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })).tool, name);
  }
});

/** T32 frozen LD0F excerpt (SH01–SH05, one indoor set, sheet tail night/neon).
 * Story nouns stay inside the fixture — the noun-lint holds that line. */
type LdFixture = {
  frozen: boolean;
  sheet: Pick<CallSheet, "location" | "timeOfDay" | "weather">;
  characters: Character[];
  shots: Shot[];
};

const POISON = ["neon", "霓虹", "night"] as const;

function ldSheet(): { fx: LdFixture; sheet: CallSheet } {
  const fx = loadTraceFixture("ld0f-sh01") as unknown as LdFixture;
  const sheet = {
    ...baseSheet,
    location: fx.sheet.location,
    timeOfDay: fx.sheet.timeOfDay,
    weather: fx.sheet.weather,
    characters: fx.characters,
    shots: fx.shots,
  } satisfies CallSheet;
  return { fx, sheet };
}

test("T32 A1: indoor shot scene line names the shot's own set — sheet neon tail never leaks", () => {
  const { fx, sheet } = ldSheet();
  const shot = fx.shots[0]!;
  const text = keyframeEditPrompt(sheet, shot, { first: true });
  assert.ok(text.includes(shot.location), "scene line names the shot's own location");
  assert.ok(text.includes("室內"), "indoor marker present");
  for (const poison of POISON) {
    assert.ok(!text.includes(poison), `no "${poison}" anywhere — sheet tail must not leak into an indoor prompt`);
  }
  assert.ok(!text.includes(fx.sheet.location), "the sheet-wide location is gone too");
});

test("T32 A2: same-set later shots SH02–SH05 drop the neon tail identically", () => {
  const { fx, sheet } = ldSheet();
  for (const shot of fx.shots.slice(1)) {
    const text = keyframeEditPrompt(sheet, shot, { first: false });
    assert.ok(text.includes(shot.location), `${shot.id} names its own location`);
    assert.ok(text.includes("室內"), `${shot.id} indoor marker`);
    for (const poison of POISON) {
      assert.ok(!text.includes(poison), `${shot.id} has no "${poison}"`);
    }
  }
});

test("T32: outdoor shot keeps the sheet tail (暫保留) — pre-T32 prompt unchanged", () => {
  const text = keyframeEditPrompt(baseSheet, shotWithProp(), { first: false });
  assert.ok(text.includes("亂葬崗，dusk，wind"), "sheet tail intact for an outdoor/unknown set");
  assert.equal(isIndoorLocation("亂葬崗"), false, "unknown location defaults outdoor, keeps today's behaviour");
});

test("T32 classifier: fixture sets are indoor; outdoor markers override indoor-looking chars", () => {
  const { fx } = ldSheet();
  for (const s of fx.shots) assert.equal(isIndoorLocation(s.location), true, `${s.id} location is a closed set`);
  assert.equal(isIndoorLocation(fx.sheet.location), false, "the sheet-wide open-country line is not indoor");
  assert.equal(isIndoorLocation("室外走廊"), false, "室外 outranks the 室 hit");
  assert.equal(isIndoorLocation("野外射擊場邊"), false, "野外 outranks any indoor char");
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
