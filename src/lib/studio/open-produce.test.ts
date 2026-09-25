import test from "node:test";
import assert from "node:assert/strict";
import { fleetGateOf, refuseProduce, resumeSlate } from "./open-produce";
import type { ProduceInput } from "./types";

const base: ProduceInput = { brief: "一支片", wavDir: "" };

test("refuseProduce: scene, until, graph, drama stills, guojia full slate", () => {
  assert.equal(refuseProduce({ ...base, scene: "scene1" }), "--scene 只接受 SCxx（例：--scene SC01）");
  assert.equal(refuseProduce({ ...base, shot: "4" }), "--shot 只接受 SHxx（例：--shot SH04）");
  assert.equal(refuseProduce({ ...base, shot: "SH04" }), null);
  assert.equal(refuseProduce({ ...base, until: "cut" as ProduceInput["until"] })?.includes("--until"), true);
  assert.equal(refuseProduce({ ...base, graphVariant: "z" as ProduceInput["graphVariant"] })?.includes("--graph-variant"), true);
  assert.match(refuseProduce({ ...base, drama: "x", until: "stills" }) ?? "", /stills-ready/);
  assert.match(refuseProduce({ ...base, drama: "guojia-lingdaoren" }) ?? "", /--scene SC01/);
  assert.equal(refuseProduce({ ...base, drama: "guojia-lingdaoren", scene: "SC01" }), null);
  assert.equal(refuseProduce(base), null);
});

test("fleet gate follows the until stop", () => {
  assert.equal(fleetGateOf("boards"), "boards");
  assert.equal(fleetGateOf("blockout"), "boards");
  assert.equal(fleetGateOf("stills"), "stills");
  assert.equal(fleetGateOf("motion"), "motion");
  assert.equal(fleetGateOf(undefined), "full");
});

test("resume of a missing slate fails before any write", () => {
  const opened = resumeSlate("SC-0000-NOPE", {});
  assert.equal("error" in opened, true);
});
