import test from "node:test";
import assert from "node:assert/strict";
import {
  SCRIPT_HEADER,
  VIDEO_SENTENCE,
  PIN_SENTENCE,
  ACTION_SHORT_MAX,
  IDENTITY_LONG_MIN,
  IDENTITY_LONG_MAX,
  buildProse,
  buildProsePositive,
  countWords,
  hasVisibleVerb,
  pickProseMode,
  validateProse,
  validateProsePositive,
  validateUiSpec,
  wardrobeClauses,
  type UiShotSpec,
} from "./h3-prose";
import { buildH3Graph, BINDINGS } from "./h3-r2v-graph";
import { defaultConfig } from "./config";
import type { CallSheet, Shot } from "./types";

const mark = (characterId: string, x = 20) => ({
  characterId,
  start: { x, y: 50 },
  end: { x: 22, y: 50 },
  facing: 0,
  handL: { x: x + 4, y: 40 },
  handR: { x: x + 6, y: 40 },
  footL: { x: x + 1, y: 92 },
  footR: { x: x + 3, y: 92 },
  gait: "plant" as const,
});

function sheet(): CallSheet {
  return {
    title: "門口個燈",
    logline: "雨夜重逢",
    language: "zh-Hant",
    location: "茶餐廳門口",
    timeOfDay: "night",
    weather: "rain",
    mood: "wet neon",
    durationSec: 10,
    aspect: "16:9",
    characters: [
      { id: "A", name: "阿月", role: "保險調查員", wardrobe: "深藍乾濕褸", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
      { id: "B", name: "阿衡", role: "舊同事", wardrobe: "白襯衫", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
    ],
    styleBible: { grade: "wet neon", refs: [], stillModel: "u15", motionModel: "h3" },
    shots: [],
    voiceover: "",
  };
}

function shot(dialogue: string, speaker?: string, withProp = false): Shot {
  return {
    id: "SH03",
    index: 2,
    heading: "3",
    size: "medium",
    location: "茶餐廳門口",
    action: "兩人企喺燈下相認",
    dialogue,
    speaker,
    durationSec: 5,
    camera: { pos: { x: 0, y: 1.6, z: 3 }, lookAt: { x: 0, y: 1.5, z: 0 }, lensMm: 35 },
    marks: [mark("A", 20), mark("B", 70)],
    ...(withProp ? { props: [{ name: "長傘", heldBy: "A", shape: ["長"], forbid: ["叉"] }] } : {}),
    stillPrompt: "",
    motionPrompt: "",
  };
}

/** F1a — 街舞 fixture: solo, silent, visible verb, light scene → action-short */
function streetDanceShot(): { sheet: CallSheet; shot: Shot } {
  const s = sheet();
  s.location = "後巷";
  s.weather = "wind";
  s.mood = "raw";
  return {
    sheet: s,
    shot: {
      ...shot(""),
      id: "SH10",
      marks: [mark("A", 45)],
      action: "獨自跳街舞，轉身定格",
      durationSec: 4,
    },
  };
}

/** F1b — 審判室對話 fixture: 2 characters + dialogue → identity-long */
function interrogationShot(): { sheet: CallSheet; shot: Shot } {
  const s = sheet();
  s.location = "舊式審判室，木牆、吊扇、一盞檯燈照住證物";
  s.mood = "壓抑，塵埃在燈柱入面浮住";
  return {
    sheet: s,
    shot: {
      ...shot("你嗰晚喺邊？講。", "阿月"),
      id: "SH07",
      action: "兩人隔住長檯對峙，阿月逐句逼問，阿衡迴避眼神，指尖一下一下敲住檯面，吊扇喺頭頂慢慢轉",
      durationSec: 6,
    },
  };
}

const wrap = (body: string) => `${SCRIPT_HEADER}\n${body}`;
const LABEL_LINE = /^[一-鿿A-Za-z]+[:：]/m;

test("F3: mode decision covers the four packet combinations", () => {
  const { sheet: s1, shot: dance } = streetDanceShot();
  // 1. verb + solo + silent + light → action-short
  assert.equal(pickProseMode(s1, dance), "action-short");
  // 2. same but two characters → identity-long
  assert.equal(pickProseMode(s1, { ...dance, marks: [mark("A", 30), mark("B", 70)] }), "identity-long");
  // 3. same but dialogue present → identity-long
  assert.equal(pickProseMode(s1, { ...dance, dialogue: "跳啦。" }), "identity-long");
  // 4. solo silent light but require.action has no visible verb → identity-long
  assert.equal(pickProseMode(s1, { ...dance, action: "空鏡，靜物" }), "identity-long");
  // bonus: heavy scene (props) also forces identity-long
  assert.equal(pickProseMode(s1, { ...dance, props: [{ name: "長傘", heldBy: "A", shape: ["長"], forbid: ["叉"] }] }), "identity-long");
  assert.ok(hasVisibleVerb("獨自跳街舞"));
  assert.ok(hasVisibleVerb("she spins once"));
  assert.ok(!hasVisibleVerb("空鏡"));
});

test("F1a: street-dance fixture builds action-short inside the ≤70 詞 bucket", () => {
  const { sheet: s, shot: dance } = streetDanceShot();
  assert.equal(pickProseMode(s, dance), "action-short");
  const body = buildProse(s, dance);
  const total = countWords(body);
  assert.ok(total <= ACTION_SHORT_MAX, `${total} 詞 over action-short max`);
  assert.ok(body.includes(VIDEO_SENTENCE.replace("{{N}}", "1")));
  validateProse(wrap(body), { mode: "action-short", requireQuote: false });
});

test("F1b: interrogation fixture builds identity-long inside the 150–300 詞 bucket", () => {
  const { sheet: s, shot: room } = interrogationShot();
  assert.equal(pickProseMode(s, room), "identity-long");
  const body = buildProse(s, room);
  const total = countWords(body);
  assert.ok(total >= IDENTITY_LONG_MIN && total <= IDENTITY_LONG_MAX, `${total} 詞 outside 150–300`);
  assert.ok(body.includes("speaks the line in Audio 1"));
  validateProse(wrap(body), { mode: "identity-long", requireQuote: true, wardrobe: wardrobeClauses(s) });
});

test("F2: produced prose has zero label lines (rg ^[A-Za-z一-龥]+[:：] ≡ 0 hits)", () => {
  const cases = [streetDanceShot(), interrogationShot()].map(({ sheet: s, shot: sh }) => wrap(buildProse(s, sh)));
  for (const text of cases) {
    const hits = text.split("\n").filter((l) => LABEL_LINE.test(l));
    assert.deepEqual(hits, [], `label lines leaked: ${JSON.stringify(hits)}`);
  }
});

test("identity-long prose weaves every packet clause (roles, blocking, lens, dialogue)", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const body = buildProse(s, room);
  for (const fragment of ["阿月 (保險調查員)", "阿衡 (舊同事)", "frame-left", "frame-right", "35mm", "Audio 1", "<Video 1>"]) {
    assert.ok(body.includes(fragment), `missing ${fragment}`);
  }
  assert.ok(!body.includes("深藍乾濕褸"), "wardrobe must stay in the pin");
});

test("thin packet fails loud (prompt_too_thin) instead of padding", () => {
  const s = sheet(); // short location, terse fields
  // MERGE_THREE_0921: seats' pin sentence carries the <Video 1> + morph ban
  // (heavier than the lane's calibration) — the thin case trims to one mark
  // and an empty action: still identity-long (no visible verb), still < 150 詞
  const twoChars = { ...shot("", undefined, false), action: "", marks: [mark("A", 20)] };
  assert.throws(() => buildProse(s, twoChars), /prompt_too_thin/);
});

test("validator: 71–149 詞 is the no-man's land between modes", () => {
  const { sheet: s, shot: dance } = streetDanceShot();
  const pad = Array.from({ length: 90 }, (_, i) => `w${i}`).join(" ");
  const prose = `${buildProse(s, dance)}\n\n${pad}`;
  assert.throws(() => validateProse(wrap(prose), { requireQuote: false }), /between modes/);
});

test("validator: explicit mode enforces its own bucket", () => {
  const { sheet: s, shot: dance } = streetDanceShot();
  const pad = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
  const tooFat = `${buildProse(s, dance)}\n\n${pad}`; // ~110 詞
  assert.throws(() => validateProse(wrap(tooFat), { mode: "action-short", requireQuote: false }), /action-short over budget/);
  const { sheet: s2, shot: room } = interrogationShot();
  const trimmed = buildProse(s2, room).split("\n\n").slice(0, 2).join("\n\n"); // starved
  assert.throws(
    () => validateProse(wrap(trimmed), { mode: "identity-long", requireQuote: false }),
    /identity-long out of range/,
  );
});

test("identity-long is 5 paragraphs: setting / motion / pin / sound design / dialogue (③a)", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const body = buildProse(s, room);
  const paras = body.split("\n\n");
  assert.equal(paras.length, 5);
  assert.match(paras[0]!, /^Photoreal\. 舊式審判室/);
  assert.ok(paras[1]!.includes("<Video 1>"), "motion paragraph");
  assert.ok(paras[2]!.includes("start keyframe image"), "pin paragraph");
  // card ③a: sound design is a formal field — three layers, no ref files
  assert.ok(paras[3]!.includes("low bed"), "sound: low bed layer (#24)");
  assert.ok(paras[3]!.includes("In-frame sources"), "sound: in-frame sources (#25)");
  assert.ok(paras[3]!.includes("beat by beat"), "sound: accents follow action (#36)");
  assert.match(paras[4]!, /^阿月 \(left\) speaks the line in Audio 1: "你嗰晚喺邊？講。"\. 阿衡 listens\.$/);

  validateProse(wrap(body), { requireQuote: true });
  assert.ok(body.includes(VIDEO_SENTENCE.replace("{{N}}", "2")));
  assert.ok(body.includes(PIN_SENTENCE.replaceAll("{{PROP}}", "props")));
});

