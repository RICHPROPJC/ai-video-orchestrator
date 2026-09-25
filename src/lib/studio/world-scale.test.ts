import test from "node:test";
import assert from "node:assert/strict";
import { aimShot, placeWorld, resolveScales, type WorldPiece } from "./world-scale";

const pieces: WorldPiece[] = [
  { id: "A", role: "character", glb: "A.glb", heightM: 1.6 },
  { id: "木檯", role: "scene", glb: "table.glb" },
  { id: "樽", role: "prop", glb: "bottle.glb", heldBy: "A" },
];

test("resolveScales: 冇寫尺寸就跟唯一角色 heightM", () => {
  const got = resolveScales(pieces);
  assert.ok("ok" in got);
  if ("ok" in got) {
    assert.equal(got.ok.find((r) => r.id === "木檯")!.meters, 1.6);
    assert.equal(got.ok.find((r) => r.id === "樽")!.meters, 1.6 * 0.25);
  }
});

test("resolveScales: a confirmed proportion uses that character heightM", () => {
  const got = resolveScales([
    pieces[0]!,
    { ...pieces[1]!, proportion: { of: "A", at: "waist", source: "檯面到阿檸腰" } },
    { ...pieces[2]!, sizeM: 0.3, sizeSource: "樽高 30cm" },
  ]);
  assert.ok("ok" in got);
  if ("ok" in got) {
    assert.equal(got.ok.find((r) => r.id === "木檯")!.meters, 1.6 * 0.55);
    assert.equal(got.ok.find((r) => r.id === "樽")!.evidence, "樽高 30cm");
  }
});

test("placeWorld + aimShot: bottle is held, camera looks at it, not at callsheet xyz", () => {
  const scaled = resolveScales([
    pieces[0]!,
    { ...pieces[1]!, sizeM: 0.8, sizeSource: "檯高 80cm" },
    { ...pieces[2]!, sizeM: 0.3, sizeSource: "樽高 30cm" },
  ]);
  assert.ok("ok" in scaled);
  if (!("ok" in scaled)) return;
  const placed = placeWorld([
    pieces[0]!,
    { ...pieces[1]!, sizeM: 0.8, sizeSource: "檯高 80cm" },
    { ...pieces[2]!, sizeM: 0.3, sizeSource: "樽高 30cm" },
  ], scaled.ok);
  const bottle = placed.find((p) => p.id === "樽")!;
  assert.equal(bottle.heldBy, "A");
  assert.ok(bottle.z > 0);
  const aim = aimShot({ id: "SH02", lensMm: 50, size: "closeup", location: "木檯", heldPropId: "樽" }, placed);
  assert.equal(aim.lookAtId, "樽");
  assert.equal(aim.hold, false);
  const noTarget = aimShot({ id: "SH00", lensMm: 35, size: "wide" }, placed);
  assert.equal(noTarget.hold, true);
});
