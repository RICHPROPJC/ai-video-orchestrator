import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  apply_combat_action_continuity,
  build_combat_fact_ledger,
  combat_action_prompt_clause,
  combat_baseline_duration,
  combat_fact_prompt_context,
  combat_story_duty,
  compact_street_fighter_prompt_field,
  infer_force_vector,
  reconcile_combat_action_rows,
  reconcile_final_combat_markers,
  route_action_carrier,
  action_risk,
  type PyRow,
} from "./combat-action";

/**
 * Golden lock: every case in combat-fixtures/python-golden.json was produced
 * by the REAL h3studio Python engine (verify/combat/gen-golden.py, read-only,
 * h3studio @ 2bc8c907). The TS port must deep-equal all of them — drift dies
 * here, not in the render path.
 */

const GOLDEN = JSON.parse(
  fs.readFileSync(path.join(__dirname, "combat-fixtures", "python-golden.json"), "utf8"),
) as {
  source: string;
  h3studio_commit: string;
  cases: { name: string; input: Record<string, unknown>; output: unknown }[];
};

function shot(index: number, start: number, end: number, action: string, extra: PyRow = {}): PyRow {
  return {
    id: `S${index}`,
    start_seconds: start,
    end_seconds: end,
    subject_action: action,
    ...extra,
  };
}

function media(mid: string, summary: string): PyRow {
  return {
    media_id: mid,
    media_type: "image",
    loaded: true,
    raw_analysis_summary: summary,
  };
}

const KICK = "S1 launches a low kick at S2. S2 checks the kick and pivots outside.";
const KICK6 = [0, 1, 2, 3, 4, 5].map((i) => shot(i + 1, i * 2.5, (i + 1) * 2.5, KICK));

function streetPlan(): PyRow {
  return {
    duration_seconds: 15.0,
    constraints: "",
    design_warnings: [],
    shots: KICK6.map((r) => structuredClone(r)),
    existing_media_uses: [{ media_id: "P1" }, { media_id: "P2" }],
    markers: [],
  };
}

function tailPlan(): PyRow {
  return {
    duration_seconds: 17.0,
    _speech_timing_base_duration: 15.0,
    constraints: "",
    design_warnings: [],
    shots: [
      shot(1, 0, 7.5, "S1 drives a palm toward S2. S2 parries and shifts right."),
      shot(2, 7.5, 15.0, "S2 sweeps S1. S1 braces and completes the fall."),
      shot(3, 15.0, 17.0, "Wind carries fine grit through the final frame."),
    ],
    markers: [],
  };
}

function hkComicPlan(): PyRow {
  return {
    duration_seconds: 5.0,
    constraints: "",
    shots: [
      {
        ...shot(1, 0.0, 5.0, "S2 lands on his back; S1 stands over him."),
        environment_interaction:
          "source-visible rocky mountain; stale nearest wet produce crate metadata",
      },
    ],
  };
}

