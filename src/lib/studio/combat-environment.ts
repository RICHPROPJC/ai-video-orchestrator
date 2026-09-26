/**
 * Combat environment engine — TypeScript port of h3studio's
 * combat_environment_engine.py (@ 2bc8c907, read-only reference), venue path.
 *
 * Ported (golden-locked to combat-fixtures/python-env-golden.json, generated
 * from the real Python engine): the full venue reconcile core — transition
 * time on the half-second grid, the four-step location ladder, venue effect
 * tables, material physics, directional responses, delayed crowd reaction,
 * the bounded persistent-damage ledger (last 6), incoming/outgoing
 * environment state and the ENV-PHYSICS/ENV-IN/ENV-OUT/LOCATION line protocol.
 *
 * Deliberately NOT ported (out of card scope, logged as outstanding): the
 * reference/comic world-scale power-field path, environment plate media
 * requests, and prompt compaction — those are rendering details tied to H3
 * Studio's comic Skill, not environment state inheritance.
 *
 * NEW (not source): `environmentRelay` + the neutral effect pack — the same
 * relay machinery over a single packet location, so slatecrew sheets (which
 * own their locations) inherit damage state without importing Kowloon venue
 * prose.
 */

import { fmt2, pyRound, type PyRow } from "./combat-action";

export const ENVIRONMENT_PHYSICS_SCHEMA_VERSION = 1;

export const CAUSALITY_CONTRACT =
  "ENVIRONMENTAL COMBAT CAUSALITY: show the fighter action and exact contact first; only then " +
  "show one primary physical response and at most one secondary response. Preserve every " +
  "displaced, dented, leaking, open or broken state in all later shots. No spontaneous damage, " +
  "instant repair, unrelated explosion, reset prop, duplicate fighter or crowd member entering " +
  "the central combat lane.";

// ---- shared predicates (source home: combat_environment_engine.py) ---------

/** Port of the source's `_has_combat_cause` word list — "does this action
 *  carry a visible combat cause". Also re-exported by combat-adapter. */
const COMBAT_CAUSE_WORDS = [
  "punch", "kick", "strike", "parry", "parries", "block", "throw", "takedown", "clinch",
  "grip", "elbow", "forearm", "palm", "sweep", "slam", "drive", "driving", "ground", "bridge",
  "attack", "defence", "defense", "impact", "contact", "exchange", "counter",
  "拳", "踢", "击", "擊", "挡", "擋", "摔", "抱", "抓", "掌", "肘", "扫",
  "掃", "攻", "防", "格斗", "格鬥", "反击", "反擊", "压制", "壓制",
  "submission", "choke", "armbar", "wrist", "grip", "release", "recover",
  "tap", "guarded base", "绞", "絞", "关节", "關節", "腕", "松开", "松開",
  "hip-turn", "hip turn", "redirect", "brace", "latch", "gate",
  "髋转", "髖轉", "转向", "轉向", "支撑", "支撐", "闸门", "閘門",
];

export function hasCombatCause(value: unknown): boolean {
  const text = String(value ?? "").toLowerCase();
  if (!text.trim()) return false;
  return COMBAT_CAUSE_WORDS.some((word) => text.includes(word));
}

// ---- helpers (verbatim ports) -----------------------------------------------

