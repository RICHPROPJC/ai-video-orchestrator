/** Layout席unit test */

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import fs from "node:fs";
import { piecesFromCallSheet, stillFrameFor, verbsForGate } from "./layout";

// ── piecesFromCallSheet ──
nodeTest.test("callsheet提取角色+道具+場景做世界件", () => {
  const sheet = {
    characters: [
      { id: "A", name: "阿捷", heightM: 1.75 },
    ],
    props: [
      { name: "ZIP! 汽水罐", sizeMeters: 0.115 },
    ],
    location: "廚房",
  };
  const pieces = piecesFromCallSheet(sheet as never);
  assert.equal(pieces.length, 3);
  assert.equal(pieces[0].role, "character");
  assert.equal(pieces[0].meters, 1.75);
  assert.equal(pieces[1].role, "prop");
  assert.equal(pieces[1].meters, 0.115);
  assert.equal(pieces[2].role, "scene");
});

nodeTest.test("冇props只出角色+場景", () => {
  const sheet = {
    characters: [{ id: "A", name: "A", heightM: 1.7 }],
    props: [],
    location: "office",
  };
  const pieces = piecesFromCallSheet(sheet as never);
  assert.equal(pieces.length, 2);
});

// ── stillFrameFor ──
nodeTest.test("2秒鏡頭still幀=24（中間偏前）", () => {
  assert.equal(stillFrameFor(2, 56), 24);
});

nodeTest.test("超短鏡still幀唔超出範圍", () => {
  assert.ok(stillFrameFor(0.5, 10) <= 9);
});

// ── verbsForGate ──
nodeTest.test("action動詞匹配已知verb", () => {
  const verbs = new Set(["walk", "pick", "drink"]);
  const hits = verbsForGate("walking to table and pick up can", verbs);
  assert.ok(hits.includes("pick"));
});

nodeTest.test("冇匹配返空array", () => {
  assert.equal(verbsForGate("sitting still", new Set(["run"])).length, 0);
});

// ── WIST blockout對照 ──
nodeTest.test("WIST有44個blockout mp4", () => {
  const dir = "data/jobs/SC-0913-WIST/blockout";
  const mp4s = fs.readdirSync(dir).filter(f => f.endsWith(".mp4"));
  assert.equal(mp4s.length, 44, `WIST blockout應44個，得${mp4s.length}`);
});
