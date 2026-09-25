import test from "node:test";
import assert from "node:assert/strict";
import { keyframeRelPaths, layoutKeyframes, layoutOwnBoards } from "./keyframe-rels";

test("one moment is the still; several moments are kf cells", () => {
  assert.deepEqual(keyframeRelPaths({ id: "SH01" }), ["stills/SH01.png"]);
  assert.deepEqual(keyframeRelPaths({ id: "SH09", keyframePositions: "0%, 40%, 100%" }), [
    "stills/SH09.kf-00.png",
    "stills/SH09.kf-01.png",
    "stills/SH09.kf-02.png",
  ]);
});

test("location change starts a new column; keyframes stay in order", () => {
  const nodes = layoutKeyframes([
    { id: "SH01", location: "廚房", keyframePositions: "0%, 100%" },
    { id: "SH02", location: "廚房" },
    { id: "SH04", location: "露台" },
  ]);
  assert.deepEqual(nodes.map((n) => n.rel), [
    "stills/SH01.kf-00.png",
    "stills/SH01.kf-01.png",
    "stills/SH02.png",
    "stills/SH04.png",
  ]);
  assert.equal(nodes[0]!.x, nodes[2]!.x);
  assert.ok(nodes[3]!.x > nodes[2]!.x);
  assert.ok(nodes[1]!.y > nodes[0]!.y);
});

test("own boards sit beside the chain and are not keyframes", () => {
  const boards = layoutOwnBoards({
    characters: [{ id: "A", name: "阿檸" }],
    locations: ["廚房", "廚房", "露台"],
    propCount: 1,
    right: 268,
  });
  assert.deepEqual(boards.map((b) => b.rel), [
    "portraits/boards/A.angles.png",
    undefined,
    undefined,
    "assets/boards/props-01.png",
  ]);
  assert.ok(boards.every((b) => b.x >= 268 + 144));
  assert.ok(!boards.some((b) => b.rel?.includes("scene-廚房")));
});
