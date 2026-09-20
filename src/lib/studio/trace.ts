import fs from "node:fs";
import path from "node:path";
import type { Character, Shot } from "./types";
import type { QcRequire } from "./photo-qc";
import { propNounClass, type PropNounClass } from "./keyframe-prompt";

/** A trace is topology, not a chat dump — D1a deterministic half.
 *
 *  Every failed job grows a violations.jsonl under its job dir: one row per
 *  constraint checked, in topological order (boards → keyframe-prompt →
 *  require), so a soft drift upstream is always recorded BEFORE the hard
 *  gate fail it later causes. Rows are written for passing checks too — a
 *  pass is `saw` matching `expected`, not silence. No judge, no diagnosis,
 *  no story nouns in constraint ids: constraints name fields and sets only.
 *
 *  Hard  = the existing zod / require / MARS (photo QC) fails the pipeline
 *          already knows; those emit sites also append a hard row.
 *  Soft  = one edge invariant per consumer edge:
 *            boards→keyframe : sheet prop names + cast survive into the
 *                              prompt with the right noun class (prop-drift).
 *            keyframe→stills: require fields derivable from the prompt —
 *                              garment/document props carry no tool gate.
 *            stills→MARS    : the existing photo QC gate (hard). */

export type ViolationRow = {
  step_id: string;
  constraint_id: string;
  severity: "hard" | "soft";
  saw: unknown;
  expected: unknown;
};

/** exactly these keys, in this shape — never a `layer` field */
export const VIOLATION_KEYS = ["step_id", "constraint_id", "severity", "saw", "expected"] as const;

/** the deterministic step graph D1a records */
export const STEPS = {
  boards: "boards",
  keyframePrompt: "keyframe-prompt",
  require: "require",
} as const;

/** the held-tool sentence's fixed vocabulary (generic class words — the
 *  noun-lint keeps story nouns out of here). A garment or document prompt
 *  carrying any of these is the prop-drift signal. Deliberately narrow:
 *  農具 alone can appear in a legitimate negation, so only the plow-specific
 *  tokens count. */
const TOOL_TEMPLATE_MARKERS = ["木犁", "犁鏵"] as const;

export function violationsPath(dir: string) {
  return path.join(dir, "violations.jsonl");
}

export function appendViolation(dir: string, row: ViolationRow): ViolationRow {
  fs.mkdirSync(dir, { recursive: true });
  fs.appendFileSync(violationsPath(dir), `${JSON.stringify(row)}\n`);
  return row;
}

export function readViolations(dir: string): ViolationRow[] {
  const file = violationsPath(dir);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ViolationRow);
}

/** a passing check is saw deep-equal to expected (same field order both sides) */
export function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function rowPasses(row: ViolationRow): boolean {
  return sameJson(row.saw, row.expected);
}

/** boards→keyframe soft edge: every sheet prop name and every marked cast
 *  member still appears in the keyframe prompt, classified under its own
 *  noun class — a garment (or paper) prop riding the held-tool template is
 *  the SH07/SH09 drift, recorded before any require gate can fail. */
export function checkBoardsToKeyframe(
  characters: Character[],
  shot: Shot,
  prompt: string,
): ViolationRow[] {
  const rows: ViolationRow[] = [];

  const names = (shot.props ?? []).map((p) => p.name);
  const cls: PropNounClass | null = names.length === 1 ? propNounClass(names[0]!) : null;
  const namesMissing = names.filter((n) => !prompt.includes(n));
  const templateOn = TOOL_TEMPLATE_MARKERS.some((m) => prompt.includes(m));
  const driftFields = (names_missing: string[], noun_class: PropNounClass | null, tool_template: boolean) => ({
    names_missing,
    noun_class,
    tool_template,
  });
  const wantTemplate = (c: PropNounClass | null, sawOn: boolean): boolean => {
    if (c === "garment" || c === "document" || c === "system") return false;
    if (c === "tool") return true;
    return sawOn; // no single-class prop on this shot: template presence is not an invariant
  };
  rows.push({
    step_id: STEPS.keyframePrompt,
    constraint_id: "prop-drift",
    severity: "soft",
    saw: driftFields(namesMissing, cls, templateOn),
    expected: driftFields([], cls, wantTemplate(cls, templateOn)),
  });

  const idsOnShot = [...new Set(shot.marks.map((m) => m.characterId))];
  const castMissing = idsOnShot.filter((id) => {
    const hit = characters.find((c) => c.id === id);
    return !hit || !prompt.includes(hit.name);
  });
  const castFields = (missing: string[]) => ({ cast_missing: missing });
  rows.push({
    step_id: STEPS.keyframePrompt,
    constraint_id: "cast-drift",
    severity: "soft",
    saw: castFields(castMissing),
    expected: castFields([]),
  });

  return rows;
}

