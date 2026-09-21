import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { CallSheet, Shot } from "./types";
import { buildProse, validateProse, SCRIPT_HEADER, countWords, IDENTITY_LONG_MAX } from "./h3-prose";
import {
  applyCombatPass,
  applyCombatToSheet,
  combatProseSpec,
  detectCombat,
  hasCombatCause,
} from "./combat-adapter";
import { CONSTRAINT_PRESETS, TRANSITION_STYLE_PRESETS } from "./combat-presets";

// ---- packet builders (the marks/camera shape the pipeline validates) -------

const mark = (characterId: string, x = 20) => ({
  characterId,
  start: { x, y: 50 },
  end: { x: x + 2, y: 50 },
  facing: 0,
  handL: { x: x + 4, y: 40 },
  handR: { x: x + 8, y: 40 },
  footL: { x: x + 2, y: 70 },
  footR: { x: x + 6, y: 70 },
  gait: "plant" as const,
});

const shot = (id: string, index: number, action: string, characterIds: string[], durationSec = 2.5): Shot => ({
  id,
  index,
  heading: "打鬥",
  size: "full",
  location: "後巷",
  action,
  dialogue: "",
  durationSec,
  camera: { pos: { x: 0, y: 1.6, z: 4 }, lookAt: { x: 0, y: 1.2, z: 0 }, lensMm: 35 },
  marks: characterIds.map((cid, i) => mark(cid, i === 0 ? 20 : 70)),
  stillPrompt: "",
  motionPrompt: "",
});

const sheet = (shots: Shot[], weather: CallSheet["weather"] = "clear"): CallSheet => ({
  title: "巷戰",
  logline: "兩個人在後巷打一場",
  language: "zh-Hant",
  location: "後巷",
  timeOfDay: "night",
  weather,
  mood: "緊張",
  durationSec: shots.reduce((a, s) => a + s.durationSec, 0),
  aspect: "16:9",
  characters: [
    {
      id: "C1", name: "陳師傅", role: "武師", wardrobe: "白色汗衫",
      palette: ["#111", "#222", "#333"], voice: { pitchHz: 110, gender: "m" },
    },
    {
      id: "C2", name: "大強", role: "打手", wardrobe: "黑色背心",
      palette: ["#444", "#555", "#666"], voice: { pitchHz: 95, gender: "m" },
    },
    {
      id: "C3", name: "阿標", role: "旁觀", wardrobe: "灰色外套",
      palette: ["#777", "#888", "#999"], voice: { pitchHz: 120, gender: "m" },
    },
  ],
  styleBible: { grade: "cinematic", refs: [], stillModel: "U1.5", motionModel: "H3" },
  shots,
  voiceover: "",
});

const KICK = "陳師傅 launches a low kick at 大強. 大強 checks the kick and pivots outside.";
const COUNTER = "大強 counters with a rising knee. 陳師傅 absorbs it on a tight elbow shield.";

// ---- detection --------------------------------------------------------------

test("hasCombatCause: source predicate — fight verbs hit, chatter misses", () => {
  assert.ok(hasCombatCause("S1 punches and S2 blocks"));
  assert.ok(hasCombatCause("陳師傅一拳打向大強"));
  assert.ok(hasCombatCause("the grip is released and both recover"));
  assert.ok(!hasCombatCause("兩人望住對方講嘢"));
  assert.ok(!hasCombatCause(""));
});

test("detectCombat: needs ≥2 marked characters AND a combat cause", () => {
  assert.ok(detectCombat(sheet([shot("SH01", 0, KICK, ["C1", "C2"])])));
  assert.ok(!detectCombat(sheet([shot("SH01", 0, KICK, ["C1"])])), "solo fighter is not a combat shot");
  assert.ok(
    !detectCombat(sheet([shot("SH01", 0, "兩人對望然後離開", ["C1", "C2"])])),
    "no combat cause, no combat signal",
  );
});

// ---- the pass ---------------------------------------------------------------

