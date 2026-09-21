"""Regenerate combat-fixtures/python-golden.json from the real h3studio engine.

Read-only against /mnt/ssd/h3studio: imports the module, never writes there.
The TS port (src/lib/studio/combat-action.ts) must deep-equal every case.

Run:  python3 verify/combat/gen-golden.py   (from the repo root)
"""

import json
import sys
from pathlib import Path

H3STUDIO = "/mnt/ssd/h3studio"
sys.path.insert(0, H3STUDIO)

import combat_action_engine as cae  # noqa: E402


def shot(index, start, end, action, **extra):
    row = {
        "id": f"S{index}",
        "start_seconds": start,
        "end_seconds": end,
        "subject_action": action,
    }
    row.update(extra)
    return row


def media(mid, summary, **extra):
    row = {
        "media_id": mid,
        "media_type": "image",
        "loaded": True,
        "raw_analysis_summary": summary,
    }
    row.update(extra)
    return row


cases = []


def tuple2dict(result):
    rows, warnings = result
    return {"rows": rows, "warnings": warnings}


def case(name, input_spec, fn):
    output = fn()
    cases.append({"name": name, "input": input_spec, "output": output})


KICK = "S1 launches a low kick at S2. S2 checks the kick and pivots outside."

# --- reconcile_combat_action_rows: the heart of S2 -------------------------

case(
    "reconcile_kick6",
    {"duration_seconds": 15.0,
     "rows": [shot(i + 1, i * 2.5, (i + 1) * 2.5, KICK) for i in range(6)]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(i + 1, i * 2.5, (i + 1) * 2.5, KICK) for i in range(6)], 15.0)),
)

case(
    "reconcile_self_defence_fix",
    {"duration_seconds": 2.5,
     "rows": [shot(1, 0, 2.5, "S2 kicks toward S1. S2 parries and pivots away.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S2 kicks toward S1. S2 parries and pivots away.")], 2.5)),
)

case(
    "reconcile_ground_reversal",
    {"duration_seconds": 5.0,
     "rows": [shot(1, 0, 2.5, "S2 captures S1's single leg. S1 sprawls and frames."),
              shot(2, 2.5, 5.0, "S1 establishes side control. S2 frames from below.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S2 captures S1's single leg. S1 sprawls and frames."),
         shot(2, 2.5, 5.0, "S1 establishes side control. S2 frames from below.")], 5.0)),
)

case(
    "reconcile_repeat_generated",
    {"duration_seconds": 5.0,
     "rows": [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
              shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
         shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.")], 5.0)),
)

case(
    "reconcile_repeat_user_edited",
    {"duration_seconds": 5.0,
     "rows": [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
              shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.",
                   combat_action_chain_user_edited=True)]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters."),
         shot(2, 2.5, 5.0, "S1 attacks S2. S2 blocks and counters.",
              combat_action_chain_user_edited=True)], 5.0)),
)

case(
    "reconcile_outcome_only",
    {"duration_seconds": 2.0,
     "rows": [shot(1, 0, 2.0,
                   "S1 maintains close range. S2 lands on his back; S1 stands over him.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.0,
              "S1 maintains close range. S2 lands on his back; S1 stands over him.")], 2.0)),
)

case(
    "reconcile_sword_generated",
    {"duration_seconds": 3.0,
     "rows": [shot(1, 0, 3.0, "S1 swings a sword at S2. S2 blocks the blade.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 3.0, "S1 swings a sword at S2. S2 blocks the blade.")], 3.0)),
)

case(
    "reconcile_sword_user_edited",
    {"duration_seconds": 3.0,
     "rows": [shot(1, 0, 3.0, "S1 swings a sword at S2. S2 blocks the blade.",
                   combat_action_chain_user_edited=True)]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 3.0, "S1 swings a sword at S2. S2 blocks the blade.",
              combat_action_chain_user_edited=True)], 3.0)),
)