test("prop name lands in the pin sentence (a prop makes the scene heavy → identity-long)", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const withProp = { ...room, props: [{ name: "長傘", heldBy: "A", shape: ["長"], forbid: ["叉"] }] };
  assert.equal(pickProseMode(s, withProp), "identity-long");
  const body = buildProse(s, withProp);
  assert.ok(body.includes("the 長傘 and the field"), "prop name in pin");
});

/** §5b (CFORM_0921): C-form prose pins identity on <Picture 1> — the graph
 *  wires zero keyframes, so the pin never names a "start keyframe image". */
test("form c pins <Picture 1> and never names a keyframe image (both modes)", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const long = buildProse(s, room, { form: "c" });
  assert.ok(long.includes("Faces and clothes continue exactly from <Picture 1>"), "identity-long C-form pin");
  assert.ok(!long.includes("start keyframe image"), "C-form pin must not name a keyframe image");
  assert.ok(long.includes("Same props, not a morph"), "prop clause stays");
  validateProse(wrap(long), { requireQuote: true });
  const { sheet: d, shot: dance } = streetDanceShot();
  const short = buildProse(d, dance, { form: "c" });
  assert.ok(short.includes("continue exactly from <Picture 1>"), "action-short C-form pin");
  assert.ok(!short.includes("start keyframe image"));
  validateProse(wrap(short), { requireQuote: false });
});

