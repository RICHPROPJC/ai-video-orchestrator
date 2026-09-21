import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  align_segments_to_dialogue_turns,
  apply_segment_render_profile,
  content_fingerprint,
  dirty_segment_indexes,
  derive_named_segment_seed,
  derive_segment_seed,
  normalize_speech_overlap_policy,
  plan_long_form_dialogue_segments,
  plan_render_segments,
  plan_shot_render_segments,
  plan_speech_track_lanes,
  protect_segment_boundaries_from_atomic_shots,
  protect_segment_boundaries_from_speech,
  ranges_intersect,
  rebase_timed_rows,
  RenderSegment,
  reuse_cached_segments,
  scope_timed_prompt_text,
  SEGMENT_PREVIEW_PROFILE,
  type PyRow,
} from "./segment-engine";

/**
 * Golden lock: every case in segment-fixtures/python-golden.json was produced
 * by the REAL h3studio Python engine (verify/segment/gen-golden.py, read-only,
 * h3studio @ 2bc8c907). The TS port must deep-equal all of them — drift dies
 * here, not in the render path. Dialogue-aligned segmentation per card SEG1:
 * short / long / multi-speaker / dense overlapping dialogue all frozen.
 */

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "segment-fixtures", "python-golden.json"), "utf8"),
) as {
  source: string;
  h3studio_commit: string;
  cases: {
    name: string;
    fn: string;
    args: unknown[];
    kwargs: Record<string, unknown>;
    output?: unknown;
    error?: string;
  }[];
};

/** Rehydrate `{"__segments__": [...]}` wrappers into RenderSegment objects. */
function hydrate(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrate);
  if (typeof value === "object" && value !== null && "__segments__" in value) {
    return (value as { __segments__: PyRow[] }).__segments__.map((row) =>
      RenderSegment.fromDict(row),
    );
  }
  return value;
}

function callFn(fn: string, args: unknown[], kwargs: Record<string, unknown>): unknown {
  const a = args.map(hydrate);
  switch (fn) {
    case "plan_render_segments":
      return plan_render_segments(a[0] as number, a[1] as number, kwargs);
    case "plan_shot_render_segments":
      return plan_shot_render_segments(a[0] as number, a[1] as number, a[2] as PyRow[], kwargs);
    case "protect_segment_boundaries_from_speech":
      return protect_segment_boundaries_from_speech(
        a[0] as RenderSegment[], a[1] as PyRow[], kwargs,
      );
    case "protect_segment_boundaries_from_atomic_shots":
      return protect_segment_boundaries_from_atomic_shots(
        a[0] as RenderSegment[], a[1] as PyRow[], kwargs,
      );
    case "align_segments_to_dialogue_turns":
      return align_segments_to_dialogue_turns(a[0] as RenderSegment[], a[1] as PyRow[], kwargs);
    case "plan_speech_track_lanes":
      return plan_speech_track_lanes(a[0] as PyRow[], kwargs);
    case "normalize_speech_overlap_policy":
      return normalize_speech_overlap_policy(a[0]);
    case "scope_timed_prompt_text":
      return scope_timed_prompt_text(a[0] as string, a[1] as number, a[2] as number, kwargs);
    case "derive_segment_seed":
      return derive_segment_seed(a[0] as number, a[1] as number);
    case "derive_named_segment_seed":
      return derive_named_segment_seed(a[0] as number, a[1] as string);
    case "ranges_intersect":
      return ranges_intersect(a[0] as number, a[1] as number, a[2] as number, a[3] as number);
    case "dirty_segment_indexes":
      return dirty_segment_indexes(a[0] as RenderSegment[], a[1] as number, a[2] as number);
    case "rebase_timed_rows":
      return rebase_timed_rows(a[0] as PyRow[], a[1] as number, a[2] as number, kwargs);
    case "content_fingerprint":
      return content_fingerprint(a[0]);
    case "reuse_cached_segments":
      return reuse_cached_segments(a[0] as RenderSegment[], a[1] as PyRow[]);
    default:
      throw new Error(`golden case calls unknown fn ${fn}`);
  }
}

function toComparable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(toComparable);
  if (value instanceof RenderSegment) return value.toDict();
  if (typeof value === "bigint") return String(value);
  return value;
}

