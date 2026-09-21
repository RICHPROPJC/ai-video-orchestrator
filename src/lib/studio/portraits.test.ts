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

/** W4: real small pngs for the board chain (16² fronts, 64² boards) */
async function makePng(file: string, size: number, rgba = false) {
  const args = ["-y", "-f", "lavfi", "-i", `color=c=gray:s=${size}x${size}`, "-frames:v", "1"];
  if (rgba) args.push("-pix_fmt", "rgba");
  args.push(file);
  const { runCommand } = await import("./audio");
  const r = await runCommand("ffmpeg", args);
  assert.equal(r.code, 0, r.stderr);
}

test("W4 批量資產板：angleBoard mode per character — 四角度 RGBA pin 入 portraits/，唔開就零改動", async () => {
  const outDir = tmpDir();
  const portrait = fakeLane(["GREEN", "GREEN"]);
  const boardLane = {
    edit: async (o: { outFile: string }) => makePng(o.outFile, 64),
    qc: async (png: string, outJson: string, _require: unknown) => {
      void png;
      void _require;
      fs.writeFileSync(outJson, JSON.stringify({ tool: "slatecrew.photo_qc", status: "GREEN", checks: { status: "GREEN", fail_reasons: [] } }));
      return { status: "GREEN" as const, checks: { status: "GREEN", fail_reasons: [] as string[] } };
    },
    cut: async (boardPng: string, cells: { file: string; x: number; y: number; w: number; h: number }[]) => {
      const { runCommand } = await import("./audio");
      for (const c of cells) {
        const r = await runCommand("ffmpeg", ["-y", "-i", boardPng, "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y}`, "-frames:v", "1", c.file]);
        assert.equal(r.code, 0, r.stderr);
      }
    },
    rembg: async (input: string, output: string) => {
      const { runCommand } = await import("./audio");
      const r = await runCommand("ffmpeg", ["-y", "-i", input, "-pix_fmt", "rgba", output]);
      assert.equal(r.code, 0, r.stderr);
    },
  };
  const res = await ensurePortraits({
    sheet,
    outDir,
    seed: 7,
    lane: portrait.lane,
    angleBoard: true,
    boardLane,
  });
  for (const id of ["A", "B"]) {
    for (const a of ["front", "45", "side", "back"] as const) {
      const f = res.anglePins?.[id]?.[a];
      assert.ok(f && fs.existsSync(f), `${id}.${a} RGBA pin 入庫`);
      const { runCommand } = await import("./audio");
      const probe = await runCommand("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=pix_fmt", "-of", "json", f!]);
      assert.match(probe.stdout, /rgba/, `${id}.${a} 係 RGBA`);
    }
  }
  assert.ok(fs.existsSync(path.join(outDir, "boards", "A.angles.png")), "成張板只住 boards/（SHEETREF 紅線）");

  // default mode untouched: no angleBoard flag → no boards dir, no pins
  const plain = tmpDir();
  const plainLane = fakeLane(["GREEN", "GREEN"]);
  const resPlain = await ensurePortraits({ sheet, outDir: plain, seed: 7, lane: plainLane.lane });
  assert.equal(resPlain.anglePins && Object.keys(resPlain.anglePins).length, 0);
  assert.ok(!fs.existsSync(path.join(plain, "boards")));
});