test("silent action-short passes with requireQuote false", () => {
  const { sheet: s, shot: dance } = streetDanceShot();
  validateProse(wrap(buildProse(s, dance)), { requireQuote: false });
});

test("dialogue without an Audio 1 sentence throws", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const prose = buildProse(s, room).replace("speaks the line in Audio 1: ", "says ");
  assert.throws(() => validateProse(wrap(prose), { requireQuote: true }), /Audio 1/);
});

test("wardrobe leak throws", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const prose = buildProse(s, room) + "\n\n阿月着深藍乾濕褸。";
  assert.throws(
    () => validateProse(wrap(prose), { wardrobe: wardrobeClauses(s) }),
    /wardrobe belongs to the pin/,
  );
});

test("section label is banned", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const text = wrap(`${buildProse(s, room)}\n\nsubject_definitions: 兩人`);
  assert.throws(() => validateProse(text), /subject_definitions|label line/);
});

test("generic label line is banned even outside the named list", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const text = wrap(`${buildProse(s, room)}\n\n鏡頭說明：35mm手持`);
  assert.throws(() => validateProse(text), /label line/);
});

test("Camera: label line is banned", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const text = wrap(`${buildProse(s, room)}\n\nCamera: 35mm手持`);
  assert.throws(() => validateProse(text), /Camera|label line/);
});

