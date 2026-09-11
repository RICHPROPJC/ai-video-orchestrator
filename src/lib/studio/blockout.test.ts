import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommand } from "./audio";
import { renderBlockout } from "./blockout";
import { probe, writeAnchors } from "./dhash-anchors";
import type { CallSheet } from "./types";

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
    { id: "A", name: "阿月", role: "保險調查員", wardrobe: "乾濕褸", palette: ["#7a9e9f", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
    { id: "B", name: "阿衡", role: "舊同事", wardrobe: "白襯衫", palette: ["#b85c4d", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
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
        {
          characterId: "A",
          start: { x: 20, y: 40 },
          end: { x: 24, y: 42 },
          facing: 0,
          handL: { x: 24, y: 38 },
          handR: { x: 26, y: 38 },
          footL: { x: 21, y: 90 },
          footR: { x: 23, y: 90 },
          gait: "walk",
        },
        {
          characterId: "B",
          start: { x: 70, y: 40 },
          end: { x: 70, y: 40 },
          facing: 0,
          handL: { x: 66, y: 38 },
          handR: { x: 74, y: 38 },
          footL: { x: 69, y: 90 },
          footR: { x: 71, y: 90 },
          gait: "plant",
        },
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
