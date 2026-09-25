import test from "node:test";
import assert from "node:assert/strict";
import { applyBoardsDecision, forcesRedo, redoFromIndex, SHOT_ID_RE } from "./shot-redo";
import type { Shot } from "./types";

const ids = ["SH01", "SH02", "SH03", "SH04"];

test("redo tail starts at the named shot", () => {
  assert.equal(redoFromIndex(ids), -1);
  assert.equal(redoFromIndex(ids, "SH03"), 2);
  assert.equal(forcesRedo(ids, "SH02", "SH03"), false);
  assert.equal(forcesRedo(ids, "SH03", "SH03"), true);
  assert.equal(forcesRedo(ids, "SH04", "SH03"), true);
  assert.equal(forcesRedo(ids, "SH01"), false);
  assert.throws(() => redoFromIndex(ids, "SH99"), /SH99/);
});

test("shot id shape", () => {
  assert.equal(SHOT_ID_RE.test("SH04"), true);
  assert.equal(SHOT_ID_RE.test("shot4"), false);
});

test("boards decision rewrites location and action onto the same require", () => {
  const shot = {
    id: "SH04",
    action: "提起",
    location: "廚房",
    require: { action: "提起", location: "廚房", facts: ["冰"] },
  } as unknown as Shot;
  const next = applyBoardsDecision(shot, { location: "露台", action: "由冰桶提起" });
  assert.equal(next.location, "露台");
  assert.equal(next.action, "由冰桶提起");
  assert.equal(next.require?.location, "露台");
  assert.equal(next.require?.action, "由冰桶提起");
  assert.deepEqual(next.require?.facts, ["冰"]);
  assert.equal(shot.require?.location, "廚房");
});
