/**
 * Combat adapter — the typed boundary between slatecrew's CallSheet and the
 * ported engine (combat-action.ts / combat-presets.ts).
 *
 * Laws this layer holds:
 *  - The combat pass NEVER rewrites packet-authored slate fields (shot.action,
 *    require.*) — repairs the Python engine would apply live are surfaced as
 *    ACTION_RISK events + receipt rows instead. Stills/QC contracts untouched.
 *  - The pass only runs on a combat signal (≥2 marked characters AND a combat
 *    cause in the action text — the source's own `_has_combat_cause`
 *    predicate). Non-combat slates take a different branch and stay
 *    byte-identical.
 *  - The engine speaks S1/S2; slatecrew speaks character names. The adapter
 *    maps names→S1/S2 on the way in and S1/S2→names on the prose lines out.
 */

import fs from "node:fs";
import type { CallSheet, Shot } from "./types";
import { jobFile } from "./paths";
import { action_risk, reconcile_combat_action_rows, type PyRow } from "./combat-action";
import { environmentRelay, hasCombatCause, type EnvironmentRelayState } from "./combat-environment";
import {
  CONSTRAINT_PRESETS,
  SOUNDSCAPE_PRESETS,
  TRANSITION_STYLE_PRESETS,
} from "./combat-presets";

export { hasCombatCause };
export type CombatEnvironmentState = EnvironmentRelayState;

/** The sheet-level combat signal (foreman condition ②): a shot with at least
 *  two marked characters whose authored action carries a combat cause. */
export function detectCombat(sheet: CallSheet): boolean {
  return sheet.shots.some((shot) => {
    const cast = new Set(shot.marks.map((m) => m.characterId));
    return cast.size >= 2 && hasCombatCause(shot.require?.action ?? shot.action);
  });
}

export type CombatCamera = {
  sector: string;
  motion_relation: string;
  action_trigger: string;
  direction: string;
};

export type CombatShotState = {
  schema_version: number;
  /** labelled two-beat chain with time tags — the engine's executable action */
  action_chain: string;
  /** structured beats, each carrying the seven required columns */
  beats: PyRow[];
  carrier: string;
  story_duty: { index: number; name: string; instruction: string };
  incoming_state: string;
  outgoing_state: string;
  next_trigger: string;
  event_causality_chain: string;
  camera: CombatCamera;
  continuity_status: string;
  validation: { status: string; issues: string[]; inherited_fields: string[] };
  /** ACTION_RISK — causal issues the silent validator surfaced */
  risk: { status: string; flags: string[] };
  /** name↔S1/S2 map for prose rendering (screen-left fighter is S1) */
  actors: { s1: string; s2: string };
  /** environment inheritance (S4): bounded persistent-damage ledger relay */
  environment: CombatEnvironmentState;
  final: { action_resolution: string; camera_resolution: string; stable: boolean };
};

export type CombatSummary = {
  applied: boolean;
  skill: "two-fighter-combat";
  combatShots: string[];
  incompatibleShots: { id: string; reason: string }[];
  riskShots: { id: string; status: string; flags: string[] }[];
  relayBreaks: { id: string; inherited: number }[];
};

function textOf(shot: Shot): string {
  return String(shot.require?.action ?? shot.action ?? "");
}

