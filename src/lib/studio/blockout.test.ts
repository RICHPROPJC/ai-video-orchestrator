import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { fileURLToPath } from "node:url";
import { runCommand } from "./audio";
import { assertFiguresVisible, extractFrame0, renderBlockout, stillFrameFor } from "./blockout";
import { frameHashes, hamming, probe, writeAnchors } from "./dhash-anchors";
import type { CallSheet, Shot } from "./types";

const mark = (over: Partial<Shot["marks"][number]> & { characterId: string }): Shot["marks"][number] => ({
  start: { x: 20, y: 40 },
  end: { x: 24, y: 42 },
  facing: 0,
  handL: { x: 24, y: 38 },
  handR: { x: 26, y: 38 },
  footL: { x: 21, y: 80 },
  footR: { x: 23, y: 80 },
  gait: "plant",
  ...over,
});

const sheet: CallSheet = {
  title: "blockout-test",
  logline: "one synthetic shot",
  language: "zh-Hant",
  location: "茶餐廳門口",
  timeOfDay: "night",
  weather: "rain",
  mood: "test",
  durationSec: 2,
  aspect: "16:9",
  characters: [
    { id: "A", name: "阿月", role: "保險調查員", wardrobe: "乾濕褸", palette: ["#7a9e9f", "#222", "#333"], voice: { pitchHz: 200, gender: "f" }, heightM: 1.05 },
    { id: "B", name: "阿衡", role: "舊同事", wardrobe: "白襯衫", palette: ["#b85c4d", "#222", "#333"], voice: { pitchHz: 180, gender: "m" }, heightM: 0.92 },
  ],
  styleBible: { grade: "test", refs: [], stillModel: "u15", motionModel: "h3" },
  shots: [
    {
      id: "SH01",
      index: 0,
      heading: "1",
      size: "medium",
      location: "茶餐廳門口",
      action: "兩人相認",
      dialogue: "",
      durationSec: 2,
      camera: { pos: { x: 0, y: -4, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.4 }, lensMm: 35 },
      marks: [
        mark({ characterId: "A", end: { x: 24, y: 42 }, gait: "walk" }),
        mark({ characterId: "B", start: { x: 70, y: 40 }, end: { x: 70, y: 40 }, handL: { x: 66, y: 38 }, handR: { x: 74, y: 38 }, footL: { x: 69, y: 80 }, footR: { x: 71, y: 80 }, stance: "crouch" }),
      ],
      stillPrompt: "",
      motionPrompt: "",
    },
  ],
  voiceover: "",
};

async function ffprobeWh(file: string): Promise<{ width: number; height: number }> {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=width,height", "-of", "json", file,
  ]);
  const st = (JSON.parse(r.stdout).streams ?? [])[0] as { width?: number; height?: number };
  return { width: st.width ?? 0, height: st.height ?? 0 };
}

test("grey WORKBENCH blockout renders 48 frames at 864x480 24fps, anchors [0]+≤5", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-bl-"));
  const outMp4 = path.join(dir, "SH01.mp4");
  const done = await renderBlockout({ sheet, shot: sheet.shots[0]!, frames: 48, outMp4 });
  assert.equal(done.frames, 48);

  const facts = await probe(outMp4);
  assert.equal(facts.nbFrames, 48, "nb_frames");
  assert.equal(facts.fps, 24, "fps");
  const { width, height } = await ffprobeWh(outMp4);
  assert.equal(width, 864);
  assert.equal(height, 480);

  const anchors = await writeAnchors(outMp4, path.join(dir, "anchors.json"));
  assert.equal(anchors.anchors[0]!.frame, 0, "frame 0 always anchors");
  assert.ok(anchors.anchors.length <= 6, `0 + at most 5 change points, got ${anchors.anchors.length - 1}`);
  assert.equal(fs.existsSync(outMp4), true);
});

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

/** the C3KJ regression: an empty grey floor must fail the figure gate */
test("empty blockout fixture FAILs assertFiguresVisible", async () => {
  const shot: Shot = {
    ...sheet.shots[0]!,
    marks: [
      mark({ characterId: "A", start: { x: 46, y: 56 }, end: { x: 46, y: 56 }, handL: { x: 52, y: 48 }, handR: { x: 58, y: 47 }, footL: { x: 43, y: 78 }, footR: { x: 50, y: 78 } }),
      mark({ characterId: "B", start: { x: 69, y: 62 }, end: { x: 69, y: 62 }, handL: { x: 65, y: 70 }, handR: { x: 73, y: 70 }, footL: { x: 67, y: 82 }, footR: { x: 73, y: 82 } }),
    ],
  };
  await assert.rejects(
    () => assertFiguresVisible(path.join(fixtureDir, "blockout-empty-f0.png"), shot),
    /SH01 blockout has no figure at mark A/,
  );
});