function isRow(v: unknown): v is PyRow {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function pyFloat(v: unknown, fb: number): number {
  const t = v === undefined || v === null || v === false || v === 0 || v === "" ? fb : v;
  const n = typeof t === "number" ? t : Number(t);
  return Number.isFinite(n) ? n : fb;
}

function pyBool(v: unknown): boolean {
  return Boolean(v ?? false);
}

function stripSet(s: string, chars: string, mode: "both" | "start" | "end" = "both"): string {
  let a = 0;
  let b = s.length;
  const set = new Set([...chars]);
  if (mode === "both" || mode === "start") while (a < b && set.has(s[a]!)) a++;
  if (mode === "both" || mode === "end") while (b > a && set.has(s[b - 1]!)) b--;
  return s.slice(a, b);
}

function cpLen(s: string): number {
  return [...s].length;
}

function cpSlice(s: string, start: number, end?: number): string {
  return [...s].slice(start, end).join("");
}

function snapHalf(value: number): number {
  return pyRound(value * 2.0) / 2.0;
}

/** py: environment_transition_time */
export function environment_transition_time(durationSeconds: unknown): number {
  const duration = Math.max(0.5, pyFloat(durationSeconds, 0.5));
  const transition = snapHalf((duration * 2.0) / 3.0);
  return Math.min(Math.max(0.5, transition), Math.max(0.5, duration - 0.5));
}

function appendOnce(value: unknown, contract: string): string {
  const text = String(value ?? "").trim();
  const signature = contract.split(":", 1)[0]!.trim().toLowerCase();
  if (signature && text.toLowerCase().includes(signature)) return text;
  return stripSet(text, " .") + (text ? ". " : "") + contract;
}

function replaceGeneratedLine(value: unknown, marker: string, content: string): string {
  const prefix = `[${marker}]`;
  const rows = String(value ?? "")
    .split("\n")
    .map((row) => row.replace(/\s+$/, ""))
    .filter((row) => !row.trim().startsWith(prefix));
  rows.push(`${prefix} ${content.trim()}`);
  return rows.filter((row) => row.trim() !== "").join("\n").trim();
}

function compactAction(value: unknown, limit = 150): string {
  let text = stripSet(String(value ?? "").split(/\s+/).filter(Boolean).join(" "), " .");
  text = text.replace(/\[BEAT\s+\d+[^\]]*\]/gi, "");
  text = stripSet(text.split(/\s+/).filter(Boolean).join(" "), " .");
  if (cpLen(text) > limit) {
    text = stripSet(cpSlice(text, 0, limit - 1), " ,;:") + "…";
  }
  return text || "active close-combat contact";
}

function causeActor(action: string, index: number): string {
  const match = /\b(S[12])\b/i.exec(action);
  return match?.[1]?.toUpperCase() ?? (index % 2 === 0 ? "S1" : "S2");
}

function objectId(target: string): string {
  const token = target.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return "env_" + (token || "contact_target");
}

function mechanic(action: string): string {
  const lowered = action.toLowerCase();
  const rows: [string[], string][] = [
    [["takedown", "throw", "hip-turn", "foot-sweep", "抱摔", "投技", "足扫", "摔"], "throw or takedown momentum"],
    [["kick", "shin", "踢", "胫"], "committed kick or checked-kick momentum"],
    [["clinch", "underhook", "overhook", "grip", "夹抱", "抓", "锁臂"], "clinch or grip drive"],
    [["palm", "forearm", "elbow", "parry", "掌", "前臂", "肘", "拨挡"], "redirected palm, forearm or elbow contact"],
    [["ground", "bridge", "side control", "地面", "桥式", "压制"], "grounded body-pressure shift"],
    [["submission", "choke", "armbar", "wrist", "release", "recover", "tap", "绞", "絞", "关节", "關節"], "controlled submission release and recovery"],
  ];
  for (const [words, label] of rows) {
    if (words.some((word) => lowered.includes(word))) return label;
  }
  return "active close-combat momentum";
}

function locationForShot(start: number, end: number, transition: number): string {
  const transitionWindow = Math.max(0.0, transition - 2.5);
  if (start >= transition - 1e-6) return "outdoor_rain_alley";
  if (end > transitionWindow + 1e-6) return "market_loading_threshold";
  if (start >= transition / 2.0) return "fish_vegetable_junction";
  return "indoor_seafood_aisle";
}

// py: _location_description is dead in the source core too (the venue
// reconcile writes its transition prose directly) — not ported.

const INDOOR_EFFECTS: [string, string, string, string][] = [
  ["shallow floor puddle", "a low directional splash follows the planted foot", "water spreads along the existing drain", "light"],
  ["hanging scale chain", "the scale swings once from the transferred vibration", "nearby hooks rattle briefly", "light"],
  ["crushed-ice seafood tray", "the tray shifts and loose ice scatters away from the contact", "one fish basket tips against the counter", "medium"],
  ["stacked wet produce crates", "the upper crate overturns toward the wall", "vegetables roll along the sloped wet floor", "medium"],
  ["aged metal stall side panel", "the panel dents inward at the contact point", "rust dust falls only after the impact", "medium"],
  ["fish-tank support frame", "the frame vibrates while the intact tank water sloshes", "cyan reflections tremble across the puddle", "light"],
];