test("missing <Video 1> motion-only sentence throws", () => {
  const body = [
    "Photoreal. 茶餐廳門口, night.",
    `阿月 (left) speaks the line in Audio 1: "你仲記得個門口個燈？"`,
    PIN_SENTENCE.replace("{{PROP}}", "props"),
  ].join("\n\n");
  assert.throws(() => validateProse(wrap(body)), /no <Video 1> motion-only sentence/);
});

test("missing photoreal throws", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const prose = buildProse(s, room).replace("Photoreal. ", "");
  assert.throws(() => validateProse(wrap(prose)), /Photoreal/);
});

test("dialogue present but unquoted throws", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const prose = buildProse(s, room).replace('"你嗰晚喺邊？講。"', "你嗰晚喺邊？講。");
  assert.throws(() => validateProse(wrap(prose), { requireQuote: true }), /spoken line missing/);
});

test("buildProsePositive assigns Picture tags and timed beats", () => {
  const { sheet: s, shot: sh } = interrogationShot();
  const body = buildProsePositive(s, sh, {
    portraits: [{ id: "A", name: "阿月" }, { id: "B", name: "阿衡" }],
  });
  assert.match(body, /^Photoreal\. 舊式審判室/);
  assert.ok(body.includes("<Picture 1> = scene still."));
  assert.ok(body.includes("<Picture 2> = 阿月."));
  assert.ok(body.includes("[0-"));
  assert.ok(!body.includes("<Video 1>"));
  validateProsePositive(wrap(body), { requireQuote: true });
});

test("buildProsePositive motionOnly skips Picture assignment lines", () => {
  const { sheet: s, shot: sh } = interrogationShot();
  const body = buildProsePositive(s, sh, { motionOnly: true });
  assert.equal(body.includes("<Picture 1>"), false);
  validateProsePositive(wrap(body), { requireQuote: true, motionOnly: true });
});

test("validateProsePositive rejects grey-model negatives", () => {
  const { sheet: s, shot: sh } = interrogationShot();
  const body = buildProsePositive(s, sh);
  assert.throws(
    () => validateProsePositive(wrap(`${body}\n\nignore grey placeholders.`)),
    /ignore\/do-not\/grey negatives/,
  );
});

test("location is trimmed to its first clause, keeping the header readable", () => {
  const s = sheet();
  s.location = "Ming-dynasty field, dark turned furrows";
  const solo = { ...shot(""), marks: [mark("A", 40)], action: "阿月一個人走過田埂，回頭望一望" };
  assert.equal(pickProseMode(s, solo), "action-short");
  const body = buildProse(s, solo);
  assert.ok(body.startsWith("Photoreal. Ming-dynasty field, night."));
});

test("③a: 'overall_soundscape:' is unbanned; real label lines stay banned (F2 stands)", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const prose = buildProse(s, room);
  assert.ok(prose.includes("low bed"), "sound design field present");
  // the concept is free prose now — mid-line or line-start, no ban
  validateProse(
    wrap(`${prose}\n\nThe overall_soundscape is described above in prose.`),
    { requireQuote: true },
  );
  validateProse(wrap(`${prose}\n\noverall_soundscape: rain bed`), { requireQuote: true });
  // genuine labels still fail loud: named-list member and generic line-start
  assert.throws(
    () => validateProse(wrap(`${prose}\n\nsummary: 兩句`), { requireQuote: true }),
    /summary/,
  );
  assert.throws(
    () => validateProse(wrap(`${prose}\n\nCamera: 35mm手持`), { requireQuote: true }),
    /label line/,
  );
});

