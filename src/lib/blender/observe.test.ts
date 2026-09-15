import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { observe, runChecks, type Observation, type CheckResult } from "./observe";

const results = JSON.parse(readFileSync(path.join(process.cwd(), "shots/fixtures/f3/results.json"), "utf8")) as Record<
  string, { observation: Observation; checks: CheckResult[]; ok: boolean }
>;

for (const [name, receipt] of Object.entries(results)) {
  test(`headless Python / TypeScript verdict parity: ${name}`, () => {
    const actual = runChecks(observe(receipt.observation), receipt.checks.map((check) => check.id));
    const verdict = ({ id, ok, required }: CheckResult) => ({ id, ok, required });
    assert.deepEqual(actual.map(verdict), receipt.checks.map(verdict));
  });
}

test("geometry-only and stale/cross-camera pixel evidence fail closed", () => {
  const fixed = results.shot4_fixed.observation;
  const mutations: ((obs: Observation) => void)[] = [
    (obs) => { obs.pixelEvidence = null; },
    (obs) => { obs.frame += 1; },
    (obs) => { obs.camera!.name = "DifferentCamera"; },
    (obs) => { obs.hero!.meshes = ["CamTarget"]; },
    (obs) => { obs.hero!.screenPos = [NaN, 0.5]; },
    (obs) => { obs.hero!.screenPos = [0.1, 0.5]; },
    (obs) => { obs.pixelEvidence!.pixelCount = 0; },
    (obs) => { obs.pixelEvidence!.sha256 = ""; },
    (obs) => { obs.camera!.evaluated = false; },
  ];
  for (const mutate of mutations) {
    const observation = observe(fixed);
    mutate(observation);
    assert.equal(runChecks(observation, ["hero_on_screen"])[0].ok, false);
  }
  assert.equal(runChecks(fixed, ["hero_on_screen"])[0].ok, true);
});

test("unknown checks cannot inherit object prototype success", () => {
  assert.deepEqual(runChecks(results.shot4_fixed.observation, ["toString", "not_a_check"]).map((c) => c.ok), [false, false]);
});
