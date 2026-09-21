import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CREATIVE_BRIEF_PRESETS,
  VISUAL_STYLE_PRESETS,
  TRANSITION_STYLE_PRESETS,
  CONSTRAINT_PRESETS,
  SOUNDSCAPE_PRESETS,
  MUSIC_PRESETS,
  SHOT_RECOMMENDATIONS,
  MARKER_RECOMMENDATIONS,
  TRANSITION_RECOMMENDATIONS,
  assertPresetFamily,
} from "./combat-presets";

/** Golden lock: the registry deep-equals the real Python prompt_presets module
 *  (combat-fixtures/python-presets.json, generated read-only from
 *  /mnt/ssd/h3studio @ 2bc8c907). Entry-for-entry verbatim, all six families. */

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "combat-fixtures", "python-presets.json"), "utf8"),
) as {
  source: string;
  h3studio_commit: string;
  families: Record<string, Record<string, string>>;
  shot_recommendations: Record<string, unknown>;
  marker_recommendations: Record<string, string>;
};

test("golden: every preset family is verbatim from the Python module", () => {
  const ts = {
    CREATIVE_BRIEF_PRESETS,
    VISUAL_STYLE_PRESETS,
    TRANSITION_STYLE_PRESETS,
    CONSTRAINT_PRESETS,
    SOUNDSCAPE_PRESETS,
    MUSIC_PRESETS,
  };
  for (const [name, registry] of Object.entries(ts)) {
    assert.deepStrictEqual(
      registry,
      GOLDEN.families[name],
      `preset family ${name} diverged from python-presets.json`,
    );
    assert.equal(Object.keys(registry).length, 32, `${name} must be exactly 32 entries`);
  }
});

test("golden: shot/marker recommendations are verbatim", () => {
  assert.deepStrictEqual(SHOT_RECOMMENDATIONS, GOLDEN.shot_recommendations);
  assert.deepStrictEqual(MARKER_RECOMMENDATIONS, GOLDEN.marker_recommendations);
  assert.deepStrictEqual(TRANSITION_RECOMMENDATIONS, GOLDEN.families.TRANSITION_STYLE_PRESETS);
});

test("golden fixture provenance is pinned to the h3studio commit", () => {
  assert.equal(GOLDEN.source, "prompt_presets.py");
  assert.match(GOLDEN.h3studio_commit, /^2bc8c907/);
});

test("family guard: 31 entries is not a family (the source ValueError law)", () => {
  const rows31 = Array.from({ length: 31 }, (_, i) => [`k${i}`, `v${i}`] as const);
  assert.throws(() => assertPresetFamily("TEST", rows31), /exactly 32 entries, got 31/);
  const rows32 = [...rows31, ["k31", "v31"] as const];
  assert.deepEqual(assertPresetFamily("TEST", rows32), Object.fromEntries(rows32));
});

test("combat flag anchors exist verbatim: Physical Contact / Match-on-Action / Rain", () => {
  assert.equal(
    CONSTRAINT_PRESETS["Physical Contact"],
    "Preserve accurate contact points, grip, weight, friction, gravity, momentum and collision response between subjects and objects.",
  );
  assert.equal(
    TRANSITION_STYLE_PRESETS["Match-on-Action"],
    "Cut during a clearly readable action and continue the same movement, speed and direction in the incoming shot.",
  );
  assert.equal(
    SOUNDSCAPE_PRESETS["Rain"],
    "Consistent rainfall on nearby surfaces, occasional runoff, dampened environmental reflections and synchronized wet footsteps.",
  );
});
