import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { keyframeEditPrompt, keyframeRequire } from "./keyframe-prompt";
import type { CallSheet, Shot, ShotProp } from "./types";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom.) */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const sheet: CallSheet = {
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
    { id: "A", name: "阿月", role: "保險調查員", wardrobe: "深藍乾濕褸", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
    { id: "B", name: "阿衡", role: "舊同事", wardrobe: "白襯衫", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
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
    action: "扯過死將軍嘅外套披上肩",
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

const coat: ShotProp = { name: "死將軍外套", heldBy: "A", shape: ["披", "肩"], forbid: ["木犁", "鐵犁鏵"] };

test("garment prop: prompt names the coat as clothing, never a plow (SH07)", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: false });
  assert.ok(text.includes("死將軍外套"), "prop name from sheet");
  assert.ok(text.includes("外套"), "card: contains 外套");
  assert.ok(!text.includes("木犁"), "card: no 木犁");
  assert.ok(!text.includes("犁"), "no plow character at all — not even the forbid echo");
  assert.ok(/披上|着住/.test(text), "described as clothing on the body (披上／着住)");
});

test("garment prop: later-shot continuity carries the coat, not the 犁", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: false });
  assert.ok(text.includes("Image-2 係上一鏡嘅定格"), "continuity line present");
  assert.ok(text.includes("死將軍外套、光線同色調"), "the garment is the carried prop");
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

test("tool prop (犁): plow sentence + tool gate unchanged", () => {
  const plow: ShotProp = { name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] };
  const text = keyframeEditPrompt(sheet, shotWithProp(plow), { first: false });
  assert.ok(text.includes("曲轅犁"), "prop name from sheet");
  assert.ok(text.includes("一件完整木犁"), "plow sentence kept for real tools");
  assert.ok(text.includes("唔係锹、铲、锄"), "forbid list from sheet");
  const req = keyframeRequire(shotWithProp(plow));
  assert.equal(req.tool, "曲轅犁");
  assert.deepEqual(req.tool_shape, ["弯", "木", "插入"]);
  assert.deepEqual(req.tool_forbid, ["锹", "铲", "锄"]);
});

test("tool prop (槍): not a garment, keeps the tool gate", () => {
  const spear: ShotProp = { name: "長槍", heldBy: "B", shape: ["长", "杆", "尖"], forbid: ["剑", "戟"] };
  const text = keyframeEditPrompt(sheet, shotWithProp(spear), { first: true });
  assert.ok(text.includes("長槍"), "prop name from sheet");
  assert.ok(text.includes("犁"), "one-tool gate vocabulary present");
  assert.equal(keyframeRequire(shotWithProp(spear)).tool, "長槍");
});

test("garment regex: 大衣/衣/coat/jacket/cloak/robe are wardrobe; 犁/槍/鋤 are tools", () => {
  for (const name of ["軍大衣", "蓑衣", "斗篷 cloak", "leather jacket", "silk robe"]) {
    const req = keyframeRequire(shotWithProp({ name, shape: [], forbid: [] }));
    assert.equal("tool" in req, false, `${name} is a garment`);
  }
  for (const name of ["曲轅犁", "長槍", "鋤頭"]) {
    const req = keyframeRequire(shotWithProp({ name, shape: [], forbid: [] }));
    assert.equal(req.tool, name, `${name} is a held tool`);
  }
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
