import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  environment_transition_time,
  environmental_combat_prompt_clause,
  environmentRelay,
  hasCombatCause,
  NEUTRAL_EFFECTS,
} from "./combat-environment";

/** Golden lock: the venue reconcile core deep-equals the real Python
 *  combat_environment_engine (combat-fixtures/python-env-golden.json, generated
 *  read-only from /mnt/ssd/h3studio @ 2bc8c907): location ladder, transition
 *  crossing, explicit authored targets, recovery actions, user-edited
 *  uncaused-interaction warnings, aftermath pass-through, stored force
 *  vectors, the six-entry ledger bound and the prompt clause. */

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "combat-fixtures", "python-env-golden.json"), "utf8"),
) as {
  source: string;
  h3studio_commit: string;
  cases: { name: string; input: Record<string, unknown>; output: unknown }[];
};

// deferred import to avoid a module cycle at load time in the test bundle
// (combat-environment imports combat-action helpers; the adapter imports both)
import { reconcile_environmental_combat_rows } from "./combat-environment";

function shot(index: number, start: number, end: number, action: string, extra: Record<string, unknown> = {}) {
  return { id: `S${index}`, start_seconds: start, end_seconds: end, subject_action: action, ...extra };
}

function dict(result: [Record<string, unknown>[], string[]]) {
  return { rows: result[0], warnings: result[1] };
}

function runCase(name: string): unknown {
  switch (name) {
    case "env_reconcile_indoor_basic":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "S1 launches a low kick at S2. S2 checks the kick."),
         shot(2, 2.5, 5.0, "S2 counters with a rising knee. S1 absorbs it.")], 30.0));
    case "env_reconcile_crossing_threshold":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 26.0, 28.0, "S1 clinches and drives S2 toward the gate."),
         shot(2, 28.0, 31.0, "S2 pivots out and both cross into the alley."),
         shot(3, 31.0, 34.0, "S1 slips on the wet concrete and recovers guard.")], 45.0));
    case "env_reconcile_explicit_targets":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "S1 slams S2 into the stacked wet produce crates."),
         shot(2, 2.5, 5.0, "S2 stumbles back into the shallow puddle."),
         shot(3, 5.0, 7.5, "S1 drives S2 into the fish tank support frame."),
         shot(4, 7.5, 10.0, "S2 ducks under the hanging scale and counters.")], 30.0));
    case "env_reconcile_recovery_action":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "S2 releases the wrist and both recover to a guarded base.")], 30.0));
    case "env_reconcile_user_edited_uncaused":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "Both fighters circle slowly.", {
          environment_interaction_user_edited: true,
          environment_interaction: "a crate explodes for no reason",
        })], 30.0));
    case "env_reconcile_aftermath_only":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "Wind carries fine grit through the final frame.")], 30.0));
    case "env_reconcile_stored_force_vector":
      return dict(reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "S1 drives a palm strike into S2.", {
          combat_force_vector: {
            horizontal: "screen-left", vertical: "downward",
            depth: "forward", magnitude: "heavy",
            label: "screen-left, downward, forward",
          },
        })], 30.0));
    case "env_ledger_bounds_at_six": {
      const rows = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
        shot(i + 1, i * 2.5, (i + 1) * 2.5,
          `S${i % 2 + 1} drives a takedown into S${i % 2 + 1} near the stalls.`));
      return dict(reconcile_environmental_combat_rows(rows, 30.0, { transition_basis_seconds: 30.0 }));
    }
    case "env_transition_time_unit":
      return { transitions: [45.0, 30.0, 5.0, 0.5].map((d) => environment_transition_time(d)) };
    case "env_prompt_clause": {
      const [rows] = reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "S1 launches a low kick at S2. S2 checks the kick.")], 30.0);
      return {
        clause_with_contract: environmental_combat_prompt_clause(rows![0]),
        clause_without_contract: environmental_combat_prompt_clause(rows![0], { include_global_contract: false }),
        clause_plain_row: environmental_combat_prompt_clause({ id: "S9" }),
      };
    }
    default:
      throw new Error(`no TS runner for env golden case ${name}`);
  }
}