/** keyframe→stills soft edge: require fields are derivable from the prompt —
 *  people_count matches the marks, and the tool gate exists exactly when the
 *  shot's prop is noun class "tool" or "system" (§0c 系統形象法: the system
 *  光框 carries the prop gate, the judge exempts its screen-family forbid;
 *  garment ⇒ no tool gate; document ⇒ no tool gate — a document is not a held
 *  farm tool). */
export function checkKeyframeToStills(shot: Shot, require: QcRequire): ViolationRow[] {
  const prop = shot.props?.[0];
  const cls: PropNounClass | null = prop ? propNounClass(prop.name) : null;
  const wantTool = cls === "tool" || cls === "system";
  const keys = Object.keys(require).sort();
  // expected keys mirror keyframeRequire exactly — the optional location/
  // action/size fields ride the require whenever the shot carries them, so
  // the expectation must derive them from the shot too (a real SH02 with
  // location+action is not require drift). Sorted both sides like the saw.
  const expectedKeys = [
    "grey_blocks",
    "people_count",
    ...(wantTool ? ["tool", "tool_forbid", "tool_shape"] : []),
    ...(shot.location ? ["location"] : []),
    ...(shot.action ? ["action"] : []),
    ...(shot.size ? ["size"] : []),
  ].sort();
  const toolGateOk = wantTool
    ? require.tool === prop?.name && Array.isArray(require.tool_shape) && Array.isArray(require.tool_forbid)
    : !("tool" in require) && !("tool_shape" in require) && !("tool_forbid" in require);
  const peopleOk = require.people_count === new Set(shot.marks.map((m) => m.characterId)).size;
  const fields = (keys: string[], people_count_ok: boolean, tool_gate_ok: boolean) => ({
    keys,
    people_count_ok,
    tool_gate_ok,
  });
  return [
    {
      step_id: STEPS.require,
      constraint_id: "require-keys",
      severity: "soft",
      saw: fields(keys, peopleOk, toolGateOk),
      expected: fields(expectedKeys, true, true),
    },
  ];
}

/** hard: the photo QC (MARS) gate refused this keyframe */
export function hardPhotoQcRow(constraint_id: string, failReasons: string[]): ViolationRow {
  return {
    step_id: STEPS.require,
    constraint_id,
    severity: "hard",
    saw: { status: "FAIL", fail_reasons: failReasons },
    expected: { status: "GREEN" },
  };
}

/** hard: a zod schema refusal (or any thrown pipeline error) — zod fails are
 *  callsheet-shape fails; everything else lands on the pipeline step. */
export function hardErrorRow(error: unknown): ViolationRow {
  const zod = error instanceof Error && error.name === "ZodError";
  return {
    step_id: zod ? "callsheet" : "pipeline",
    constraint_id: zod ? "zod" : "pipeline",
    severity: "hard",
    saw: error instanceof Error ? error.message : String(error),
    expected: "no throw",
  };
}

export type FrozenQc = { status: "GREEN" | "FAIL"; fail_reasons?: string[] };

/** replay one frozen slice in topological order: soft edge rows first
 *  (keyframe-prompt, then require), the hard photo-QC row last — so the
 *  upstream drift always precedes the gate fail it explains. */
export function replayTrace(
  characters: Character[],
  shot: Shot,
  prompt: string,
  require: QcRequire,
  photoQc?: FrozenQc,
): ViolationRow[] {
  const rows: ViolationRow[] = [
    ...checkBoardsToKeyframe(characters, shot, prompt),
    ...checkKeyframeToStills(shot, require),
  ];
  if (photoQc && photoQc.status === "FAIL") {
    rows.push(hardPhotoQcRow("photo-qc", photoQc.fail_reasons ?? ["not GREEN"]));
  }
  return rows;
}

/** frozen excerpts under src/lib/studio/trace-fixtures/ — story nouns are
 *  allowed there and nowhere else in src (noun-lint skips fixture dirs). */
export function loadTraceFixture(name: string): Record<string, unknown> {
  const file = path.join(__dirname, "trace-fixtures", `${name}.json`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}