function markedCast(shot: Shot): { id: string; x: number }[] {
  return [...new Set(shot.marks.map((m) => m.characterId))].map((id) => ({
    id,
    x: Math.min(...shot.marks.filter((m) => m.characterId === id).map((m) => m.start.x)),
  }));
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function nameToEngine(text: string, s1: string, s2: string): string {
  // Replace longest name first so an overlapping pair (阿強 vs 強) substitutes
  // cleanly — but each name keeps ITS OWN token: s1→S1, s2→S2. The sort orders
  // substitution, never roles: with unequal-length names it used to bind the
  // longer name to S2 and silently swap the fighters.
  const pairs = ([["S1", s1], ["S2", s2]] as const).filter(([, name]) => name.length > 0)
    .sort((a, b) => b[1].length - a[1].length);
  let acc = text;
  for (const [token, name] of pairs) {
    acc = acc.replace(new RegExp(escapeRe(name), "g"), token);
  }
  return acc;
}

function engineToName(text: string, s1: string, s2: string): string {
  return text.replace(/\bS1\b/g, s1).replace(/\bS2\b/g, s2);
}

function short(text: string, limit: number): string {
  const collapsed = text.split(/\s+/).filter(Boolean).join(" ");
  if (collapsed.length <= limit) return collapsed;
  return `${collapsed.slice(0, limit - 1).replace(/[\s,;:]+$/, "")}…`;
}

export type CombatPassResult = { sheet: CallSheet; summary: CombatSummary };

/** Attach typed combat state to every combat shot of a sheet (pure over the
 *  packet fields; never writes shot.action / require). */
export function applyCombatToSheet(sheet: CallSheet): CombatPassResult {
  const summary: CombatSummary = {
    applied: false,
    skill: "two-fighter-combat",
    combatShots: [],
    incompatibleShots: [],
    riskShots: [],
    relayBreaks: [],
  };
  if (!detectCombat(sheet)) return { sheet, summary };

  // cumulative authored clocks — the engine needs ordering + durations
  let clock = 0;
  const timed = sheet.shots.map((shot) => {
    const start = clock;
    clock += Math.max(0.05, shot.durationSec);
    return { shot, start, end: clock };
  });
  const total = clock || Math.max(0.5, sheet.durationSec);

  const engineRows: PyRow[] = [];
  const mapping: { shot: Shot; s1: string; s2: string }[] = [];
  for (const { shot, start, end } of timed) {
    const cast = markedCast(shot).sort((a, b) => a.x - b.x);
    const isCombat = new Set(shot.marks.map((m) => m.characterId)).size >= 2 && hasCombatCause(textOf(shot));
    if (!isCombat) continue;
    if (cast.length !== 2) {
      summary.incompatibleShots.push({
        id: shot.id,
        reason: `combat shot has ${cast.length} marked characters — the engine is two-fighter`,
      });
      continue;
    }
    const s1 = sheet.characters.find((c) => c.id === cast[0]!.id)?.name ?? cast[0]!.id;
    const s2 = sheet.characters.find((c) => c.id === cast[1]!.id)?.name ?? cast[1]!.id;
    mapping.push({ shot, s1, s2 });
    engineRows.push({
      id: shot.id,
      start_seconds: start,
      end_seconds: end,
      subject_action: nameToEngine(textOf(shot), s1, s2),
    });
  }
  if (engineRows.length === 0) return { sheet, summary };

  const [rows] = reconcile_combat_action_rows(engineRows, total);
  summary.applied = true;

  // environment inheritance (S4): relay the bounded persistent-damage ledger
  // over each contiguous same-location run — a location change starts a fresh
  // ledger (new place, new fixtures). Location truth order follows the
  // scene-slot law: require.location ?? shot.location, sheet tail last.
  const locationOf = (shot: Shot): string =>
    (shot.require?.location ?? shot.location ?? sheet.location).trim();
  const envStates: EnvironmentRelayState[] = [];
  for (let i = 0; i < mapping.length; ) {
    const location = locationOf(mapping[i]!.shot);
    let j = i;
    while (j < mapping.length && locationOf(mapping[j]!.shot) === location) j++;
    const run = mapping.slice(i, j);
    const states = environmentRelay(
      run.map((m, k) => {
        const row = rows[i + k]!;
        const beats = (row.combat_action_beats as PyRow[] | undefined) ?? [];
        return {
          shotId: m.shot.id,
          action: String(row.subject_action ?? ""),
          actor: String(beats[0]?.attacker ?? "S1"),
          forceVector: { ...((row.combat_force_vector as PyRow | undefined) ?? {}) },
        };
      }),
      { location },
    );
    envStates.push(...states);
    i = j;
  }

  rows.forEach((row, i) => {
    const { shot, s1, s2 } = mapping[i]!;
    const risk = action_risk(row);
    const inherited = (row.causal_validation_inherited_fields as string[] | undefined) ?? [];
    const state: CombatShotState = {
      schema_version: Number(row.combat_action_schema_version ?? 0),
      action_chain: engineToName(String(row.combat_action_chain ?? ""), s1, s2),
      beats: (row.combat_action_beats as PyRow[] | undefined) ?? [],
      carrier: String(row.combat_action_carrier ?? ""),
      story_duty: {
        index: Number(row.combat_story_duty_index ?? 0),
        name: String(row.combat_story_duty ?? ""),
        instruction: String(row.combat_story_duty_instruction ?? ""),
      },
      incoming_state: engineToName(String(row.incoming_combat_state ?? ""), s1, s2),
      outgoing_state: engineToName(String(row.outgoing_combat_state ?? ""), s1, s2),
      next_trigger: engineToName(String(row.next_action_trigger ?? ""), s1, s2),
      event_causality_chain: engineToName(String(row.event_causality_chain ?? ""), s1, s2),
      camera: {
        sector: String(row.camera_position_sector ?? ""),
        motion_relation: String(row.camera_motion_relation ?? ""),
        action_trigger: engineToName(String(row.camera_action_trigger ?? ""), s1, s2),
        direction: engineToName(String(row.dynamic_camera_direction ?? ""), s1, s2),
      },
      continuity_status: String(row.combat_continuity_status ?? ""),
      validation: {
        status: String(row.causal_validation_status ?? ""),
        issues: (row.causal_validation_issues as string[] | undefined) ?? [],
        inherited_fields: inherited,
      },
      risk,
      actors: { s1, s2 },
      environment: {
        ...envStates[i]!,
        interaction: engineToName(envStates[i]!.interaction, s1, s2),
      },
      final: {
        action_resolution: engineToName(String(row.final_action_resolution ?? ""), s1, s2),
        camera_resolution: engineToName(String(row.final_camera_resolution ?? ""), s1, s2),
        stable: Boolean(row.final_action_stable),
      },
    };
    shot.combat = state;
    summary.combatShots.push(shot.id);
    if (risk.flags.length > 0) {
      summary.riskShots.push({ id: shot.id, status: risk.status, flags: risk.flags });
    }
    if (i > 0 && inherited.length < 4) {
      summary.relayBreaks.push({ id: shot.id, inherited: inherited.length });
    }
  });
  return { sheet, summary };
}

// ---- prose flag layer (S3) --------------------------------------------------

export type CombatLineKind = "constraint" | "relay" | "transition" | "environment" | "soundscape";

export type CombatProseLine = {
  line: string;
  kind: CombatLineKind;
};

const SOUNDSCAPE_BY_WEATHER: Partial<Record<CallSheet["weather"], string>> = {
  rain: "Rain",
  wind: "Natural Outdoor",
  neon: "Urban Night",
};

/** The combat paragraph lines, priority-ordered (Physical Contact first — the
 *  card law — then the causal relay, motion constraints, the momentum-carry
 *  cut, the soundscape bed). The prose builder takes them while the T42
 *  identity-long budget (150–300 詞) holds; first line that does not fit ends
 *  the paragraph. All constraint/transition/soundscape text rides verbatim
 *  from the ported preset registry. */
export function combatProseSpec(sheet: CallSheet, shot: Shot, prev?: Shot): CombatProseLine[] {
  const combat = shot.combat;
  if (!combat) return [];
  const lines: CombatProseLine[] = [
    { kind: "constraint", line: CONSTRAINT_PRESETS["Physical Contact"]! },
    {
      kind: "relay",
      line:
        `The fight state carries across the cut: ${short(combat.incoming_state, 110)} ` +
        `resolves into ${short(combat.outgoing_state, 110)}; ${short(combat.next_trigger, 90)}`,
    },
  ];
  if (combat.carrier === "throw_takedown" || combat.carrier === "ground_control") {
    lines.push({ kind: "constraint", line: CONSTRAINT_PRESETS["Motion Discipline"]! });
    lines.push({ kind: "constraint", line: CONSTRAINT_PRESETS["Anatomy Lock"]! });
  } else {
    lines.push({ kind: "constraint", line: CONSTRAINT_PRESETS["Motion Discipline"]! });
  }
  if (prev?.combat) {
    // momentum carry across the shot boundary — the Match-on-Action preset
    lines.push({ kind: "transition", line: TRANSITION_STYLE_PRESETS["Match-on-Action"]! });
  }
  if (combat.environment && combat.environment.persistent.length > 0) {
    // S4: damage persistence — displaced/dented/broken state never resets
    lines.push({
      kind: "environment",
      line: `Earlier contact consequences persist unchanged into this shot: ${short(combat.environment.persistent.slice(-2).join("; "), 200)}`,
    });
  }
  const soundscape = SOUNDSCAPE_BY_WEATHER[sheet.weather];
  if (soundscape) {
    lines.push({ kind: "soundscape", line: SOUNDSCAPE_PRESETS[soundscape]! });
  }
  return lines;
}

// ---- pipeline hook (foreman conditions ②③) ----------------------------------

export type CombatEmit = (event: {
  agent: "boards";
  level: "info" | "warn" | "pass";
  message: string;
  data?: Record<string, unknown>;
  step_id?: string;
  parent_steps?: string[];
  seat?: string;
}) => void;

/** The boards-stage combat pass: attach combat state (combat-signal gated),
 *  emit ACTION_RISK events, write the combat receipt. Pure no-op on sheets
 *  without a combat signal — the non-combat pipeline path never branches. */
export function applyCombatPass(
  jobId: string,
  sheet: CallSheet,
  emit: CombatEmit,
): CombatPassResult {
  if (!detectCombat(sheet)) return { sheet, summary: emptySummary() };
  const { sheet: withCombat, summary } = applyCombatToSheet(sheet);
  for (const risk of summary.riskShots) {
    emit({
      agent: "boards",
      level: "warn",
      message: `ACTION_RISK ${risk.id}: ${risk.flags.join("; ")}`,
      data: {
        shot: risk.id,
        stage: "combat",
        eye: "boards",
        verdict: "fail",
        proof: "combat/combat-pass.json",
        flags: risk.flags,
      },
      step_id: "combat-pass",
      parent_steps: ["boards"],
      seat: "boards",
    });
  }
  for (const incompatible of summary.incompatibleShots) {
    emit({
      agent: "boards",
      level: "warn",
      message: `ACTION_RISK ${incompatible.id}: ${incompatible.reason}`,
      data: {
        shot: incompatible.id,
        stage: "combat",
        eye: "boards",
        verdict: "fail",
        proof: "combat/combat-pass.json",
      },
      step_id: "combat-pass",
      parent_steps: ["boards"],
      seat: "boards",
    });
  }
  emit({
    agent: "boards",
    level: summary.riskShots.length > 0 ? "warn" : "pass",
    message: summary.riskShots.length > 0
      ? `combat pass: ${summary.combatShots.length} fight shots, ${summary.riskShots.length} ACTION_RISK — receipt combat/combat-pass.json`
      : `combat pass: ${summary.combatShots.length} fight shots, causal relay locked — receipt combat/combat-pass.json`,
    data: {
      stage: "combat",
      eye: "boards",
      verdict: summary.riskShots.length > 0 ? "fail" : "pass",
      proof: "combat/combat-pass.json",
      combatShots: summary.combatShots,
      relayBreaks: summary.relayBreaks,
    },
    step_id: "combat-pass",
    parent_steps: ["boards"],
    seat: "boards",
  });
  const receipt = jobFile(jobId, "combat", "combat-pass.json");
  fs.writeFileSync(receipt, JSON.stringify({ summary, slate: jobId }, null, 2));
  return { sheet: withCombat, summary };
}

function emptySummary(): CombatSummary {
  return {
    applied: false,
    skill: "two-fighter-combat",
    combatShots: [],
    incompatibleShots: [],
    riskShots: [],
    relayBreaks: [],
  };
}
