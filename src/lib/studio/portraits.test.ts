import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PORTRAIT_PX, buildGeneratePayload } from "./u15-generate";
import { PORTRAIT_REQUIRE, ensurePortraits, portraitPrompt, type PortraitLane } from "./portraits";
import type { CallSheet, Character } from "./types";
import { PNG_MAGIC } from "./u15-edit";

const characters: Character[] = [
  { id: "A", name: "Cast-A", role: "role-one", wardrobe: "dark coat", palette: ["#111111", "#222222", "#333333"], voice: { pitchHz: 190, gender: "f" }, heightM: 1.05 },
  { id: "B", name: "Cast-B", role: "role-two", wardrobe: "light shirt", palette: ["#444444", "#555555", "#666666"], voice: { pitchHz: 120, gender: "m" } },
];

const sheet = {
  title: "t", logline: "l", language: "zh-Hant", location: "an interior", timeOfDay: "night",
  weather: "clear", mood: "plain", durationSec: 30, aspect: "16:9", characters,
  styleBible: { grade: "low key", refs: ["r"], stillModel: "s", motionModel: "m" },
  shots: [], voiceover: "",
} as unknown as CallSheet;

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "portraits-"));
}

/** A lane that writes a PNG stub and answers with a scripted verdict per call. */
function fakeLane(verdicts: ("GREEN" | "FAIL")[]) {
  const calls: { seed?: number; prompt: string; outFile: string }[] = [];
  let n = 0;
  const lane: PortraitLane = {
    generate: async ({ payload, outFile, recordJson }) => {
      calls.push({ seed: payload.seed, prompt: payload.prompt, outFile });
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      fs.writeFileSync(outFile, Buffer.concat([PNG_MAGIC, Buffer.from("stub")]));
      fs.writeFileSync(recordJson, "{}");
    },
    qc: async () => {
      const status = verdicts[n] ?? "GREEN";
      n += 1;
      return { status, checks: { status, fail_reasons: status === "GREEN" ? [] : ["people_count: 2"] } };
    },
  };
  return { lane, calls };
}

test("the t2i payload is 1024² with thinking on and the fork's step count", () => {
  const p = buildGeneratePayload({ prompt: " a face ", seed: 42 });
  assert.equal(p.prompt, "a face");
  assert.equal(p.width, PORTRAIT_PX);
  assert.equal(p.height, PORTRAIT_PX);
  assert.equal(p.think_mode, true);
  assert.equal(p.num_steps, 50);
  assert.equal(p.seed, 42);
  assert.deepEqual(Object.keys(p).sort(), ["height", "num_steps", "prompt", "seed", "think_mode", "width"]);
  assert.throws(() => buildGeneratePayload({ prompt: "  " }), /empty prompt/);
  assert.equal(buildGeneratePayload({ prompt: "x", width: 1050 }).width, 1024);
});

