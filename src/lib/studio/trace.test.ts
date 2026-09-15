import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import type { Character, JobEvent, Shot } from "./types";
import type { QcRequire } from "./photo-qc";
import { keyframeEditPrompt, keyframeRequire } from "./keyframe-prompt";
import {
  STEPS,
  VIOLATION_KEYS,
  appendViolation,
  loadTraceFixture,
  readViolations,
  replayTrace,
  rowPasses,
  type FrozenQc,
  type ViolationRow,
} from "./trace";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom.)
 *  Story nouns are read from trace-fixtures/ at runtime — never written in
 *  this source, so the noun-lint stays green over src/. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

type Sh07Fixture = {
  characters: Character[];
  shot: Shot;
  prompt: string;
  require: QcRequire;
  photo_qc: FrozenQc & { fail_reasons: string[] };
};

test("SH07 fixture: soft prop-drift at keyframe-prompt is recorded BEFORE the hard require fail", () => {
  const fx = loadTraceFixture("wist-sh07") as unknown as Sh07Fixture;
  const rows = replayTrace(fx.characters, fx.shot, fx.prompt, fx.require, fx.photo_qc);
  assert.ok(rows.length >= 3, `replay produced ${rows.length} rows`);

  const softIdx = rows.findIndex(
    (r) => r.severity === "soft" && r.step_id === STEPS.keyframePrompt && r.constraint_id === "prop-drift",
  );
  const hardIdx = rows.findIndex((r) => r.severity === "hard" && r.step_id === STEPS.require);
  assert.ok(softIdx >= 0, "soft prop-drift row at keyframe-prompt exists");
  assert.ok(hardIdx >= 0, "hard row at require exists");
  assert.ok(softIdx < hardIdx, `soft (${softIdx}) must precede hard (${hardIdx})`);

  const drift = rows[softIdx] as ViolationRow;
  const saw = drift.saw as { names_missing: string[]; noun_class: string; tool_template: boolean };
  const expected = drift.expected as { names_missing: string[]; noun_class: string; tool_template: boolean };
  assert.equal(saw.noun_class, "garment", "the coat classifies as a garment");
  assert.equal(saw.tool_template, true, "the frozen prompt carries the held-tool template");
  assert.equal(expected.tool_template, false, "a garment prompt must not carry it");
  assert.deepEqual(saw.names_missing, [], "prop name was present — the drift is class, not absence");
  assert.equal(rowPasses(drift), false, "prop-drift is a fail row");

  const hard = rows[hardIdx] as ViolationRow;
  assert.equal(hard.constraint_id, "photo-qc");
  assert.deepEqual(hard.expected, { status: "GREEN" });
  assert.equal(rowPasses(hard), false, "the hard row is a fail row");
});

test("SH07 fixture: every row is exactly the five violation keys — no layer field", () => {
  const fx = loadTraceFixture("wist-sh07") as unknown as Sh07Fixture;
  const rows = replayTrace(fx.characters, fx.shot, fx.prompt, fx.require, fx.photo_qc);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), [...VIOLATION_KEYS].slice().sort(), `${row.constraint_id} keys`);
  }
});

test("SH07 fixture: the require-keys soft row shows a garment carrying a tool gate", () => {
  const fx = loadTraceFixture("wist-sh07") as unknown as Sh07Fixture;
  const rows = replayTrace(fx.characters, fx.shot, fx.prompt, fx.require, fx.photo_qc);
  const reqRow = rows.find((r) => r.constraint_id === "require-keys") as ViolationRow;
  assert.ok(reqRow, "require-keys row exists");
  assert.equal(reqRow.step_id, STEPS.require);
  assert.equal(reqRow.severity, "soft");
  const saw = reqRow.saw as { keys: string[]; people_count_ok: boolean; tool_gate_ok: boolean };
  assert.ok(saw.keys.includes("tool"), "frozen require carried a tool gate");
  assert.equal(saw.tool_gate_ok, false, "tool gate on a garment is not derivable from the prompt");
  assert.equal(saw.people_count_ok, true);
  assert.equal(rowPasses(reqRow), false);
});