test(`segment golden lock: ${GOLDEN.cases.length} cases vs h3studio@${GOLDEN.h3studio_commit.slice(0, 8)}`, () => {
  assert.match(GOLDEN.source, /segment_engine\.py/);
  assert.ok(GOLDEN.cases.length >= 70);
  for (const c of GOLDEN.cases) {
    if (c.error) {
      const expected = c.error.replace(/^[A-Za-z]+: /, "");
      assert.throws(
        () => callFn(c.fn, c.args, c.kwargs),
        (err: Error) => err.message === expected,
        `${c.name}: expected error ${expected}`,
      );
      continue;
    }
    const result = callFn(c.fn, c.args, c.kwargs);
    assert.deepStrictEqual(
      toComparable(result),
      toComparable(c.output),
      `golden case ${c.name} drifted from h3studio`,
    );
  }
});

// ---- SEG1 ② preview flag: downgrade only on the flagged path ----------------

test("preview flag off: production profile passes through untouched", () => {
  const production = { steps: 8, width: 864, height: 480 };
  const out = apply_segment_render_profile(false, production);
  assert.deepStrictEqual(out, production);
  assert.notEqual(out, production); // clone — caller's object never aliased
});

test("preview flag on: steps and resolution downgrade to the 0.2M profile", () => {
  const production = { steps: 8, width: 864, height: 480 };
  const out = apply_segment_render_profile(true, production);
  assert.deepStrictEqual(out, SEGMENT_PREVIEW_PROFILE);
  assert.ok(out.width * out.height <= 0.21 * 1_000_000);
  assert.equal(out.width % 16, 0);
  assert.equal(out.height % 16, 0);
  // formal path values untouched
  assert.deepStrictEqual(production, { steps: 8, width: 864, height: 480 });
});

// ---- SEG1 ④ entry composition -----------------------------------------------

test("plan_long_form_dialogue_segments composes plan→atomic→speech→align", () => {
  const shots: PyRow[] = [
    { cue_id: "S1", start_seconds: 0.0, end_seconds: 8.0, subject_action: "S1 walks in." },
    { cue_id: "S2", start_seconds: 8.0, end_seconds: 16.0, subject_action: "S1 presses on." },
    { cue_id: "S3", start_seconds: 16.0, end_seconds: 30.0, subject_action: "S2 answers." },
  ];
  const speech_rows: PyRow[] = [
    { content_role: "dialogue", start_seconds: 1.0, end_seconds: 4.0, speaker: "S1" },
    { content_role: "dialogue", start_seconds: 16.5, end_seconds: 19.0, speaker: "S2" },
    { content_role: "dialogue", start_seconds: 20.5, end_seconds: 23.0, speaker: "S1" },
  ];
  const rows = plan_long_form_dialogue_segments(0.0, 30.0, { shots, speech_rows });
  // continuous coverage, every unit inside the native window
  assert.equal(rows[0]!.start_seconds, 0.0);
  assert.equal(rows[rows.length - 1]!.end_seconds, 30.0);
  for (const row of rows) {
    assert.ok(row.end_seconds - row.start_seconds <= 15.0 + 1e-6);
  }
  // dialogue-turn alignment inserted a boundary at the 16.5 speaker turn
  assert.ok(
    rows.some((row) => Math.abs(row.start_seconds - 16.5) < 1e-6),
    `expected a cut on the speaker turn, got ${rows.map((r) => r.start_seconds)}`,
  );
  // no cut lands inside any authored utterance
  for (const row of rows.slice(1)) {
    for (const line of speech_rows) {
      const s = line.start_seconds as number;
      const e = line.end_seconds as number;
      assert.ok(!(row.start_seconds > s + 1e-6 && row.start_seconds < e - 1e-6));
    }
  }
});

test("plan_long_form_dialogue_segments keeps a named technique whole", () => {
  const shots: PyRow[] = [
    { cue_id: "S1", start_seconds: 0.0, end_seconds: 8.0, subject_action: "S1 advances." },
    { cue_id: "S2", start_seconds: 8.0, end_seconds: 20.0, subject_action: "S1 ultimate finisher." },
  ];
  const rows = plan_long_form_dialogue_segments(0.0, 20.0, { shots });
  const atomic = rows.find(
    (row) => row.start_seconds === 8.0 && row.end_seconds === 20.0,
  );
  assert.ok(atomic, `atomic shot not whole: ${rows.map((r) => `${r.start_seconds}-${r.end_seconds}`)}`);
});