const THRESHOLD_EFFECTS: [string, string, string, string][] = [
  ["hanging loading-strip curtain", "the strips snap apart around the moving fighters", "indoor steam spills toward the doorway", "light"],
  ["stacked loading crates", "two crates slide toward the wall and remain displaced", "the clear route to the gate becomes visible", "medium"],
  ["metal market gate and latch", "the latch bends and the gate is forced outward by the visible body momentum", "the gate remains open onto the rainy alley", "heavy"],
];

const OUTDOOR_EFFECTS: [string, string, string, string][] = [
  ["rain-filled alley puddle", "a broad directional splash follows the visible landing", "runoff carries loose ice toward the street drain", "light"],
  ["exterior plastic fish crate", "the crate skids to the brick wall and remains there", "its loose lid spins once then settles", "medium"],
  ["corrugated market awning support", "the support shudders without collapsing", "rain sheets briefly from the awning edge", "light"],
  ["metal refuse bin", "the bin tips onto its side after contact", "empty plastic baskets scatter away from P1 and P2", "medium"],
  ["delivery handcart", "the handcart rolls a short distance and stops against a bollard", "its chain rattles after the stop", "medium"],
];

const MATERIAL_RESPONSE: Record<string, string> = {
  water: "fans low across the floor, then follows the existing drain gradient",
  loose_ice: "scatters and slides with low friction before settling",
  wet_plastic: "skids first, then yaws and stops against the nearest fixed obstacle",
  aged_metal: "dents or flexes at the contact point before vibration travels through its supports",
  hanging_metal: "swings from its suspension point and returns with diminishing amplitude",
  glass_water_frame: "the frame vibrates first and the contained water sloshes after it",
  fabric_strip: "snaps away from the moving bodies and trails behind their passage",
  rubber_wheel_cart: "rolls along the applied horizontal force until a visible stop arrests it",
};

const RECOVERY_ACTION_RE =
  /\b(?:submission|choke|armbar|wrist|release|recover|tap|guarded\s+base|reset(?:s|ting)?|hip[- ]escape)\b|绞|絞|关节|關節|腕|松开|松開|复位|復位/i;

function materialForTarget(target: string): string {
  const lowered = target.toLowerCase();
  if (lowered.includes("puddle")) return "water";
  if (lowered.includes("ice")) return "loose_ice";
  if (lowered.includes("plastic") || lowered.includes("crate")) return "wet_plastic";
  if (lowered.includes("tank")) return "glass_water_frame";
  if (lowered.includes("curtain")) return "fabric_strip";
  if (lowered.includes("cart")) return "rubber_wheel_cart";
  if (lowered.includes("chain") || lowered.includes("scale") || lowered.includes("hook")) return "hanging_metal";
  return "aged_metal";
}

function forceFromShot(shot: PyRow, action: string, actor: string): PyRow {
  const stored = shot.combat_force_vector;
  if (isRow(stored) && stored.label) {
    return { ...stored };
  }
  const lowered = action.toLowerCase();
  let horizontal = actor === "S2" ? "screen-left" : "screen-right";
  if (lowered.includes(" left") || lowered.includes("向左")) horizontal = "screen-left";
  else if (lowered.includes(" right") || lowered.includes("向右")) horizontal = "screen-right";
  let vertical = ["slam", "floor", "ground", "向下", "落地"].some((w) => lowered.includes(w)) ? "downward" : "level";
  if (["rising", "uppercut", "lift", "向上", "上挑"].some((w) => lowered.includes(w))) vertical = "upward";
  const depth = ["recoil", "retreat", "backward", "backwards", "后退", "後退"].some((w) => lowered.includes(w)) ? "backward" : "forward";
  const magnitude = ["throw", "takedown", "slam", "drive", "摔", "猛推"].some((w) => lowered.includes(w)) ? "heavy" : "medium";
  const label = `${horizontal}, ${vertical}, ${depth}`;
  return { horizontal, vertical, depth, magnitude, label };
}

