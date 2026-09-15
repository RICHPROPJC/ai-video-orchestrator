import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadCallSheet } from "./writer";
import type { CallSheet } from "./types";

function baseSheet(): CallSheet {
  return {
    title: "t",
    logline: "l",
    language: "zh-Hant",
    location: "茶餐廳門口",
    timeOfDay: "night",
    weather: "rain",
    mood: "m",
    durationSec: 4,
    aspect: "16:9",
    characters: [
      { id: "A", name: "甲", role: "r", wardrobe: "w", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
      { id: "B", name: "乙", role: "r", wardrobe: "w", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
    ],
    styleBible: { grade: "g", refs: [], stillModel: "u15", motionModel: "h3" },
    shots: [
      {
        id: "SH01",
        index: 0,
        heading: "1",
        size: "medium",
        location: "茶餐廳門口",
        action: "a",
        dialogue: "",
        durationSec: 4,
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
            gait: "plant",
          },
        ],
        stillPrompt: "",
        motionPrompt: "",
      },
    ],
    voiceover: "",
  };
}

function writeSheet(mutate: (s: CallSheet) => void): string {
  const sheet = baseSheet();
  mutate(sheet);
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-wr-")), "callsheet.json");
  fs.writeFileSync(file, JSON.stringify(sheet));
  return file;
}

test("heightM + stance + props pass the gates", () => {
  const file = writeSheet((s) => {
    s.characters[0]!.heightM = 1.05;
    s.shots[0]!.marks[0]!.stance = "lean";
    s.shots[0]!.marks[0]!.stanceEnd = "crouch";
    s.shots[0]!.props = [{ name: "某物", heldBy: "A", shape: ["木"], forbid: ["鐵"] }];
  });
  const loaded = loadCallSheet(file);
  assert.equal(loaded.characters[0]!.heightM, 1.05);
  assert.equal(loaded.shots[0]!.marks[0]!.stance, "lean");
  assert.equal(loaded.shots[0]!.props![0]!.heldBy, "A");
});

test("unknown stance value throws", () => {
  const file = writeSheet((s) => {
    s.shots[0]!.marks[0]!.stance = "sit" as never;
  });
  assert.throws(() => loadCallSheet(file), /stance 'sit' is not stand\|lean\|crouch/);
});

test("unknown stanceEnd value throws", () => {
  const file = writeSheet((s) => {
    s.shots[0]!.marks[0]!.stanceEnd = "jump" as never;
  });
  assert.throws(() => loadCallSheet(file), /stanceEnd 'jump'/);
});

test("heldBy not in the shot's marks throws", () => {
  const file = writeSheet((s) => {
    s.shots[0]!.props = [{ name: "某物", heldBy: "B", shape: ["木"], forbid: ["鐵"] }];
  });
  assert.throws(() => loadCallSheet(file), /heldBy 'B' is not a character in this shot's marks/);
});

test("heightM out of range throws", () => {
  const file = writeSheet((s) => {
    s.characters[0]!.heightM = 3.1;
  });
  assert.throws(() => loadCallSheet(file), /heightM must be 0.5–2.5 m/);
});

test("prop missing shape throws", () => {
  const file = writeSheet((s) => {
    s.shots[0]!.props = [{ name: "某物", forbid: ["鐵"] }] as never;
  });
  assert.throws(() => loadCallSheet(file), /prop missing: shape/);
});
