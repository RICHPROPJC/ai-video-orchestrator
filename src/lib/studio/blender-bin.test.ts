import test from "node:test";
import assert from "node:assert/strict";
import { assertBlender5, blenderVersion, BLENDER_5, resolveBlenderBin } from "./blender-bin";

test("default bin is the 5.1.2 install, not PATH blender", () => {
  const prev = process.env.BLENDER_BIN;
  delete process.env.BLENDER_BIN;
  try {
    assert.equal(resolveBlenderBin(), BLENDER_5);
    assert.ok(!resolveBlenderBin().includes("/usr/bin/blender"));
  } finally {
    if (prev !== undefined) process.env.BLENDER_BIN = prev;
  }
});

test("installed 5.x reports major >= 5", () => {
  const v = blenderVersion(BLENDER_5);
  assert.match(v, /^5\./);
  assert.equal(assertBlender5(BLENDER_5), v);
});