function directionalResponses(
  target: string,
  primary: string,
  secondary: string,
  material: string,
  force: PyRow,
): [string, string] {
  const direction = String(force.label || "screen-right, level, forward");
  const physicalRule = MATERIAL_RESPONSE[material] ?? "moves away from the visible contact and then settles";
  const directedPrimary = `${stripSet(primary, " .")}; ${target} responds along ${direction}: ${physicalRule}`;
  const directedSecondary =
    `${stripSet(secondary, " .")}; all loose secondary material continues along ${direction} ` +
    "with less energy and never travels against the applied force";
  return [directedPrimary, directedSecondary];
}

function effectFor(location: string, index: number, thresholdExit: boolean): [string, string, string, string] {
  if (thresholdExit) return THRESHOLD_EFFECTS[THRESHOLD_EFFECTS.length - 1]!;
  if (location === "market_loading_threshold") {
    return THRESHOLD_EFFECTS[index % (THRESHOLD_EFFECTS.length - 1)]!;
  }
  if (location === "outdoor_rain_alley") return OUTDOOR_EFFECTS[index % OUTDOOR_EFFECTS.length]!;
  return INDOOR_EFFECTS[index % INDOOR_EFFECTS.length]!;
}

function effectForAction(
  action: string,
  location: string,
  index: number,
  thresholdExit: boolean,
): [string, string, string, string] {
  const lowered = action.toLowerCase();
  if (
    ["submission", "choke", "armbar", "wrist", "release", "recover", "tap",
      "绞", "絞", "关节", "關節", "腕", "松开", "松開"].some((w) => lowered.includes(w))
  ) {
    return location === "outdoor_rain_alley" ? OUTDOOR_EFFECTS[0]! : INDOOR_EFFECTS[0]!;
  }
  if (["puddle", "wet floor", "水洼", "水窪", "湿地", "濕地"].some((w) => lowered.includes(w))) {
    return location === "outdoor_rain_alley" ? OUTDOOR_EFFECTS[0]! : INDOOR_EFFECTS[0]!;
  }
  if (["crate", "produce", "vegetable", "菜箱", "货箱", "貨箱"].some((w) => lowered.includes(w))) {
    return location === "outdoor_rain_alley" ? OUTDOOR_EFFECTS[1]! : INDOOR_EFFECTS[3]!;
  }
  const explicit: [string[], [string, string, string, string]][] = [
    [["gate", "latch", "闸门", "閘門", "门闩", "門閂"], THRESHOLD_EFFECTS[THRESHOLD_EFFECTS.length - 1]!],
    [["stall", "metal panel", "档口", "檔口", "摊位", "攤位"], INDOOR_EFFECTS[4]!],
    [["fish tank", "tank frame", "鱼缸", "魚缸"], INDOOR_EFFECTS[5]!],
    [["ice tray", "seafood tray", "crushed ice", "冰盘", "冰盤"], INDOOR_EFFECTS[2]!],
    [["scale", "hook", "秤", "吊钩", "吊鉤"], INDOOR_EFFECTS[1]!],
    [["awning", "雨棚"], OUTDOOR_EFFECTS[2]!],
    [["handcart", "cart", "手推车", "手推車"], OUTDOOR_EFFECTS[4]!],
    [["refuse bin", "trash bin", "垃圾桶"], OUTDOOR_EFFECTS[3]!],
  ];
  for (const [words, effect] of explicit) {
    if (words.some((word) => lowered.includes(word))) return effect;
  }
  return effectFor(location, index, thresholdExit);
}

