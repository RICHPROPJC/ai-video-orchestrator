/** Stills席unit test——測核心純函數 */

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import fs from "node:fs";
import { stillFirstFlags, refsGreenOnly, sealEditRecord } from "./stills";

// ── stillFirstFlags ──
nodeTest.test("第一鏡永遠first=true", () => {
  const boards = [{ marks: [{ characterId: "A" }] }];
  assert.deepEqual(stillFirstFlags(boards), [true]);
});

nodeTest.test("同一角色第二鏡first=false", () => {
  const boards = [
    { marks: [{ characterId: "A" }] },
    { marks: [{ characterId: "A" }] },
  ];
  assert.deepEqual(stillFirstFlags(boards), [true, false]);
});

nodeTest.test("新角色出現嗰鏡first=true", () => {
  const boards = [
    { marks: [{ characterId: "A" }] },
    { marks: [{ characterId: "A" }, { characterId: "B" }] },
    { marks: [{ characterId: "B" }] },
  ];
  assert.deepEqual(stillFirstFlags(boards), [true, true, false]);
});

nodeTest.test("空marks視為唔first（除第一鏡）", () => {
  const boards = [
    { marks: [] },
    { marks: [] },
  ];
  assert.deepEqual(stillFirstFlags(boards), [true, false]);
});

// ── refsGreenOnly ──
nodeTest.test("GREEN嘅ref保留，非GREEN嘅拒", () => {
  const candidates = ["/tmp/a/SH01.png", "/tmp/a/SH02.png"];
  const isAccepted = (dir: string, id: string) => id === "SH01";
  const { kept, rejected } = refsGreenOnly(candidates, isAccepted);
  assert.equal(kept.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(kept[0].includes("SH01"));
  assert.ok(rejected[0].includes("SH02"));
});

nodeTest.test("全部GREEN全部保留", () => {
  const { kept, rejected } = refsGreenOnly(["a.png", "b.png"], () => true);
  assert.equal(kept.length, 2);
  assert.equal(rejected.length, 0);
});

// ── sealEditRecord ──
nodeTest.test("edit record用bare filename唔用絕對路徑", () => {
  const rec = sealEditRecord(
    { prompt: "test prompt", first: true, base: "/abs/path/to/base.png", refs: ["/abs/path/ref1.png"] },
    { prompt: "test prompt", img_cfg_scale: 1.0, cfg_scale: 1.0, num_steps: 8, use_edit_pe: true, width: 2048, height: 1152 },
  );
  assert.equal(rec.base, "base.png");
  assert.deepEqual(rec.refs, ["ref1.png"]);
  assert.equal(rec.first, true);
  assert.equal(rec.width, 2048);
});

// ── WIST stills實際數據 ──
nodeTest.test("WIST有44張still png", () => {
  const stillsDir = "data/jobs/SC-0913-WIST/stills";
  const pngs = fs.readdirSync(stillsDir).filter(f => f.endsWith(".png"));
  assert.equal(pngs.length, 44, `WIST應該有44張still，得${pngs.length}`);
});