test("③a: timingRef rides the #31 sentence (Audio 2 as timing reference)", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const body = buildProse(s, room, { timingRef: true });
  assert.ok(body.includes("Audio 2"), "Audio 2 role named");
  assert.ok(body.includes("cuts land on its beats"), "#31 beats sentence");
  // dialogue still introduces as the Audio 1 line — exactly one dialogue wav
  assert.ok(body.includes('speaks the line in Audio 1: "你嗰晚喺邊？講。"'));
  validateProse(wrap(body), { requireQuote: true, wardrobe: wardrobeClauses(s) });
});

test("③b: UI shot prose — mapping table, camera lock, move whitelist, verbatim on-screen text", () => {
  const { sheet: s, shot: room } = interrogationShot();
  const ui: UiShotSpec = {
    cards: [{ label: "LUMI HARE" }, { label: "IRON MOLE" }],
    onscreen: [{ text: "LOOK盤 323.2", where: "top-centre of the hero card" }],
    replace: [{ from: "2021年9月", to: "2026年9月", where: "in the date field, bottom-left" }],
  };
  const body = buildProse(s, room, { ui });
  assert.ok(body.includes("<Picture 1> = the UI layout, typography and colour reference."));
  assert.ok(body.includes("<Picture 2> = the LUMI HARE card."));
  assert.ok(body.includes("<Picture 3> = the IRON MOLE card."));
  assert.ok(body.includes("The camera stays locked on the interface."));
  assert.ok(body.includes("Only the cursor, the selection state"), "default move whitelist (#34)");
  assert.ok(body.includes("「LOOK盤 323.2」 appears top-centre"), "verbatim quote + placement");
  assert.ok(
    body.includes("「2021年9月」 becomes 「2026年9月」 in the date field"),
    "old→new character-for-character (case06)",
  );
  assert.ok(body.includes("same typeface, size and position"), "style-unchanged clause");
  // ui forces identity-long and the motion contract still stands
  assert.ok(body.includes("<Video 1>"));
  validateProse(wrap(body), { requireQuote: true, wardrobe: wardrobeClauses(s) });
  const hits = body.split("\n").filter((l) => LABEL_LINE.test(l));
  assert.deepEqual(hits, [], "no label lines in UI prose");
});

test("③b: on-screen text over 6 詞 fails loud; story shots carry no UI lines", () => {
  const { sheet: s, shot: room } = interrogationShot();
  assert.throws(
    () =>
      validateUiSpec({
        onscreen: [{ text: "香港樓價指數連續十三個月上升創歷史新高紀錄", where: "top" }],
      }),
    /over 6 詞/,
  );
  assert.throws(
    () => validateUiSpec({ onscreen: [{ text: "323.2", where: " " }] }),
    /position-level placement/,
  );
  const story = buildProse(s, room);
  assert.equal(story.includes("<Picture 1>"), false, "story prose assigns no Picture slots");
});

test("graph stays identical in both prose modes (proseMode is metadata only)", () => {
  const models = {
    textEncoder: defaultConfig.motion.textEncoder,
    encoderType: "minimax",
    videoVae: defaultConfig.motion.videoVae,
    audioVae: defaultConfig.motion.audioVae,
    ref2va: defaultConfig.motion.checkpoint,
    fl2va: defaultConfig.motion.fl2va,
    turboLora: defaultConfig.motion.turboLora,
  };
  // §5b A-form args (no Video 1 — keyframes lane); steps 4 keeps FBC so the
  // node set stays maximal while proseMode varies
  const base = {
    script: "__PROMPT__",
    bindings: BINDINGS,
    frames: 260,
    steps: 4,
    seed: 42,
    filenamePrefix: "video/SLATECREW/__SHOT__",
    kfStartName: "__KF_START__",
    wavName: "line.wav",
    models,
  };
  const a = buildH3Graph({ ...base, proseMode: "action-short" });
  const b = buildH3Graph({ ...base, proseMode: "identity-long" });
  const c = buildH3Graph({ ...base });
  assert.deepEqual(a, b);
  assert.deepEqual(a, c);
});