test("T43 P1/P2: the portrait prompt carries no world line — sheet 夜街 tokens never enter the face reference", () => {
  const nightSheet = {
    ...sheet,
    location: "軍校男生宿舍",
    timeOfDay: "night",
    weather: "neon",
    styleBible: { ...sheet.styleBible, grade: "夜街霓虹濕地反光" },
  } as CallSheet;
  const prompt = portraitPrompt(characters[0]!);
  assert.match(prompt, /Plain background/, "P1: Plain background 明示");
  assert.match(prompt, /one person alone/);
  assert.match(prompt, /dark coat/);
  assert.match(prompt, /#111111/);
  assert.match(prompt, /No other people/);
  assert.match(prompt, /no grey mannequins/);
  assert.ok(prompt.includes("facing camera"), "front portrait keeps the frontal sentence (card C2: 正面保留原句)");
  assert.ok(!prompt.includes("Cast-A"), "identity comes from the image, not the name");
  // P2: callsheet 世界句入肖像＝FAIL — 逐個 world token 驗
  for (const banned of [
    nightSheet.location,
    nightSheet.timeOfDay,
    nightSheet.weather,
    nightSheet.styleBible.grade,
    "軍校",
    "霓虹",
    "night",
    "neon",
  ]) {
    assert.ok(!prompt.includes(banned), `portrait prompt 唔准有 world token：${JSON.stringify(banned)}`);
  }
});

/** Card C2 (§0b 0920 angle-ref law): the 45° variant is the /edit sentence
 *  that turns the front portrait into the three-quarter ref — the verified v2
 *  formula names the 90° ban and the eye guard; v1 without them came out 90°. */
test("C2: the 45° angle prompt is the /edit v2 sentence — 90° banned, both eyes kept, identity via Image-1", () => {
  const prompt = portraitPrompt(characters[0]!, sheet, "45");
  assert.ok(prompt.includes("唔好轉成90度純側面"), "the 90° ban is verbatim");
  assert.ok(prompt.includes("45度"), "names the angle");
  assert.ok(prompt.includes("雙眼同兩邊面頰"), "eye guard verbatim");
  assert.ok(prompt.includes("Image-1"), "naming the image slot — it is an /edit prompt");
  assert.ok(prompt.includes("照Image-1不變"), "face/hair/wardrobe locked to the front portrait");
  assert.ok(prompt.includes("dark coat"), "wardrobe from the callsheet");
  assert.ok(prompt.includes("Cast-A"), "the /edit prompt names the character (identity rides the image)");
  assert.ok(!prompt.includes("facing camera"), "the frontal t2i sentence never leaks into the angle variant");
});

test("a plugged portrait is used as-is and never regenerated", async () => {
  const plugDir = tmpDir();
  const outDir = tmpDir();
  fs.writeFileSync(path.join(plugDir, "A.png"), Buffer.concat([PNG_MAGIC, Buffer.from("plug")]));
  const { lane, calls } = fakeLane(["GREEN"]);
  const result = await ensurePortraits({ sheet, outDir, plugDir, lane });

  assert.deepEqual(result.plugged, ["A"]);
  assert.deepEqual(result.made, ["B"]);
  assert.equal(result.files.A, path.join(plugDir, "A.png"));
  assert.equal(result.files.B, path.join(outDir, "B.png"));
  assert.equal(calls.length, 1, "only the uncast character is generated");
  assert.equal(calls[0]!.outFile, path.join(outDir, "B.png"));
});

test("the blind eye gates every made portrait: one person, no grey, plain background", () => {
  assert.deepEqual(PORTRAIT_REQUIRE, { people_count: 1, grey_blocks: false, plain_background: true });
});

test("a failed portrait gets exactly one more seed, then passes", async () => {
  const outDir = tmpDir();
  const { lane, calls } = fakeLane(["FAIL", "GREEN", "GREEN"]);
  const result = await ensurePortraits({ sheet, outDir, lane, seed: 42 });

  assert.deepEqual(result.made, ["A", "B"]);
  assert.equal(calls.length, 3, "A twice, B once");
  assert.equal(calls[0]!.seed, 42);
  assert.equal(calls[1]!.seed, 43, "the retry moves the seed");
  assert.equal(calls[2]!.seed, 42, "the next character starts fresh");
});

test("two failures throw instead of anchoring a keyframe on a bad face", async () => {
  const outDir = tmpDir();
  const { lane, calls } = fakeLane(["FAIL", "FAIL"]);
  await assert.rejects(
    () => ensurePortraits({ sheet, outDir, lane, seed: 7 }),
    /portrait for A failed the eye twice \(seeds 7, 8\): people_count: 2/,
  );
  assert.equal(calls.length, 2, "no third attempt");
});

test("events name the character and the seed that worked", async () => {
  const outDir = tmpDir();
  const { lane } = fakeLane(["FAIL", "GREEN", "GREEN"]);
  const seen: string[] = [];
  await ensurePortraits({ sheet, outDir, lane, seed: 42, onEvent: (m) => void seen.push(m) });
  assert.ok(seen.some((m) => m.includes("A 肖像未過")));
  assert.ok(seen.some((m) => m.includes("A 肖像 GREEN（seed 43）")));
});