/** Rebuild each frozen input in TS and run it through the port. */
function runCase(name: string): unknown {
  const P1 = media("P1", "BLIP · Overview: woman in white shirt");
  const P2 = media("P2", "BLIP · Overview: man in red jacket");
  switch (name) {
    case "reconcile_kick6":
      return dict(reconcile_combat_action_rows(KICK6.map((r) => structuredClone(r)), 15.0));
    case "reconcile_self_defence_fix":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S2 kicks toward S1. S2 parries and pivots away.")], 2.5));
    case "reconcile_ground_reversal":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S2 captures S1's single leg. S1 sprawls and frames."),
         shot(2, 2.5, 5.0, "S1 establishes side control. S2 frames from below.")], 5.0));
    case "reconcile_repeat_generated":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
         shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.")], 5.0));
    case "reconcile_repeat_user_edited":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
         shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.",
          { combat_action_chain_user_edited: true })], 5.0));
    case "reconcile_outcome_only":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.0,
          "S1 maintains close range. S2 lands on his back; S1 stands over him.")], 2.0));
    case "reconcile_sword_generated":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 3.0, "S1 swings a sword at S2. S2 blocks the blade.")], 3.0));
    case "reconcile_sword_user_edited":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 3.0, "S1 swings a sword at S2. S2 blocks the blade.",
          { combat_action_chain_user_edited: true })], 3.0));
    case "reconcile_generic_pose":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 looks directly at S2 and raises his right fist."),
         shot(2, 2.5, 5.0,
          "S1 and S2 execute an immediate full-speed attack and defence exchange.")], 5.0));
    case "reconcile_empty_action":
      return dict(reconcile_combat_action_rows([shot(1, 0, 2.5, "")], 2.5));
    case "reconcile_single_beat":
      return dict(reconcile_combat_action_rows([shot(1, 0, 2.5, "S1 fires one straight palm.")], 2.5));
    case "reconcile_final_settle":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 kicks toward S2. S2 checks and circles outside."),
         shot(2, 2.5, 5.0, "S2 sweeps S1. S1 braces and completes the fall.")], 5.0));
    case "reconcile_aftermath_only_passes_through":
      return dict(reconcile_combat_action_rows(
        [shot(1, 0, 2.5, KICK),
         shot(2, 2.5, 5.0,
          "Final settle: dust settles, no new attack, both hold a stable guarded stance.")], 5.0));
    case "markers_reanchor":
      return reconcile_final_combat_markers(
        [{ time_seconds: 29.0, preset: "Ending Hold", direction: "Old pre-extension ending." }],
        41.5);
    case "markers_empty_adds_final":
      return reconcile_final_combat_markers([], 5.0);
    case "fact_ledger_street":
      return { ledger: build_combat_fact_ledger(
        { existing_media_uses: [{ media_id: "P1" }, { media_id: "P2" }] },
        [P1, P2],
        { authored_requirement: "S1 is the karate fighter; S2 is the judo fighter." }) };
    case "fact_ledger_hk_comic":
      return { ledger: build_combat_fact_ledger(
        { existing_media_uses: [{ media_id: "P1" }, { media_id: "P2" }] },
        [
          media("P1", "BLIP · Overview: one comic page containing both fighters on a mountain"),
          media("P2", "BLIP · Overview: the same two fighters collide"),
        ],
        {
          authored_requirement: "神武不死与龙界使用无界紫电拳和极霸之拳。",
          special_skill_key: "hong-kong-comic-fighter",
        }) };
    case "fact_context_compact": {
      const ledger = build_combat_fact_ledger(
        { existing_media_uses: [{ media_id: "P1" }, { media_id: "P2" }] },
        [P1, P2],
        { authored_requirement: "S1 is the karate fighter; S2 is the judo fighter." });
      return { context: combat_fact_prompt_context(ledger) };
    }
    case "apply_street_full":
      return apply_combat_action_continuity(streetPlan(), {
        special_skill_key: "street-fighter-live-action-h3",
        existing_media: [P1, P2],
        authored_requirement: "one clean fight in the market",
      });
    case "apply_other_skill_unchanged":
      return apply_combat_action_continuity(
        { duration_seconds: 5.0, shots: [shot(1, 0, 5, "S1 looks at S2.")] },
        { special_skill_key: "dark-rescue-h3" });
    case "apply_hk_comic_speech_tail":
      return apply_combat_action_continuity(tailPlan(), {
        special_skill_key: "hong-kong-comic-fighter",
      });
    case "apply_hk_comic_no_wet_market_inheritance":
      return apply_combat_action_continuity(hkComicPlan(), {
        special_skill_key: "hong-kong-comic-fighter",
        existing_media: [
          media("P1", "BLIP · Overview: both fighters on a mountain"),
          media("P2", "BLIP · Overview: the same two fighters collide"),
        ],
        authored_requirement: "神武不死与龙界使用无界紫电拳和极霸之拳。",
      });
    case "baseline_duration":
      return { baseline: combat_baseline_duration(
        { duration_seconds: 48.5, _speech_timing_base_duration: 45.0 }) };
    case "prompt_clause_state_delta": {
      const [rows] = reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters.")], 2.5);
      return { clause: combat_action_prompt_clause(rows![0]) };
    }
    case "compact_field_removes_engine_lines":
      return { text: compact_street_fighter_prompt_field(
        "User-authored close action.\n" +
        "[ENV-IN] generated state\n" +
        "HONG KONG KOWLOON WET-MARKET ARENA: long global contract. " +
        "P1/P2 ABSOLUTE CAST LOCK: another global contract.",
        { global_contracts: [
          "HONG KONG KOWLOON WET-MARKET ARENA: long global contract.",
          "P1/P2 ABSOLUTE CAST LOCK: another global contract.",
        ] }) };
    case "carrier_and_force_unit": {
      const values = [
        "S1 drives a double-leg takedown into S2",
        "S1 swings a sword at S2",
        "S1 clinches and underhooks S2",
        "S1 ground-and-pounds from mount",
        "S1 roundhouse kicks S2",
        "S1 jabs at S2",
      ];
      return {
        carriers: values.map((v) => route_action_carrier(v)[0]),
        weapon_warnings: [route_action_carrier("S1 swings a sword at S2")[1]],
        force_left_down_heavy: infer_force_vector("S1 drives S2 down toward screen-left", {
          actor: "S1",
          carrier: "throw_takedown",
        }),
        force_default_s2: infer_force_vector("S2 nudges the guard", { actor: "S2", carrier: "" }),
        duties: [0.0, 4.0, 16.0, 40.0].map((s) => combat_story_duty(s, s + 2.5)),
      };
    }
    default:
      throw new Error(`no TS runner for golden case ${name}`);
  }
}