test("applyCombatToSheet: two named fighters map to S1/S2 and back", () => {
  const fight = sheet([
    shot("SH01", 0, KICK, ["C1", "C2"]),
    shot("SH02", 1, COUNTER, ["C2", "C1"]),
  ]);
  const { sheet: passed, summary } = applyCombatToSheet(fight);
  assert.ok(summary.applied);
  assert.deepEqual(summary.combatShots, ["SH01", "SH02"]);
  const s1 = passed.shots[0]!.combat!;
  const s2 = passed.shots[1]!.combat!;
  // screen-left fighter is S1: 陳師傅's mark is at x=20
  assert.equal(s1.actors.s1, "陳師傅");
  assert.equal(s1.actors.s2, "大強");
  // seven-column beats on every structured beat
  for (const beat of s1.beats) {
    for (const field of [
      "load_weight", "trajectory", "defensive_response", "contact_kind",
      "force_vector", "displacement", "next_trigger",
    ]) {
      assert.ok(beat[field], `beat ${String(beat.beat_id)} lacks ${field}`);
    }
  }
  // the causal relay survives the name round-trip: shot 2 inherits shot 1's outgoing
  assert.ok(s2.incoming_state.length > 0);
  assert.equal(s2.validation.inherited_fields.length, 6);
  assert.ok(summary.relayBreaks.length === 0);
  // engine S1/S2 tokens never leak into the prose-facing state
  assert.ok(!/\bS[12]\b/.test(s1.outgoing_state));
  assert.ok(s1.outgoing_state.includes("陳師傅") || s1.outgoing_state.includes("大強"));
  // packet-authored slate fields are never rewritten
  assert.equal(passed.shots[0]!.action, KICK);
  // a genuinely distinct second exchange is not flagged (auto-repair only rewrote the view)
  assert.equal(s2.risk.flags.length, 0);
});

test("applyCombatToSheet: >2 marked fighters is an ACTION_RISK incompatibility, not a silent pass", () => {
  const brawl = sheet([shot("SH01", 0, KICK, ["C1", "C2", "C3"])]);
  const { summary } = applyCombatToSheet(brawl);
  assert.equal(summary.combatShots.length, 0);
  assert.equal(summary.incompatibleShots.length, 1);
  assert.match(summary.incompatibleShots[0]!.reason, /3 marked characters/);
});

test("applyCombatToSheet: non-combat sheet is untouched, no combat fields", () => {
  const calm = sheet([shot("SH01", 0, "兩人對望然後離開", ["C1", "C2"])]);
  const { sheet: passed, summary } = applyCombatToSheet(calm);
  assert.ok(!summary.applied);
  assert.equal(passed.shots[0]!.combat, undefined);
});

// ---- the prose flag layer ---------------------------------------------------

test("combatProseSpec: Physical Contact first, momentum-carry cut, weather soundscape", () => {
  const fight = sheet(
    [shot("SH01", 0, KICK, ["C1", "C2"]), shot("SH02", 1, COUNTER, ["C2", "C1"])],
    "rain",
  );
  const { sheet: passed } = applyCombatToSheet(fight);
  const first = combatProseSpec(passed, passed.shots[0]!);
  assert.equal(first[0]!.line, CONSTRAINT_PRESETS["Physical Contact"]);
  assert.equal(first[0]!.kind, "constraint");
  // no previous combat shot → no Match-on-Action
  assert.ok(!first.some((l) => l.kind === "transition"));

  const second = combatProseSpec(passed, passed.shots[1]!, passed.shots[0]);
  assert.ok(
    second.some((l) => l.line === TRANSITION_STYLE_PRESETS["Match-on-Action"]),
    "a combat shot following a combat shot carries the momentum-carry cut",
  );
  assert.ok(second.some((l) => l.kind === "soundscape" && l.line.includes("rainfall")));
  assert.ok(second.some((l) => l.kind === "relay" && l.line.includes("陳師傅")));
});

test("combatProseSpec: throw carrier adds Motion Discipline + Anatomy Lock", () => {
  const fight = sheet([shot("SH01", 0,
    "陳師傅 drives a double-leg takedown into 大強. 大強 sprawls and frames.", ["C1", "C2"])]);
  const { sheet: passed } = applyCombatToSheet(fight);
  const spec = combatProseSpec(passed, passed.shots[0]!);
  assert.equal(passed.shots[0]!.combat!.carrier, "throw_takedown");
  assert.ok(spec.some((l) => l.line === CONSTRAINT_PRESETS["Motion Discipline"]));
  assert.ok(spec.some((l) => l.line === CONSTRAINT_PRESETS["Anatomy Lock"]));
});