test("golden: the env port deep-equals the real Python engine on every frozen case", () => {
  assert.ok(GOLDEN.cases.length >= 10, `expected >= 10 env golden cases, got ${GOLDEN.cases.length}`);
  for (const fixtureCase of GOLDEN.cases) {
    assert.deepStrictEqual(
      runCase(fixtureCase.name),
      fixtureCase.output,
      `env golden case ${fixtureCase.name} diverged from python-env-golden.json`,
    );
  }
});

test("golden env provenance is pinned to the h3studio commit", () => {
  assert.equal(GOLDEN.source, "combat_environment_engine.py");
  assert.match(GOLDEN.h3studio_commit, /^2bc8c907/);
});

// ---- the neutral relay (slatecrew path) --------------------------------------

const FORCE = { horizontal: "screen-right", vertical: "level", depth: "forward", magnitude: "medium", label: "screen-right, level, forward" };

test("environmentRelay: damage persists shot to shot and never resets", () => {
  const states = environmentRelay(
    [
      { shotId: "SH01", action: "S1 punches S2 beside the crates", actor: "S1", forceVector: FORCE },
      { shotId: "SH02", action: "S2 counters with an elbow into the wall", actor: "S2", forceVector: FORCE },
    ],
    { location: "後巷" },
  );
  assert.equal(states[0]!.persistent.length, 1);
  assert.equal(states[1]!.persistent.length, 2);
  // a light effect with no persistence words adds nothing (source law)
  const lightOnly = environmentRelay(
    [
      { shotId: "SH01", action: "S1 punches S2", actor: "S1", forceVector: FORCE },
      { shotId: "SH02", action: "S2 counters with an elbow", actor: "S2", forceVector: FORCE },
    ],
    { location: "後巷" },
  );
  assert.equal(lightOnly[1]!.persistent.length, lightOnly[0]!.persistent.length);
  // the ledger is bounded at six (the source bound) — a custom pack of eight
  // persist-capable rows proves the cap; identical update text dedupes (source law)
  const pack = Array.from({ length: 8 }, (_, i) => ({
    target: `distinct fixture ${i}`, primary: `it deforms at contact ${i}`,
    secondary: `loose parts shift ${i}`, damage: "medium" as const,
  }));
  const many = environmentRelay(
    Array.from({ length: 9 }, (_, i) => ({
      shotId: `SH${i}`, action: `S${i % 2 + 1} drives a takedown`, actor: "S1", forceVector: FORCE,
    })),
    { location: "後巷", effects: pack },
  );
  assert.equal(many[8]!.persistent.length, 6, "ledger caps at six entries");
  assert.ok(many[8]!.outgoing_state.includes("all earlier tracked changes also persist"));
});

test("environmentRelay: no authored cause = no new damage, state passes through", () => {
  const states = environmentRelay(
    [
      { shotId: "SH01", action: "S1 punches S2 beside the crates", actor: "S1", forceVector: FORCE },
      { shotId: "SH02", action: "wind carries dust through the frame", actor: "S1", forceVector: FORCE },
    ],
    { location: "後巷" },
  );
  assert.equal(states[1]!.interaction, "");
  assert.equal(states[1]!.contact_material, "");
  assert.equal(states[1]!.persistent.length, 1, "aftermath shot adds nothing to the ledger");
  assert.equal(states[1]!.incoming_state, states[1]!.outgoing_state);
});

test("environmentRelay: authored target tokens win over rotation", () => {
  const states = environmentRelay(
    [{ shotId: "SH01", action: "S1 slams S2 into the wall", actor: "S1", forceVector: FORCE }],
    { location: "後巷" },
  );
  assert.ok(states[0]!.interaction.includes("the nearest wall or panel surface"));
  assert.ok(states[0]!.interaction.includes("aged_metal"));
});

test("neutral pack shape: six rows, same four-field shape as the source tables", () => {
  assert.equal(NEUTRAL_EFFECTS.length, 6);
  for (const row of NEUTRAL_EFFECTS) {
    for (const field of ["target", "primary", "secondary", "damage"] as const) {
      assert.ok(row[field], `neutral effect row lacks ${field}`);
    }
  }
});

test("hasCombatCause re-export stays the source predicate", () => {
  assert.ok(hasCombatCause("S1 blocks the strike"));
  assert.ok(!hasCombatCause("they stand and talk"));
});