test("24-frame render passes the figure gate (test (b))", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-bl24-"));
  const outMp4 = path.join(dir, "SH01.mp4");
  await renderBlockout({ sheet, shot: sheet.shots[0]!, frames: 24, outMp4 });
  const f0 = path.join(dir, "SH01.f0.png");
  await extractFrame0(outMp4, f0);
  await assertFiguresVisible(f0, sheet.shots[0]!);
});

/** unproject round-trip: feet at (50,60) put a standing figure whose dark-pixel
 *  centroid lands back at the same frame percentages (±8%) */
test("mark at (50,60) renders a figure centred on the mark (test (c))", async () => {
  const roundTrip: CallSheet = {
    ...sheet,
    characters: [sheet.characters[0]!],
    shots: [
      {
        ...sheet.shots[0]!,
        camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0.2, y: 0.4, z: 1.1 }, lensMm: 35 },
        marks: [
          mark({
            characterId: "A",
            start: { x: 50, y: 60 },
            end: { x: 50, y: 60 },
            handL: { x: 55, y: 50 },
            handR: { x: 60, y: 50 },
            footL: { x: 47, y: 60 },
            footR: { x: 53, y: 60 },
          }),
        ],
      },
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-blrt-"));
  const outMp4 = path.join(dir, "SH01.mp4");
  await renderBlockout({ sheet: roundTrip, shot: roundTrip.shots[0]!, frames: 24, outMp4 });
  const f0 = path.join(dir, "SH01.f0.png");
  await extractFrame0(outMp4, f0);

  const { data, info } = await sharp(f0).greyscale().raw().toBuffer({ resolveWithObject: true });
  let sx = 0, sy = 0, n = 0, maxYPct = 0;
  for (let y = 0; y < info.height; y += 1) {
    for (let x = 0; x < info.width; x += 1) {
      if (data[y * info.width + x]! < 120) {
        sx += x;
        sy += y;
        n += 1;
        maxYPct = Math.max(maxYPct, y / info.height);
      }
    }
  }
  assert.ok(n > 200, `figure mask too small: ${n}px`);
  const cx = sx / n / info.width;
  const bottom = maxYPct;
  assert.ok(Math.abs(cx - 0.5) <= 0.08, `centroid x ${cx.toFixed(3)} not within ±8% of the mark u`);
  assert.ok(Math.abs(bottom - 0.6) <= 0.08, `feet bottom ${bottom.toFixed(3)} not within ±8% of the mark v`);
});

/** callsheet_v2 shape: SH02's stanceEnd makes its keyframe frame differ from SH01 */
test("SH01 vs SH02 f0 differ by hamming(dhash) >= 8 (test (d))", async () => {
  const baseMark = (characterId: string, stance?: string, stanceEnd?: string): Shot["marks"][number] =>
    mark({
      characterId,
      start: { x: characterId === "A" ? 46 : 69, y: characterId === "A" ? 56 : 62 },
      end: { x: characterId === "A" ? 46 : 69, y: characterId === "A" ? 56 : 62 },
      handL: { x: characterId === "A" ? 52 : 65, y: characterId === "A" ? 48 : 70 },
      handR: { x: characterId === "A" ? 58 : 73, y: characterId === "A" ? 47 : 70 },
      footL: { x: characterId === "A" ? 43 : 67, y: 78 },
      footR: { x: characterId === "A" ? 50 : 73, y: 78 },
      ...(stance ? { stance: stance as Shot["marks"][number]["stance"] } : {}),
      ...(stanceEnd ? { stanceEnd: stanceEnd as Shot["marks"][number]["stanceEnd"] } : {}),
    });
  const prop = { name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] };
  const camera = { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0.2, y: 0.4, z: 1.1 }, lensMm: 35 };
  const sh01: Shot = {
    ...sheet.shots[0]!,
    camera,
    marks: [baseMark("A", "lean"), baseMark("B", "crouch")],
    props: [prop],
  };
  const sh02: Shot = {
    ...sheet.shots[0]!,
    id: "SH02",
    marks: [baseMark("A", "lean"), baseMark("B", "crouch", "stand")],
    props: [prop],
  };
  const two: CallSheet = { ...sheet, shots: [sh01, sh02] };

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-bldiff-"));
  const f0s: string[] = [];
  for (const shot of two.shots) {
    const outMp4 = path.join(dir, `${shot.id}.mp4`);
    const frames = 24;
    await renderBlockout({ sheet: two, shot, frames, outMp4 });
    const f0 = path.join(dir, `${shot.id}.f0.png`);
    await extractFrame0(outMp4, f0, stillFrameFor(shot, frames));
    f0s.push(f0);
  }
  const [h1, h2] = await Promise.all(f0s.map((f) => frameHashes(f)));
  const d = hamming(h1[0]!, h2[0]!);
  assert.ok(d >= 8, `hamming ${d} < 8 — SH02 f0 is not distinct from SH01 f0`);
});