function dict(result: [PyRow[], string[]]): { rows: PyRow[]; warnings: string[] } {
  return { rows: result[0], warnings: result[1] };
}

test("golden: the TS port deep-equals the real Python engine on every frozen case", () => {
  assert.ok(GOLDEN.cases.length >= 26, `expected >= 26 golden cases, got ${GOLDEN.cases.length}`);
  for (const fixtureCase of GOLDEN.cases) {
    const actual = runCase(fixtureCase.name);
    assert.deepStrictEqual(
      actual,
      fixtureCase.output,
      `golden case ${fixtureCase.name} diverged from python-golden.json`,
    );
  }
});

test("golden fixture provenance is pinned to the h3studio commit it was generated from", () => {
  assert.equal(GOLDEN.source, "combat_action_engine.py");
  assert.match(GOLDEN.h3studio_commit, /^2bc8c907/);
});

/** The card's own acceptance shape: a two-shot fight sequence where shot two
 *  inherits the relayed combat state (≥4 of the 6 state fields) and a
 *  defective second shot fires ACTION_RISK instead of a silent pass. */
test("two-shot fight sequence: state relay inheritance and ACTION_RISK trigger", () => {
  const good = reconcile_combat_action_rows(
    [
      shot(1, 0, 2.5, "S1 launches a low kick at S2. S2 checks the kick and pivots outside."),
      shot(2, 2.5, 5.0, "S2 counters with a rising knee. S1 absorbs it on a tight elbow shield."),
    ],
    5.0,
  )[0];
  // relay: shot 2 inherits the exact outgoing state of shot 1 — all six fields
  assert.equal(good[1]!.incoming_combat_state, good[0]!.outgoing_combat_state);
  assert.equal((good[1]!.causal_validation_inherited_fields as string[]).length, 6);
  assert.notEqual(good[1]!.causal_validation_status, "warning");
  assert.equal(action_risk(good[1]).flags.length, 0);
  // every beat carries the seven required columns
  for (const beat of good[1]!.combat_action_beats as PyRow[]) {
    for (const field of [
      "load_weight", "trajectory", "defensive_response", "contact_kind",
      "force_vector", "displacement", "next_trigger",
    ]) {
      assert.ok(beat[field], `beat ${String(beat.beat_id)} lacks ${field}`);
    }
  }

  // defective: a user-owned exact repeat cannot be auto-repaired — it must
  // surface as ACTION_RISK (causal_validation warning), never silently pass
  const defective = reconcile_combat_action_rows(
    [
      shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
      shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.", {
        combat_action_chain_user_edited: true,
      }),
    ],
    5.0,
  )[0];
  const risk = action_risk(defective[1]);
  assert.equal(risk.status, "warning");
  assert.ok(
    risk.flags.some((f) => f.includes("repeats the preceding Shot")),
    `expected repeat flag, got ${JSON.stringify(risk.flags)}`,
  );
  // user-owned choreography stays verbatim — the risk is reported, not rewritten
  assert.equal(defective[1]!.combat_action_chain, undefined);
});