function crowdResponse(location: string, damageLevel: string, index: number): string {
  const delay = [0.25, 0.35, 0.45][index % 3]!;
  let action: string;
  if (location === "market_loading_threshold") {
    action =
      "the nearest vendors recoil and pull one companion clear of the opening while the rest " +
      "part toward both sides of the gate";
  } else if (location === "outdoor_rain_alley") {
    action =
      "alley spectators retreat against the shopfronts and keep the centre route clear; none " +
      "approaches or joins the fight";
  } else if (damageLevel === "medium" || damageLevel === "heavy") {
    action =
      "the nearest vendors shield their faces and pull one another one step behind the stalls; " +
      "distant spectators remain at the perimeter";
  } else {
    action =
      "the nearest spectators flinch and shift one step away while the distant crowd keeps its " +
      "established perimeter positions";
  }
  return `About ${fmt2(delay)}s after the visible contact, ${action}.`;
}

function persistentUpdate(target: string, primary: string, secondary: string, damageLevel: string): string {
  if (
    damageLevel === "light" &&
    !["remain", "spreads", "displaced", "open"].some((word) => primary.toLowerCase().includes(word))
  ) {
    return "";
  }
  return `${target}: ${primary}; ${secondary}`;
}

function boundedState(location: string, ledger: string[]): string {
  const base = "Location=" + location;
  if (ledger.length === 0) {
    return base + "; all tracked fixtures retain their established state";
  }
  const prefix =
    ledger.length > 6
      ? "; all earlier tracked changes also persist unchanged; recent persistent state: "
      : "; persistent state: ";
  return base + prefix + ledger.slice(-6).join(" | ");
}

// ---- the venue reconcile (py: reconcile_environmental_combat_rows) ---------

