"""Regenerate combat-fixtures/python-env-golden.json from the real h3studio engine.

Read-only against /mnt/ssd/h3studio. The TS port (combat-environment.ts) must
deep-equal every case: the venue reconcile core (location ladder, effect
tables, material physics, directional responses, persistent ledger, bounded
state) and the prompt clause.
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, "/mnt/ssd/h3studio")

import combat_environment_engine as cee  # noqa: E402


def shot(index, start, end, action, **extra):
    row = {
        "id": f"S{index}",
        "start_seconds": start,
        "end_seconds": end,
        "subject_action": action,
    }
    row.update(extra)
    return row


cases = []


def case(name, input_spec, fn):
    cases.append({"name": name, "input": input_spec, "output": fn()})


def reconciled(rows, duration, **opts):
    out, warnings = cee.reconcile_environmental_combat_rows(rows, duration, **opts)
    return {"rows": out, "warnings": warnings}


case(
    "env_reconcile_indoor_basic",
    {"duration_seconds": 30.0,
     "rows": [shot(1, 0, 2.5, "S1 launches a low kick at S2. S2 checks the kick."),
              shot(2, 2.5, 5.0, "S2 counters with a rising knee. S1 absorbs it.")]},
    lambda: reconciled(
        [shot(1, 0, 2.5, "S1 launches a low kick at S2. S2 checks the kick."),
         shot(2, 2.5, 5.0, "S2 counters with a rising knee. S1 absorbs it.")], 30.0),
)

case(
    "env_reconcile_crossing_threshold",
    {"duration_seconds": 45.0,
     "rows": [shot(1, 26.0, 28.0, "S1 clinches and drives S2 toward the gate."),
              shot(2, 28.0, 31.0, "S2 pivots out and both cross into the alley."),
              shot(3, 31.0, 34.0, "S1 slips on the wet concrete and recovers guard.")]},
    lambda: reconciled(
        [shot(1, 26.0, 28.0, "S1 clinches and drives S2 toward the gate."),
         shot(2, 28.0, 31.0, "S2 pivots out and both cross into the alley."),
         shot(3, 31.0, 34.0, "S1 slips on the wet concrete and recovers guard.")], 45.0),
)

case(
    "env_reconcile_explicit_targets",
    {"duration_seconds": 30.0,
     "rows": [shot(1, 0, 2.5, "S1 slams S2 into the stacked wet produce crates."),
              shot(2, 2.5, 5.0, "S2 stumbles back into the shallow puddle."),
              shot(3, 5.0, 7.5, "S1 drives S2 into the fish tank support frame."),
              shot(4, 7.5, 10.0, "S2 ducks under the hanging scale and counters.")]},
    lambda: reconciled(
        [shot(1, 0, 2.5, "S1 slams S2 into the stacked wet produce crates."),
         shot(2, 2.5, 5.0, "S2 stumbles back into the shallow puddle."),
         shot(3, 5.0, 7.5, "S1 drives S2 into the fish tank support frame."),
         shot(4, 7.5, 10.0, "S2 ducks under the hanging scale and counters.")], 30.0),
)

case(
    "env_reconcile_recovery_action",
    {"duration_seconds": 30.0,
     "rows": [shot(1, 0, 2.5, "S2 releases the wrist and both recover to a guarded base.")]},
    lambda: reconciled(
        [shot(1, 0, 2.5, "S2 releases the wrist and both recover to a guarded base.")], 30.0),
)

case(
    "env_reconcile_user_edited_uncaused",
    {"duration_seconds": 30.0,
     "rows": [shot(1, 0, 2.5, "Both fighters circle slowly.",
                   environment_interaction_user_edited=True,
                   environment_interaction="a crate explodes for no reason")]},
    lambda: reconciled(
        [shot(1, 0, 2.5, "Both fighters circle slowly.",
              environment_interaction_user_edited=True,
              environment_interaction="a crate explodes for no reason")], 30.0),
)

case(
    "env_reconcile_aftermath_only",
    {"duration_seconds": 30.0,
     "rows": [shot(1, 0, 2.5, "Wind carries fine grit through the final frame.")]},
    lambda: reconciled(
        [shot(1, 0, 2.5, "Wind carries fine grit through the final frame.")], 30.0),
)

case(
    "env_reconcile_stored_force_vector",
    {"duration_seconds": 30.0,
     "rows": [shot(1, 0, 2.5, "S1 drives a palm strike into S2.",
                   combat_force_vector={"horizontal": "screen-left", "vertical": "downward",
                                        "depth": "forward", "magnitude": "heavy",
                                        "label": "screen-left, downward, forward"})]},
    lambda: reconciled(
        [shot(1, 0, 2.5, "S1 drives a palm strike into S2.",
              combat_force_vector={"horizontal": "screen-left", "vertical": "downward",
                                   "depth": "forward", "magnitude": "heavy",
                                   "label": "screen-left, downward, forward"})], 30.0),
)


def ledger_case():
    rows = [
        shot(i + 1, i * 2.5, (i + 1) * 2.5,
             f"S{i % 2 + 1} drives a takedown into S{i % 2 + 1} near the stalls.")
        for i in range(8)
    ]
    return reconciled(rows, 30.0, transition_basis_seconds=30.0)


case(
    "env_ledger_bounds_at_six",
    {"duration_seconds": 30.0, "shots": 8},
    ledger_case,
)

case(
    "env_transition_time_unit",
    {"durations": [45.0, 30.0, 5.0, 0.5]},
    lambda: {"transitions": [cee.environment_transition_time(d) for d in (45.0, 30.0, 5.0, 0.5)]},
)


def clause_case():
    rows, _ = cee.reconcile_environmental_combat_rows(
        [shot(1, 0, 2.5, "S1 launches a low kick at S2. S2 checks the kick.")], 30.0)
    return {"clause_with_contract": cee.environmental_combat_prompt_clause(rows[0]),
            "clause_without_contract": cee.environmental_combat_prompt_clause(
                rows[0], include_global_contract=False),
            "clause_plain_row": cee.environmental_combat_prompt_clause({"id": "S9"})}


case(
    "env_prompt_clause",
    {"row_from": "reconcile('S1 launches a low kick at S2. S2 checks the kick.')"},
    clause_case,
)

anchor = __import__("subprocess").run(
    ["git", "-C", "/mnt/ssd/h3studio", "rev-parse", "HEAD"],
    capture_output=True, text=True, check=True).stdout.strip()

out = Path("src/lib/studio/combat-fixtures/python-env-golden.json")
out.write_text(json.dumps(
    {"source": "combat_environment_engine.py", "h3studio_commit": anchor, "cases": cases},
    ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {out} with {len(cases)} cases (h3studio @ {anchor[:8]})")