test("SH07 replay: violations.jsonl in a job dir preserves topological order", () => {
  const fx = loadTraceFixture("wist-sh07") as unknown as Sh07Fixture;
  const rows = replayTrace(fx.characters, fx.shot, fx.prompt, fx.require, fx.photo_qc);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-trace-"));
  for (const row of rows) appendViolation(dir, row);
  const back = readViolations(dir);
  assert.deepEqual(back, rows, "jsonl round-trip is order- and content-exact");
  const softIdx = back.findIndex((r) => r.severity === "soft" && r.step_id === STEPS.keyframePrompt);
  const hardIdx = back.findIndex((r) => r.severity === "hard" && r.step_id === STEPS.require);
  assert.ok(softIdx >= 0 && hardIdx >= 0 && softIdx < hardIdx, "order holds on disk too");
});

test("SH09 paper fixture: fixed prompt has no 木犁, require has no tool, both soft rows pass", () => {
  const fx = loadTraceFixture("wist-sh09-paper") as unknown as { characters: Character[]; shot: Shot };
  const prompt = keyframeEditPrompt(
    { ...minimalSheet(fx.characters), shots: [fx.shot] },
    fx.shot,
    { first: false },
  );
  const require = keyframeRequire(fx.shot);
  assert.ok(!prompt.includes("木犁"), "card: paper-prop fixture ⇒ no 木犁 in prompt");
  assert.ok(!prompt.includes("犁"), "no plow character at all");
  assert.equal("tool" in require, false, "card: require has no tool");

  const rows = replayTrace(fx.characters, fx.shot, prompt, require);
  assert.ok(rows.length >= 3, "pass rows are written too, not silence");
  assert.equal(rows.some((r) => r.severity === "hard"), false, "no hard row without a QC fail");
  for (const row of rows) {
    assert.equal(rowPasses(row), true, `${row.constraint_id}: saw matches expected`);
  }
});

test("frozen 07JZ and T5MM event slices land for D1b — D1a records, does not judge", () => {
  for (const name of ["07JZ", "T5MM"]) {
    const fx = loadTraceFixture(name) as {
      frozen: boolean;
      kind: string;
      events: JobEvent[];
      context: Record<string, unknown>;
    };
    assert.equal(fx.frozen, true, `${name} is frozen`);
    assert.ok(fx.kind, `${name} has a kind`);
    assert.ok(fx.events.length >= 1, `${name} carries event excerpts`);
    for (const e of fx.events) assert.ok(e.step_id, `${name} events carry step_id`);
    assert.ok(Object.keys(fx.context).length > 0, `${name} carries primitive context fields`);
  }
});

test("JobEvent carries the topology fields through a plain object", () => {
  const e: JobEvent = {
    ts: "2026-09-13T00:00:00.000Z",
    agent: "stills",
    level: "info",
    message: "step-shaped event",
    step_id: STEPS.keyframePrompt,
    parent_steps: [STEPS.boards],
    seat: "stills",
    constraints_checked: ["prop-drift", "cast-drift", "require-keys"],
  };
  assert.equal(e.step_id, "keyframe-prompt");
  assert.deepEqual(e.parent_steps, ["boards"]);
  assert.deepEqual(e.constraints_checked?.sort(), ["cast-drift", "prop-drift", "require-keys"]);
});

/** the SH09 replay needs a sheet only for characters/location lines */
function minimalSheet(characters: Character[]): Parameters<typeof keyframeEditPrompt>[0] {
  return {
    title: "t",
    logline: "l",
    language: "zh-Hant",
    location: "亂葬崗",
    timeOfDay: "dusk",
    weather: "wind",
    mood: "m",
    durationSec: 3,
    aspect: "16:9",
    characters,
    styleBible: { grade: "g", refs: [], stillModel: "u15", motionModel: "h3" },
    shots: [],
    voiceover: "",
  };
}

if (bareBun) {
  // IIFE, not top-level await: tsx transpiles this file as CJS
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