export function reconcile_environmental_combat_rows(
  rows: unknown,
  durationSeconds: unknown,
  opts: { transition_basis_seconds?: unknown } = {},
): [PyRow[], string[]] {
  const duration = Math.max(0.5, pyFloat(durationSeconds, 0.5));
  const transition = environment_transition_time(
    opts.transition_basis_seconds === undefined ? duration : opts.transition_basis_seconds,
  );
  const shots = (Array.isArray(rows) ? rows : [])
    .filter(isRow)
    .map((row) => structuredClone(row))
    .sort((a, b) => {
      const as = pyFloat(a.start_seconds, 0.0);
      const bs = pyFloat(b.start_seconds, 0.0);
      if (as !== bs) return as - bs;
      const ae = pyFloat(a.end_seconds, 0.0);
      const be = pyFloat(b.end_seconds, 0.0);
      if (ae !== be) return ae - be;
      const aid = String(a.id || a.cue_id || "");
      const bid = String(b.id || b.cue_id || "");
      return aid < bid ? -1 : aid > bid ? 1 : 0;
    });
  const ledger: string[] = [];
  const warnings: string[] = [];
  shots.forEach((shot, index) => {
    const start = Math.max(0.0, pyFloat(shot.start_seconds, 0.0));
    const end = Math.max(start + 0.05, pyFloat(shot.end_seconds, start + 0.5));
    const location = locationForShot(start, end, transition);
    const thresholdExit =
      start < transition && transition <= end + 1e-6 ||
      (end >= transition - 1e-6 && location === "market_loading_threshold");
    const rawAction = shot.subject_action ?? "";
    const hasCause = hasCombatCause(rawAction);
    const action = compactAction(rawAction);
    const actor = causeActor(action, index);
    const [target, initialPrimary, initialSecondary, damageLevel] = effectForAction(action, location, index, thresholdExit);
    const force = forceFromShot(shot, action, actor);
    const material = materialForTarget(target);
    const [primary, secondary] = directionalResponses(target, initialPrimary, initialSecondary, material, force);
    const contactTime = Math.min(end - 0.05, start + Math.max(0.15, Math.min(0.65, (end - start) * 0.45)));
    const automaticInteraction = hasCause
      ? `cause_actor=${actor}; action=${mechanic(action)}; contact_target_id=${objectId(target)}; ` +
        `contact_target=${target}; contact_material=${material}; contact_time=${fmt2(contactTime)}s; ` +
        `force_direction=${force.label}; force_magnitude=${force.magnitude}; ` +
        `primary_response=${primary}; secondary_response=${secondary}. ` +
        "Show the action and exact contact before either response."
      : "";
    let crowd = hasCause ? crowdResponse(location, damageLevel, index) : "";
    if (pyBool(shot.environment_interaction_user_edited)) {
      const interaction = String(shot.environment_interaction ?? "").trim();
      shot.environment_interaction = interaction;
    } else {
      shot.environment_interaction = automaticInteraction;
    }
    if (pyBool(shot.crowd_reaction_user_edited)) {
      crowd = String(shot.crowd_reaction ?? "").trim();
    }

    const incoming = boundedState(location, ledger);
    const update = hasCause ? persistentUpdate(target, primary, secondary, damageLevel) : "";
    if (update && !ledger.includes(update)) ledger.push(update);
    const outgoing = boundedState(location, ledger);

    let transitionText: string;
    if (location === "market_loading_threshold") {
      transitionText =
        `INDOOR→OUTDOOR ROUTE: active attack, defence, clinch or throw carries P1/S1 and ` +
        `P2/S2 through the visible market loading passage toward the gate at ${fmt2(transition)}s; ` +
        "never insert walking coverage, an establishing cut or teleportation.";
    } else if (location === "outdoor_rain_alley") {
      transitionText =
        "OUTDOOR CONTINUATION: remain immediately outside the same now-open market gate; " +
        "preserve screen direction, wetness, carried debris, fighter momentum and the FPV orbit.";
    } else {
      transitionText =
        "INDOOR CONTINUITY: remain inside the visibly connected market aisle; any movement " +
        "between stalls is caused only by the ongoing exchange.";
    }

    for (const [fieldName, generated] of [
      ["incoming_environment_state", incoming],
      ["outgoing_environment_state", outgoing],
      ["location_transition", transitionText],
    ] as const) {
      if (!pyBool(shot[`${fieldName}_user_edited`])) {
        shot[fieldName] = generated;
      }
    }
    shot.crowd_reaction = crowd;
    shot.contact_material = hasCause ? material : "";
    shot.environment_force_vector = hasCause ? force : {};
    const outgoingCombat = shot.outgoing_combat_state_vector;
    if (hasCause && isRow(outgoingCombat)) {
      outgoingCombat.environment_aftermath =
        `${target} responds ${force.label} and remains in the resulting state`;
      shot.outgoing_combat_state_vector = outgoingCombat;
      if (!pyBool(shot.outgoing_combat_state_user_edited)) {
        shot.outgoing_combat_state = Object.entries(outgoingCombat)
          .map(([key, value]) => `${key}=${value}`)
          .join("; ");
      }
    }
    const userAuthoredUncausedInteraction =
      !hasCause && pyBool(shot.environment_interaction_user_edited) && String(shot.environment_interaction ?? "").trim() !== "";
    shot.environment_state_status = userAuthoredUncausedInteraction
      ? "warning"
      : location === "market_loading_threshold"
        ? "transition"
        : "continuous";
    shot.environment_physics_schema_version = ENVIRONMENT_PHYSICS_SCHEMA_VERSION;

    shot.environment_response = replaceGeneratedLine(
      shot.environment_response ?? "",
      "ENV-PHYSICS",
      interactionText(shot, incoming, crowd),
    );
    shot.continuity_state = replaceGeneratedLine(
      shot.continuity_state ?? "",
      "ENV-IN",
      String(shot.incoming_environment_state ?? incoming),
    );
    shot.continuity_state = replaceGeneratedLine(
      shot.continuity_state ?? "",
      "ENV-OUT",
      String(shot.outgoing_environment_state ?? outgoing),
    );
    shot.additional_direction = replaceGeneratedLine(
      shot.additional_direction ?? "",
      "LOCATION",
      String(shot.location_transition ?? transitionText),
    );
    shot.additional_direction = appendOnce(shot.additional_direction ?? "", CAUSALITY_CONTRACT);

    if (hasCause) {
      shot.event_causality_chain =
        `EVENT CAUSE: ${actor} performs ${mechanic(action)}; ` +
        `EVENT RESPONSE: ${target} receives the visible contact; ` +
        `EVENT CONSEQUENCE: ${primary}; NEXT EVENT: the resulting state persists into the following Shot.`;
      shot.physical_feedback_chain =
        `PHYSICAL FEEDBACK: ${material} responds along ${force.label} with ` +
        `${force.magnitude} magnitude; show contact before the response and preserve the result.`;
    } else {
      shot.event_causality_chain =
        "EVENT CAUSE: no fighter-to-material contact is authored; EVENT RESPONSE: no object " +
        "moves or breaks; NEXT EVENT: preserve the incoming environment state unchanged.";
      shot.physical_feedback_chain =
        "PHYSICAL FEEDBACK: none required without visible contact; stable fighter recovery is not damage.";
    }

    if (RECOVERY_ACTION_RE.test(String(rawAction ?? "")) && !pyBool(shot.environment_interaction_user_edited)) {
      shot.causal_risk_repair_status = "auto_fixed";
      shot.causal_risk_repair_notes =
        "Added a minimal recovery contact and directional physical feedback; no destructive event was invented.";
    }

    if (userAuthoredUncausedInteraction) {
      warnings.push(
        `${String(shot.id || shot.cue_id || `Shot ${index + 1}`)} has no visible ` +
          "environmental contact cause for its user-edited interaction.",
      );
    }
  });

  return [shots, warnings];
}

