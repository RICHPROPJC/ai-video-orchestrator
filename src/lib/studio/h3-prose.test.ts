import test from "node:test";
import assert from "node:assert/strict";
import { SCRIPT_HEADER, VIDEO_SENTENCE, PIN_SENTENCE, buildProse, validateProse, wardrobeClauses } from "./h3-prose";
import type { CallSheet, Shot } from "./types";

const mark = (characterId: string, x = 20) => ({
  characterId,
  start: { x, y: 50 },
  end: { x: 22, y: 50 },
  facing: 0,
  handL: { x: x + 4, y: 40 },
  handR: { x: x + 6, y: 40 },
  footL: { x: x + 1, y: 92 },
  footR: { x: x + 3, y: 92 },
  gait: "plant" as const,
});

function sheet(): CallSheet {
  return {
    title: "門口個燈",
    logline: "雨夜重逢",
    language: "zh-Hant",
    location: "茶餐廳門口",
    timeOfDay: "night",
    weather: "rain",
    mood: "wet neon",
    durationSec: 10,
    aspect: "16:9",
    characters: [
      { id: "A", name: "阿月", role: "保險調查員", wardrobe: "深藍乾濕褸", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
      { id: "B", name: "阿衡", role: "舊同事", wardrobe: "白襯衫", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
    ],
    styleBible: { grade: "wet neon", refs: [], stillModel: "u15", motionModel: "h3" },
    shots: [],
    voiceover: "",
  };
}

function shot(dialogue: string, speaker?: string, withProp = false): Shot {
  return {
    id: "SH03",
    index: 2,
    heading: "3",
    size: "medium",
    location: "茶餐廳門口",
    action: "兩人企喺燈下相認",
    dialogue,
    speaker,
    durationSec: 5,
    camera: { pos: { x: 0, y: 1.6, z: 3 }, lookAt: { x: 0, y: 1.5, z: 0 }, lensMm: 35 },
    marks: [mark("A", 20), mark("B", 70)],
    ...(withProp ? { props: [{ name: "長傘", heldBy: "A", shape: ["長"], forbid: ["叉"] }] } : {}),
    stillPrompt: "",
    motionPrompt: "",
  };
}

const wrap = (body: string) => `${SCRIPT_HEADER}\n${body}`;

test("buildProse is exactly 4 paragraphs in the 40-sample shape", () => {
  const body = buildProse(sheet(), shot("你仲記得個門口個燈？", "阿月"));
  const paras = body.split("\n\n");
  assert.equal(paras.length, 4);
  assert.match(paras[0]!, /^Photoreal\. 茶餐廳門口, night\.$/);
  assert.ok(paras[1]!.includes("<Video 1>"), "motion paragraph");
  assert.ok(paras[2]!.includes("start keyframe image"), "pin paragraph");
  assert.match(paras[3]!, /^阿月 \(left\) speaks the line in Audio 1: "你仲記得個門口個燈\？"\. 阿衡 listens\.$/);
  validateProse(wrap(body), { requireQuote: true });
  assert.ok(body.includes(VIDEO_SENTENCE.replace("{{N}}", "2")));
  assert.ok(body.includes(PIN_SENTENCE.replace("{{PROP}}", "props")));
});

test("prop name lands in the pin sentence", () => {
  const body = buildProse(sheet(), shot("", undefined, true));
  assert.ok(body.includes("the 長傘 and the field"), "prop name in pin");
  assert.equal(body.split("\n\n").length, 3, "silent shot has no Audio 1 paragraph");
});

test("silent shot passes with requireQuote false", () => {
  const text = wrap(buildProse(sheet(), shot("")));
  validateProse(text, { requireQuote: false });
});

test("silent shot without requireQuote still demands structure", () => {
  const text = wrap(buildProse(sheet(), shot("")));
  assert.throws(() => validateProse(text), /spoken line missing/);
});

test("dialogue without an Audio 1 sentence throws", () => {
  const prose = buildProse(sheet(), shot("你仲記得個門口個燈？", "阿月"))
    .replace("speaks the line in Audio 1: ", "says ");
  assert.throws(() => validateProse(wrap(prose), { requireQuote: true }), /Audio 1/);
});

test("wardrobe leak throws", () => {
  const prose = buildProse(sheet(), shot("行啦", "阿月")) + "\n\n阿月着深藍乾濕褸。";
  assert.throws(
    () => validateProse(wrap(prose), { wardrobe: wardrobeClauses(sheet()) }),
    /wardrobe belongs to the pin/,
  );
});

test("section label is banned", () => {
  const text = wrap(`${buildProse(sheet(), shot("行啦"))}\n\nsubject_definitions: 兩人`);
  assert.throws(() => validateProse(text), /subject_definitions/);
});

test("Camera: label line is banned", () => {
  const text = wrap(`${buildProse(sheet(), shot("行啦"))}\n\nCamera: 35mm手持`);
  assert.throws(() => validateProse(text), /Camera/);
});

test("missing <Video 1> motion-only sentence throws", () => {
  const body = [
    "Photoreal. 茶餐廳門口, night.",
    `阿月 (left) speaks the line in Audio 1: "你仲記得個門口個燈？"`,
    PIN_SENTENCE.replace("{{PROP}}", "props"),
  ].join("\n\n");
  assert.throws(() => validateProse(wrap(body)), /no <Video 1> motion-only sentence/);
});

test("missing photoreal throws", () => {
  const prose = buildProse(sheet(), shot("行啦")).replace("Photoreal. ", "");
  assert.throws(() => validateProse(wrap(prose)), /Photoreal/);
});

test("dialogue present but unquoted throws", () => {
  const prose = buildProse(sheet(), shot("你仲記得個門口個燈？", "阿月"))
    .replace('"你仲記得個門口個燈？"', "你仲記得個門口個燈？");
  assert.throws(() => validateProse(wrap(prose), { requireQuote: true }), /spoken line missing/);
});

test("75 unquoted words blow the 70-word budget", () => {
  const pad = Array.from({ length: 75 }, (_, i) => `w${i}`).join(" ");
  const prose = `${buildProse(sheet(), shot("行啦"))}\n\n${pad}`;
  assert.throws(() => validateProse(wrap(prose)), /over budget/);
});

test("location is trimmed to its first clause, keeping the header ≤ 18 words", () => {
  const s = sheet();
  s.location = "Photoreal live-action Ming-dynasty field, dark turned furrows, thatched farmhouses far behind";
  const body = buildProse(s, shot("行啦", "阿月"));
  assert.ok(body.startsWith("Photoreal. Photoreal live-action Ming-dynasty field, night.\n"));
  const header = body.split("\n\n")[0]!;
  const wordCount = (header.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).length;
  assert.ok(wordCount <= 18, `header has ${wordCount} words`);
});