case(
    "reconcile_generic_pose",
    {"duration_seconds": 5.0,
     "rows": [shot(1, 0, 2.5, "S1 looks directly at S2 and raises his right fist."),
              shot(2, 2.5, 5.0,
                   "S1 and S2 execute an immediate full-speed attack and defence exchange.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 looks directly at S2 and raises his right fist."),
         shot(2, 2.5, 5.0,
              "S1 and S2 execute an immediate full-speed attack and defence exchange.")], 5.0)),
)

case(
    "reconcile_empty_action",
    {"duration_seconds": 2.5, "rows": [shot(1, 0, 2.5, "")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows([shot(1, 0, 2.5, "")], 2.5)),
)

case(
    "reconcile_single_beat",
    {"duration_seconds": 2.5, "rows": [shot(1, 0, 2.5, "S1 fires one straight palm.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 fires one straight palm.")], 2.5)),
)

case(
    "reconcile_final_settle",
    {"duration_seconds": 5.0,
     "rows": [shot(1, 0, 2.5, "S1 kicks toward S2. S2 checks and circles outside."),
              shot(2, 2.5, 5.0, "S2 sweeps S1. S1 braces and completes the fall.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, "S1 kicks toward S2. S2 checks and circles outside."),
         shot(2, 2.5, 5.0, "S2 sweeps S1. S1 braces and completes the fall.")], 5.0)),
)

case(
    "reconcile_aftermath_only_passes_through",
    {"duration_seconds": 5.0,
     "rows": [shot(1, 0, 2.5, KICK),
              shot(2, 2.5, 5.0,
                   "Final settle: dust settles, no new attack, both hold a stable guarded stance.")]},
    lambda: tuple2dict(cae.reconcile_combat_action_rows(
        [shot(1, 0, 2.5, KICK),
         shot(2, 2.5, 5.0,
              "Final settle: dust settles, no new attack, both hold a stable guarded stance.")],
        5.0)),
)

# --- reconcile_final_combat_markers ----------------------------------------

case(
    "markers_reanchor",
    {"markers": [{"time_seconds": 29.0, "preset": "Ending Hold",
                  "direction": "Old pre-extension ending."}],
     "duration_seconds": 41.5},
    lambda: cae.reconcile_final_combat_markers(
        [{"time_seconds": 29.0, "preset": "Ending Hold",
          "direction": "Old pre-extension ending."}], 41.5),
)

case(
    "markers_empty_adds_final",
    {"markers": [], "duration_seconds": 5.0},
    lambda: cae.reconcile_final_combat_markers([], 5.0),
)

# --- build_combat_fact_ledger + context ------------------------------------