test("buildProse integration: combat paragraph rides inside the T42 budget", () => {
  const fight = sheet([shot("SH01", 0, KICK, ["C1", "C2"])], "rain");
  const { sheet: passed } = applyCombatToSheet(fight);
  const prose = buildProse(passed, passed.shots[0]!, { form: "c" });
  assert.ok(prose.includes(CONSTRAINT_PRESETS["Physical Contact"]!), "the card law: Physical Contact rides");
  assert.ok(prose.includes("The fight state carries across the cut"));
  const words = countWords(prose);
  assert.ok(words <= IDENTITY_LONG_MAX, `combat prose blew the T42 ceiling: ${words}`);
  validateProse(`${SCRIPT_HEADER}\n${prose}`, { requireQuote: false });
});

test("buildProse integration: budget drop order — Physical Contact never drops first", () => {
  // fat packet: heavy scene words push the base body near the ceiling
  const fat = sheet([shot("SH01", 0, KICK, ["C1", "C2"])], "rain");
  fat.location = "九龍城寨風雨交加嘅三層深濕貨市場後巷";
  fat.mood = "血脈賁張雨夜 neon 濕滑反光緊張到極點";
  fat.logline = "兩個亡命之徒喺暴雨後巷用拳腳分高下你死我活";
  const { sheet: passed } = applyCombatToSheet(fat);
  const prose = buildProse(passed, passed.shots[0]!, { form: "c" });
  assert.ok(
    prose.includes(CONSTRAINT_PRESETS["Physical Contact"]!),
    "Physical Contact is the last line standing when the budget is tight",
  );
  assert.ok(countWords(prose) <= IDENTITY_LONG_MAX);
});

test("non-combat prose is byte-identical: no combat clause ever leaks", () => {
  const calm = sheet([shot("SH01", 0, "兩人喺後巷盡頭對望良久，各自壓低聲線講咗幾句，然後轉身慢慢行出去", ["C1", "C2"])]);
  calm.location = "九龍城寨濕貨市場三樓後巷";
  calm.mood = "潮濕壓抑嘅對峙氣氛";
  const prose = buildProse(calm, calm.shots[0]!, { form: "c" });
  assert.ok(!prose.includes("Physical Contact"));
  assert.ok(!prose.includes("Match-on-Action"));
  assert.ok(!prose.includes("The fight state carries across the cut"));
  // and the same sheet through the pass changes nothing
  const { sheet: passed } = applyCombatToSheet(calm);
  assert.equal(buildProse(passed, passed.shots[0]!, { form: "c" }), prose);
});

// ---- the pipeline hook (foreman conditions ②③) ------------------------------

test("applyCombatPass: combat-signal gated, ACTION_RISK events + receipt", () => {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "combat-pass-"));
  process.chdir(tmp);
  try {
    const events: { level: string; message: string }[] = [];
    // a repeat exchange the engine auto-repairs + a clean counter
    const fight = sheet([
      shot("SH01", 0, KICK, ["C1", "C2"]),
      shot("SH02", 1, KICK, ["C1", "C2"]),
      shot("SH03", 2, "三個人拳腳打埋一齊", ["C1", "C2", "C3"]),
    ]);
    applyCombatPass("SC-0921-CBT", fight, (event) =>
      events.push({ level: event.level, message: event.message }));
    // the third shot is a 3-fighter incompatibility → ACTION_RISK event
    assert.ok(
      events.some((e) => e.level === "warn" && e.message.includes("ACTION_RISK SH03")),
      "incompatible combat shot surfaces ACTION_RISK",
    );
    assert.ok(events.some((e) => e.message.includes("combat pass")));
    const receipt = JSON.parse(
      fs.readFileSync(path.join(tmp, "data", "jobs", "SC-0921-CBT", "combat", "combat-pass.json"), "utf8"),
    ) as { summary: { combatShots: string[]; incompatibleShots: unknown[] } };
    assert.deepEqual(receipt.summary.combatShots, ["SH01", "SH02"]);
    assert.equal(receipt.summary.incompatibleShots.length, 1);

    // no combat signal → no events, no receipt, byte-identical path
    const calmEvents: unknown[] = [];
    const calm = sheet([shot("SH01", 0, "兩人對望然後離開", ["C1", "C2"])]);
    const calmResult = applyCombatPass("SC-0921-CALM", calm, (event) => calmEvents.push(event));
    assert.equal(calmEvents.length, 0);
    assert.ok(!calmResult.summary.applied);
    assert.equal(calm.shots[0]!.combat, undefined);
  } finally {
    process.chdir(cwd);
  }
});