function interactionText(shot: PyRow, incoming: string, crowd: string): string {
  const interaction = String(shot.environment_interaction ?? "");
  if (interaction) {
    return `${interaction} CROWD RESPONSE - ${crowd}`;
  }
  return "No material contact is authored in this Shot; preserve the established environment state without spontaneous damage.";
}

// ---- prompt clause (py: environmental_combat_prompt_clause, venue branch) ---

export function environmental_combat_prompt_clause(row: unknown, opts: { include_global_contract?: boolean } = {}): string {
  const includeGlobalContract = opts.include_global_contract ?? true;
  if (!isRow(row) || !pyFloat(row.environment_physics_schema_version, 0)) {
    return "";
  }
  const compactRef = (value: unknown, limit: number): string => {
    let text = String(value ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .join(" ")
      .replace(/ /g, " ")
      .trim();
    text = text.replace(/(?:[A-Z]:\\|\/)\S+/g, "");
    text = stripSet(text, " ;");
    if (cpLen(text) > limit) {
      text = stripSet(cpSlice(text, 0, limit - 1), " ,;:") + "…";
    }
    return text;
  };
  const promptValue = (key: string, limit: number) => compactRef(row[key], limit);
  const parts = [
    "ENVIRONMENT INTERACTION - " + promptValue("environment_interaction", 700),
    // venue rows never set this field, so the part drops itself below — kept
    // for source fidelity (the reference path fills it)
    "CONTINUOUS POWER FIELD - " + promptValue("continuous_power_field", 420),
    "CROWD REACTION - " + promptValue("crowd_reaction", 220),
    "INCOMING ENVIRONMENT STATE - " + promptValue("incoming_environment_state", 520),
    "OUTGOING ENVIRONMENT STATE - " + promptValue("outgoing_environment_state", 620),
    "LOCATION TRANSITION - " + promptValue("location_transition", 320),
    "EVENT CAUSALITY - " + promptValue("event_causality_chain", 360),
    "PHYSICAL FEEDBACK - " + promptValue("physical_feedback_chain", 280),
  ];
  if (includeGlobalContract) {
    parts.push(CAUSALITY_CONTRACT);
  }
  return parts.filter((part) => !part.endsWith(" - ")).join(" ");
}

// ---- NEW: the neutral relay over a packet location ---------------------------

export type EnvEffectRow = { target: string; primary: string; secondary: string; damage: "light" | "medium" | "heavy" };

/** slatecrew default effect pack — NOT source verbatim. The source tables are
 *  Kowloon-branded venue data; a slatecrew sheet owns its location, so the
 *  neutral pack keeps the same row shape (target/primary/secondary/damage)
 *  with venue-neutral prose. Explicit authored targets still win via the
 *  token match below. */
export const NEUTRAL_EFFECTS: EnvEffectRow[] = [
  { target: "the established floor surface", primary: "dust lifts along the contact line and settles back", secondary: "loose debris rolls one short distance and stops", damage: "light" },
  { target: "the nearest fixed fixture", primary: "the fixture shudders once from the transferred force", secondary: "nearby loose items rattle briefly", damage: "light" },
  { target: "the nearest movable object", primary: "the object slides away from the contact and stays displaced", secondary: "lighter items resting on it shift and remain moved", damage: "medium" },
  { target: "the nearest wall or panel surface", primary: "the surface dents inward at the contact point", secondary: "loose surface material falls only after the impact", damage: "medium" },
  { target: "the established loose ground material", primary: "the material sprays along the force line and settles", secondary: "residue stays visible where it landed", damage: "medium" },
  { target: "the largest nearby support structure", primary: "the structure holds firm and the contact leaves a visible mark", secondary: "the mark persists in every later shot without repair", damage: "heavy" },
];

export type EnvironmentRelayInput = {
  shotId: string;
  action: string;
  actor: string;
  forceVector: PyRow;
};

export type EnvironmentRelayState = {
  location: string;
  incoming_state: string;
  outgoing_state: string;
  interaction: string;
  contact_material: string;
  force_vector: PyRow;
  persistent: string[];
  schema_version: number;
};

/** The environment inheritance relay over ONE packet location: the same
 *  bounded-ledger machinery as the venue reconcile, without the Kowloon
 *  ladder. Damage persists shot to shot; no authored cause means no new
 *  damage and the incoming state passes through unchanged. */
export function environmentRelay(
  inputs: EnvironmentRelayInput[],
  opts: { location: string; effects?: EnvEffectRow[] },
): EnvironmentRelayState[] {
  const effects = opts.effects ?? NEUTRAL_EFFECTS;
  const ledger: string[] = [];
  return inputs.map((input, index) => {
    const hasCause = hasCombatCause(input.action);
    const action = compactAction(input.action);
    let row: EnvEffectRow = effects[index % effects.length]!;
    // authored targets win over deterministic variety (source law)
    const lowered = action.toLowerCase();
    const tokenRows: [string[], number][] = [
      [["puddle", "wet floor", "水洼", "水窪", "湿地", "濕地"], 0],
      [["crate", "produce", "vegetable", "菜箱", "货箱", "貨箱", "box", "桌", "椅", "stool", "chair"], 2],
      [["wall", "panel", "pillar", "column", "墙", "牆", "柱"], 3],
      [["gate", "latch", "door", "门", "門", "閘", "闸"], 5],
    ];
    for (const [tokens, rowIdx] of tokenRows) {
      if (tokens.some((t) => lowered.includes(t))) {
        row = effects[rowIdx % effects.length]!;
        break;
      }
    }
    const material = materialForTarget(row.target);
    const [primary, secondary] = directionalResponses(row.target, row.primary, row.secondary, material, input.forceVector);
    const incoming = boundedState(opts.location, ledger);
    if (hasCause) {
      const update = persistentUpdate(row.target, primary, secondary, row.damage);
      if (update && !ledger.includes(update)) ledger.push(update);
    }
    const outgoing = boundedState(opts.location, ledger);
    const interaction = hasCause
      ? `cause_actor=${input.actor}; action=${mechanic(action)}; contact_target_id=${objectId(row.target)}; ` +
        `contact_target=${row.target}; contact_material=${material}; ` +
        `force_direction=${input.forceVector.label}; force_magnitude=${input.forceVector.magnitude}; ` +
        `primary_response=${primary}; secondary_response=${secondary}. ` +
        "Show the action and exact contact before either response."
      : "";
    return {
      location: opts.location,
      incoming_state: incoming,
      outgoing_state: outgoing,
      interaction,
      contact_material: hasCause ? material : "",
      force_vector: hasCause ? input.forceVector : {},
      persistent: ledger.slice(-6),
      schema_version: ENVIRONMENT_PHYSICS_SCHEMA_VERSION,
    };
  });
}