case(
    "fact_ledger_street",
    {"plan": {"existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}]},
     "media": [media("P1", "BLIP · Overview: woman in white shirt"),
               media("P2", "BLIP · Overview: man in red jacket")],
     "authored_requirement": "S1 is the karate fighter; S2 is the judo fighter."},
    lambda: {
        "ledger": cae.build_combat_fact_ledger(
            {"existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}]},
            [media("P1", "BLIP · Overview: woman in white shirt"),
             media("P2", "BLIP · Overview: man in red jacket")],
            authored_requirement="S1 is the karate fighter; S2 is the judo fighter."),
    },
)

case(
    "fact_ledger_hk_comic",
    {"plan": {"existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}]},
     "media": [media("P1", "BLIP · Overview: one comic page containing both fighters on a mountain"),
               media("P2", "BLIP · Overview: the same two fighters collide")],
     "authored_requirement": "神武不死与龙界使用无界紫电拳和极霸之拳。"},
    lambda: {
        "ledger": cae.build_combat_fact_ledger(
            {"existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}]},
            [media("P1", "BLIP · Overview: one comic page containing both fighters on a mountain"),
             media("P2", "BLIP · Overview: the same two fighters collide")],
            authored_requirement="神武不死与龙界使用无界紫电拳和极霸之拳。",
            special_skill_key=cae.HONG_KONG_COMIC_FIGHTER_SKILL),
    },
)


def ledger_context_output():
    ledger = cae.build_combat_fact_ledger(
        {"existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}]},
        [media("P1", "BLIP · Overview: woman in white shirt"),
         media("P2", "BLIP · Overview: man in red jacket")],
        authored_requirement="S1 is the karate fighter; S2 is the judo fighter.",
    )
    return {"context": cae.combat_fact_prompt_context(ledger)}


case(
    "fact_context_compact",
    {"plan": {"existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}]},
     "media": [media("P1", "BLIP · Overview: woman in white shirt"),
               media("P2", "BLIP · Overview: man in red jacket")],
     "authored_requirement": "S1 is the karate fighter; S2 is the judo fighter."},
    ledger_context_output,
)

# --- apply_combat_action_continuity (full plan level) -----------------------

def apply_street_plan():
    return {
        "duration_seconds": 15.0,
        "constraints": "",
        "design_warnings": [],
        "shots": [shot(i + 1, i * 2.5, (i + 1) * 2.5, KICK) for i in range(6)],
        "existing_media_uses": [{"media_id": "P1"}, {"media_id": "P2"}],
        "markers": [],
    }


case(
    "apply_street_full",
    {"special_skill_key": "street-fighter-live-action-h3",
     "media": [media("P1", "BLIP · Overview: woman in white shirt"),
               media("P2", "BLIP · Overview: man in red jacket")],
     "authored_requirement": "one clean fight in the market",
     "plan": apply_street_plan()},
    lambda: cae.apply_combat_action_continuity(
        apply_street_plan(),
        special_skill_key="street-fighter-live-action-h3",
        existing_media=[media("P1", "BLIP · Overview: woman in white shirt"),
                        media("P2", "BLIP · Overview: man in red jacket")],
        authored_requirement="one clean fight in the market"),
)

case(
    "apply_other_skill_unchanged",
    {"special_skill_key": "dark-rescue-h3",
     "plan": {"duration_seconds": 5.0, "shots": [shot(1, 0, 5, "S1 looks at S2.")]}},
    lambda: cae.apply_combat_action_continuity(
        {"duration_seconds": 5.0, "shots": [shot(1, 0, 5, "S1 looks at S2.")]},
        special_skill_key="dark-rescue-h3",
    ),
)


def apply_tail_plan():
    return {
        "duration_seconds": 17.0,
        "_speech_timing_base_duration": 15.0,
        "constraints": "",
        "design_warnings": [],
        "shots": [
            shot(1, 0, 7.5, "S1 drives a palm toward S2. S2 parries and shifts right."),
            shot(2, 7.5, 15.0, "S2 sweeps S1. S1 braces and completes the fall."),
            shot(3, 15.0, 17.0, "Wind carries fine grit through the final frame."),
        ],
        "markers": [],
    }


case(
    "apply_hk_comic_speech_tail",
    {"special_skill_key": "hong-kong-comic-fighter", "plan": apply_tail_plan()},
    lambda: cae.apply_combat_action_continuity(
        apply_tail_plan(),
        special_skill_key=cae.HONG_KONG_COMIC_FIGHTER_SKILL,
    ),
)


def apply_hk_comic_plan():
    return {
        "duration_seconds": 5.0,
        "constraints": "",
        "shots": [{
            **shot(1, 0.0, 5.0, "S2 lands on his back; S1 stands over him."),
            "environment_interaction": (
                "source-visible rocky mountain; stale nearest wet produce crate metadata"),
        }],
    }


case(
    "apply_hk_comic_no_wet_market_inheritance",
    {"special_skill_key": "hong-kong-comic-fighter",
     "media": [media("P1", "BLIP · Overview: both fighters on a mountain"),
               media("P2", "BLIP · Overview: the same two fighters collide")],
     "authored_requirement": "神武不死与龙界使用无界紫电拳和极霸之拳。",
     "plan": apply_hk_comic_plan()},
    lambda: cae.apply_combat_action_continuity(
        apply_hk_comic_plan(),
        special_skill_key=cae.HONG_KONG_COMIC_FIGHTER_SKILL,
        existing_media=[media("P1", "BLIP · Overview: both fighters on a mountain"),
                        media("P2", "BLIP · Overview: the same two fighters collide")],
        authored_requirement="神武不死与龙界使用无界紫电拳和极霸之拳。",
    ),
)

# --- combat_baseline_duration ------------------------------------------------

case(
    "baseline_duration",
    {"plan": {"duration_seconds": 48.5, "_speech_timing_base_duration": 45.0}},
    lambda: {"baseline": cae.combat_baseline_duration(
        {"duration_seconds": 48.5, "_speech_timing_base_duration": 45.0})},
)

# --- prompt clause + compaction ----------------------------------------------


def clause_rows():
    rows, _ = cae.reconcile_combat_action_rows([shot(1, 0, 2.5, "S1 attacks S2. S2 blocks and counters.")], 2.5)
    return rows


case(
    "prompt_clause_state_delta",
    {"row_from": "reconcile('S1 attacks S2. S2 blocks and counters.')"},
    lambda: {"clause": cae.combat_action_prompt_clause(clause_rows()[0])},
)

case(
    "compact_field_removes_engine_lines",
    {"value": ("User-authored close action.\n"
               "[ENV-IN] generated state\n"
               "HONG KONG KOWLOON WET-MARKET ARENA: long global contract. "
               "P1/P2 ABSOLUTE CAST LOCK: another global contract."),
     "global_contracts": [
         "HONG KONG KOWLOON WET-MARKET ARENA: long global contract.",
         "P1/P2 ABSOLUTE CAST LOCK: another global contract."]},
    lambda: {"text": cae.compact_street_fighter_prompt_field(
        "User-authored close action.\n"
        "[ENV-IN] generated state\n"
        "HONG KONG KOWLOON WET-MARKET ARENA: long global contract. "
        "P1/P2 ABSOLUTE CAST LOCK: another global contract.",
        global_contracts=(
            "HONG KONG KOWLOON WET-MARKET ARENA: long global contract.",
            "P1/P2 ABSOLUTE CAST LOCK: another global contract.",
        ))},
)

# --- unit-level pure helpers ---------------------------------------------------

case(
    "carrier_and_force_unit",
    {"values": [
        "S1 drives a double-leg takedown into S2",
        "S1 swings a sword at S2",
        "S1 clinches and underhooks S2",
        "S1 ground-and-pounds from mount",
        "S1 roundhouse kicks S2",
        "S1 jabs at S2",
    ]},
    lambda: {
        "carriers": [cae.route_action_carrier(v)[0] for v in [
            "S1 drives a double-leg takedown into S2",
            "S1 swings a sword at S2",
            "S1 clinches and underhooks S2",
            "S1 ground-and-pounds from mount",
            "S1 roundhouse kicks S2",
            "S1 jabs at S2",
        ]],
        "weapon_warnings": [cae.route_action_carrier("S1 swings a sword at S2")[1]],
        "force_left_down_heavy": cae.infer_force_vector(
            "S1 drives S2 down toward screen-left", actor="S1", carrier="throw_takedown"),
        "force_default_s2": cae.infer_force_vector("S2 nudges the guard", actor="S2", carrier=""),
        "duties": [cae.combat_story_duty(s, s + 2.5) for s in (0.0, 4.0, 16.0, 40.0)],
    },
)


anchor = __import__("subprocess").run(
    ["git", "-C", H3STUDIO, "rev-parse", "HEAD"],
    capture_output=True, text=True, check=True).stdout.strip()

out = Path("src/lib/studio/combat-fixtures/python-golden.json")
out.parent.mkdir(parents=True, exist_ok=True)
out.write_text(json.dumps(
    {"source": "combat_action_engine.py", "h3studio_commit": anchor, "cases": cases},
    ensure_ascii=False, indent=1) + "\n", encoding="utf-8")
print(f"wrote {out} with {len(cases)} cases (h3studio @ {anchor[:8]})")
