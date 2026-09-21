import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import {
  cjkCount,
  EDIT_MAX_CJK,
  EDIT_MIN_CJK,
  isIndoorLocation,
  isLocationFail,
  isRoomNoun,
  keyframeEditPrompt,
  keyframeRequire,
  loadBaseCast,
  negativePoison,
  propNounClass,
  scrubSystemDisplayForbid,
  sceneLine,
  sceneLocation,
  sceneRetryNormalize,
  sceneRetrySchema,
  sceneRetryUser,
} from "./keyframe-prompt";
import { chatJson, DEFAULT_CREW, SchemaMismatchError, type CrewConfig } from "./crew-llm";
import { loadTraceFixture } from "./trace";
import type { CallSheet, Character, Shot, ShotProp } from "./types";
/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom.)
 *  Story nouns (frozen sheet proper names) live in trace-fixtures/, never
 *  here — the noun-lint fails on any of them in src code. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const baseSheet: CallSheet = {
  title: "t",
  logline: "l",
  language: "zh-Hant",
  location: "亂葬崗",
  timeOfDay: "dusk",
  weather: "wind",
  mood: "m",
  durationSec: 4,
  aspect: "16:9",
  characters: [
    { id: "A", name: "角色一", role: "保險調查員", wardrobe: "深藍乾濕褸", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
    { id: "B", name: "角色二", role: "舊同事", wardrobe: "白襯衫", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
  ],
  styleBible: { grade: "g", refs: [], stillModel: "u15", motionModel: "h3" },
  shots: [],
  voiceover: "",
} satisfies CallSheet;

/** lane/crew tests address the fixture as `sheet`; seats calls it `baseSheet` — one object, two names (MERGE_THREE_0921) */
const sheet: CallSheet = baseSheet;

function shotWithProp(prop?: ShotProp): Shot {
  return {
    id: "SH07",
    index: 6,
    heading: "7",
    size: "medium",
    location: "亂葬崗",
    action: "扯過件外套披上肩",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
      { characterId: "B", start: { x: 70, y: 50 }, end: { x: 70, y: 50 }, facing: 1, handL: { x: 66, y: 45 }, handR: { x: 74, y: 45 }, footL: { x: 68, y: 80 }, footR: { x: 72, y: 80 }, gait: "plant" },
    ],
    ...(prop ? { props: [prop] } : {}),
    stillPrompt: "",
    motionPrompt: "",
  } satisfies Shot;
}

const coat: ShotProp = { name: "軍大衣", heldBy: "A", shape: ["披", "肩"], forbid: ["木犁", "鐵犁鏵"] };
const decree: ShotProp = { name: "通緝令", heldBy: "A", shape: ["紙", "字"], forbid: ["木犁", "鋤頭"] };

test("T41 E1: fixture SH01 packet → /edit 150–300 中文字, require.location 原句, Image-1 錨", () => {
  const { fx, sheet } = ldSheet();
  const shot: Shot = { ...fx.shots[0]!, require: { location: "地下室", angle: "high", negatives: PACKET_NEGS } };
  const text = keyframeEditPrompt({ ...sheet, shots: [shot] }, shot, { first: true });
  const brief = text.split(/\n\n【動作】/)[0]!;
  const n = cjkCount(brief);
  assert.ok(n >= 150, `≥150 中文字，got ${n}`);
  assert.ok(n <= 300, `≤300 中文字，got ${n}`);
  assert.ok(text.includes("地下室"), "require.location 原句全文");
  assert.ok(text.includes("人偶嘅位置、姿勢、佔位保持照 Image-1"), "Image-1 錨句（BUG3 法1 準錨，唔再完全照）");
  assert.ok(text.includes(`；禁止${PACKET_NEGS.join("、")}`), "packet negatives 組裝");
  assert.ok(text.includes("【動作】"), "packet action rides after the band");
});

test("T41 E2: 六行電報薄 packet → 生成器拒出 prompt_too_thin", () => {
  const thin: Shot = {
    ...shotWithProp(),
    marks: [],
    props: undefined,
    action: "",
    stillPrompt: "",
  };
  const thinSheet: CallSheet = {
    ...baseSheet,
    characters: [{ ...baseSheet.characters[0]!, wardrobe: "衫" }],
  };
  assert.throws(() => keyframeEditPrompt(thinSheet, thin, { first: true }), /prompt_too_thin/, "薄 packet 拒出，唔交電報");
});

test("BUG3 follow: no-prop closeup (WR1Q SH04 class) still clears the 150 floor via 【動作】/景別 extras", () => {
  // wr1q9: cookbook brief 140 < 150 after banned-phrase cut; packet fill refused —
  // floor now counts the emitted prompt. Empty marks still throw (T41 E2).
  const shot: Shot = {
    ...shotWithProp(),
    marks: [shotWithProp().marks[0]!],
    props: undefined,
    size: "closeup",
    location: "地下室",
    action: "五指收攏握向光框，藍光喺指縫間收細。",
  };
  const text = keyframeEditPrompt(baseSheet, shot, { first: true });
  assert.ok(cjkCount(text) >= EDIT_MIN_CJK, `emitted ${cjkCount(text)} ≥ ${EDIT_MIN_CJK}`);
  const brief = text.split(/\n\n【動作】/)[0]!;
  assert.ok(cjkCount(brief) <= EDIT_MAX_CJK, "cookbook brief stays under 300");
});

test("T32b C5: isRoomNoun 收場所名詞、拒機構全名；zod 同判", () => {
  assert.equal(isRoomNoun("地下室"), true);
  assert.equal(isRoomNoun("宿舍"), true);
  assert.equal(isRoomNoun("走廊"), true);
  assert.equal(isRoomNoun("總統府地下審判室"), false, "機構全名（府）拒");
  assert.equal(isRoomNoun("滄瀾軍校男生宿舍"), false, "機構全名（軍校＋超 8 字）拒");
  assert.equal(sceneRetrySchema.safeParse({ thinking: "改", location: "地下室" }).success, true);
  const bad = sceneRetrySchema.safeParse({ thinking: "改", location: "總統府地下審判室" });
  assert.equal(bad.success, false, "zod 拒機構全名");
  assert.match(JSON.stringify(bad.error!.issues), /場所名詞/);
});

test("T32b C3: scene-retry 請求自帶 output_schema，例子用地下室", () => {
  const { fx } = ldSheet();
  const user = sceneRetryUser(fx.shots[0]!, ["location: 0/3"]);
  assert.ok(user.includes("output_schema"), "packet 明文 output_schema");
  assert.ok(user.includes("例：地下室"), "output_schema location 例用地下室");
  assert.ok(!/"location": "[^"]*府/.test(user.replace(/currentLocation[^,]*,/, "")), "schema 例唔用劇名");
  assert.ok(user.includes("灰模概念圖"), "Image-1 係灰模一句");
  assert.ok(user.includes(fx.shots[0]!.location), "currentLocation 原句照抄畀阿圖判斷（輸出先受 C5 管制）");

});

/** Card D 掣2: a text/data screen without require.facts refuses to emit —
 *  the prompt_too_thin shape (fail loud at composition, never a thin emit). */
const INFO_FACTS = [
  { claim: "2026年6月私人住宅售價指數報323.2點", source: "https://example.hk/rvd", fetched_at: "2026-09-19" },
  { claim: "指數連升13個月", source: "https://example.hk/rvd", fetched_at: "2026-09-19" },
];

function screenShot(overrides: Partial<Shot> = {}): Shot {
  return {
    ...shotWithProp(),
    action: "螢幕顯示樓價指數走勢圖表",
    ...overrides,
  } satisfies Shot;
}

test("infographic shot without facts refuses to emit (facts_missing, prompt_too_thin shape)", () => {
  assert.throws(
    () => keyframeEditPrompt(sheet, screenShot(), { first: false }),
    /facts_missing: SH07/,
    "text screen with no facts throws",
  );
  assert.throws(
    () => keyframeEditPrompt(sheet, screenShot(), { first: false }),
    /去PE步攞/,
    "the error says where facts come from (PE step)",
  );
});

test("factsRequired flag alone (no 圖表 words) also trips the gate; normal shots never do", () => {
  const flagged = shotWithProp();
  flagged.require = { factsRequired: true };
  assert.throws(() => keyframeEditPrompt(sheet, flagged, { first: false }), /facts_missing/);
  // a plain story shot (no screen words, no flag) still composes untouched
  const plain = keyframeEditPrompt(sheet, shotWithProp(coat), { first: false });
  assert.ok(!plain.includes("上屏事實"), "no facts block on a plain shot");
});

test("facts shot with packet rows emits the facts block verbatim and carries facts into require", () => {
  const shot = screenShot({ require: { facts: INFO_FACTS } });
  const text = keyframeEditPrompt(sheet, shot, { first: false });
  for (const f of INFO_FACTS) {
    assert.ok(text.includes(f.claim), `claim verbatim: ${f.claim}`);
    assert.ok(text.includes(f.source), "source verbatim");
    assert.ok(text.includes(f.fetched_at), "fetched_at verbatim");
  }
  assert.ok(text.includes("【上屏事實】"), "facts block header present");
  const req = keyframeRequire(shot);
  assert.deepEqual(req.facts, INFO_FACTS, "QC require carries the same facts rows");
});

test("prop name alone (數據卡 as a prop) trips the facts gate too", () => {
  const card = screenShot({ action: "遞出一張卡", props: [{ name: "數據卡", shape: ["卡"], forbid: [] }], require: {} });
  assert.throws(() => keyframeEditPrompt(sheet, card, { first: false }), /facts_missing/);
});

test("garment prop: prompt names the coat as clothing, never a plow (SH07 class)", () => {
  const text = keyframeEditPrompt(baseSheet,shotWithProp(coat), { first: false });
  assert.ok(text.includes("軍大衣"), "prop name from sheet");
  assert.ok(text.includes("係一件衣物"), "card: garment-class sentence present");
  assert.ok(!text.includes("木犁"), "card: no 木犁");
  assert.ok(!text.includes("犁"), "no plow character at all — not even the forbid echo");
  assert.ok(/披上|着住/.test(text), "described as clothing on the body (披上／着住)");
});

test("garment prop: later-shot continuity carries the coat, not the 犁", () => {
  const text = keyframeEditPrompt(baseSheet,shotWithProp(coat), { first: false });
  assert.ok(text.includes("Image-2 係上一鏡嘅定格"), "continuity line present");
  assert.ok(text.includes("軍大衣、光線同色調"), "the garment is the carried prop");
  assert.ok(!text.includes("犁"), "no plow in the carry-over list");
});

test("garment prop: require keeps people_count + grey_blocks, no tool gate", () => {
  const req = keyframeRequire(shotWithProp(coat));
  assert.equal(req.people_count, 2);
  assert.equal(req.grey_blocks, false);
  assert.equal("tool" in req, false, "card: require has no tool");
  assert.equal("tool_shape" in req, false);
  assert.equal("tool_forbid" in req, false);
});

test("paper prop (SH09 class): flat document sentence — no 木犁 in prompt, require has no tool", () => {
  const text = keyframeEditPrompt(baseSheet,shotWithProp(decree), { first: false });
  assert.ok(text.includes("通緝令"), "prop name from sheet");
  assert.ok(text.includes("紙本文書"), "described as a flat paper document");
  assert.ok(!text.includes("木犁"), "card: paper-prop fixture ⇒ no 木犁 in prompt");
  assert.ok(!text.includes("犁"), "no plow character at all");
  assert.ok(!text.includes(decree.forbid.join("、")), "no forbid echo for documents either");
  assert.ok(text.includes("通緝令、光線同色調"), "the document is the carried prop");
  const req = keyframeRequire(shotWithProp(decree));
  assert.equal(req.people_count, 2);
  assert.equal("tool" in req, false, "card: require has no tool");
  assert.equal("tool_shape" in req, false);
  assert.equal("tool_forbid" in req, false);
});

test("tool prop (犁): plow sentence + tool gate unchanged", () => {
  const plow: ShotProp = { name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] };
  const text = keyframeEditPrompt(baseSheet,shotWithProp(plow), { first: false });
  assert.ok(text.includes("曲轅犁"), "prop name from sheet");
  assert.ok(text.includes("一件完整木犁"), "plow sentence kept for real tools");
  assert.ok(text.includes("唔係锹、铲、锄"), "forbid list from sheet");
  const req = keyframeRequire(shotWithProp(plow));
  assert.equal(req.tool, "曲轅犁");
  assert.deepEqual(req.tool_shape, ["弯", "木", "插入"]);
  assert.deepEqual(req.tool_forbid, ["锹", "铲", "锄"]);
});

test("tool prop (槍): not a garment or document, keeps the tool gate", () => {
  const spear: ShotProp = { name: "長槍", heldBy: "B", shape: ["长", "杆", "尖"], forbid: ["剑", "戟"] };
  const text = keyframeEditPrompt(baseSheet,shotWithProp(spear), { first: true });
  assert.ok(text.includes("長槍"), "prop name from sheet");
  assert.ok(text.includes("犁"), "one-tool gate vocabulary present");
  assert.equal(keyframeRequire(shotWithProp(spear)).tool, "長槍");
});

test("T36 lock: prompts carry character names but never a refs filename", () => {
  // the stills lane's refs are runtime files (portraits/SH f0/prev keyframe);
  // their filenames must never leak into the prompt — character names stay
  const prompt = keyframeEditPrompt(baseSheet, shotWithProp(coat), { first: true });
  assert.ok(prompt.includes("角色一") && prompt.includes("角色二"), "sheet-internal names stay");
  assert.ok(!/\.(png|jpe?g|webp)/i.test(prompt), `image filename leaked: ${prompt}`);
  assert.ok(!/(portraits|blockout|stills)\//.test(prompt), `lane path leaked: ${prompt}`);
});

test("system-display tool: require strips screen/螢幕 from tool_forbid (§0c)", () => {
  const frame: ShotProp = { name: "全息光框", heldBy: "A", shape: ["glow", "rect"], forbid: ["phone", "screen", "book", "螢幕"] };
  const req = keyframeRequire(shotWithProp(frame));
  assert.equal(req.tool, "全息光框");
  assert.deepEqual(req.tool_forbid, ["phone", "book"]);
  assert.deepEqual(scrubSystemDisplayForbid("infograph", ["screen", "phone"]), ["phone"]);
  const plow: ShotProp = { name: "曲轅犁", heldBy: "A", shape: ["弯"], forbid: ["screen", "锹"] };
  assert.deepEqual(keyframeRequire(shotWithProp(plow)).tool_forbid, ["screen", "锹"]);
});
test("W3: the style grade mounts as the 風格光照 section, riding after the band; empty grade mounts nothing", () => {
  const graded: CallSheet = { ...sheet, styleBible: { ...sheet.styleBible, grade: "慘白光管冷青底色低飽和" } };
  const withAction: Shot = { ...shotWithProp(coat), require: { action: "扯過件外套披上肩定格。" } };
  const text = keyframeEditPrompt(graded, withAction, { first: true });
  assert.match(text, /【風格光照】成格畫面嘅色調、光源、飽和度跟呢句 style grade：「慘白光管冷青底色低飽和」/);
  assert.ok(text.indexOf("【風格光照】") > text.indexOf("【光影材質】"), "style rides after the band (extras, not brief)");
  assert.ok(text.indexOf("【風格光照】") < text.indexOf("【動作】"), "style rides before the action block");

  const bare = keyframeEditPrompt({ ...sheet, styleBible: { ...sheet.styleBible, grade: "  " } }, shotWithProp(coat), { first: true });
  assert.ok(!bare.includes("【風格光照】"), "empty grade mounts no section");

  // the fixture sheet's 1-char grade must also ride (default path unchanged)
  assert.match(keyframeEditPrompt(sheet, shotWithProp(coat), { first: true }), /「g」/);
});

test("noun classes: garments and documents never take the held-tool gate; hologram props carry it; 犁/槍/鋤 do", () => {  for (const name of ["軍大衣", "蓑衣", "斗篷 cloak", "leather jacket", "silk robe"]) {
    assert.equal(propNounClass(name), "garment", `${name} is a garment`);
    assert.equal("tool" in keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })), false);
  }
  for (const name of ["詔書", "通緝令", "書信", "地圖", "secret letter", "land deed"]) {
    assert.equal(propNounClass(name), "document", `${name} is a document`);
    assert.equal("tool" in keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })), false);
  }
  for (const name of ["藍色光框", "全息投影", "全息界面", "戰術infograph", "holographic frame"]) {
    assert.equal(propNounClass(name), "system", `${name} is a hologram/infograph prop`);    assert.equal(keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })).tool, name, `${name} carries the prop gate`);
  }
  for (const name of ["曲轅犁", "長槍", "鋤頭"]) {
    assert.equal(propNounClass(name), "tool", `${name} is a held tool`);
    assert.equal(keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })).tool, name);
  }
});

test("hologram prop (藍色光框, WR1Q SH02 class): infograph three-layer sentence, never the plow, no forbid echo", () => {
  const frame: ShotProp = { name: "藍色光框", heldBy: "A", shape: ["光", "框"], forbid: ["phone", "screen", "book"] };
  const text = keyframeEditPrompt(baseSheet, shotWithProp(frame), { first: false });  assert.ok(text.includes("藍色光框"), "prop name from sheet");
  assert.ok(/圖表/.test(text), "§0c: chart layer written out");
  assert.ok(/UI/.test(text), "§0c: UI frame layer written out");
  assert.ok(/文字/.test(text), "§0c: text-label layer written out — bare text card is not an infograph");
  assert.ok(!text.includes("犁"), "no plow vocabulary");
  assert.ok(!text.includes("螢幕") && !text.includes("screen"), "no screen word in the /edit prompt");
  assert.ok(!text.includes(frame.forbid.join("、")), "no forbid echo for hologram props");
});

/** T32 frozen LD0F excerpt (SH01–SH05, one indoor set, sheet tail night/neon).
 * Story nouns stay inside the fixture — the noun-lint holds that line. */
type LdFixture = {
  frozen: boolean;
  sheet: Pick<CallSheet, "location" | "timeOfDay" | "weather">;
  characters: Character[];
  shots: Shot[];
};

const POISON = ["neon", "霓虹", "night"] as const;

function ldSheet(): { fx: LdFixture; sheet: CallSheet } {
  const fx = loadTraceFixture("ld0f-sh01") as unknown as LdFixture;
  const sheet = {
    ...baseSheet,
    location: fx.sheet.location,
    timeOfDay: fx.sheet.timeOfDay,
    weather: fx.sheet.weather,
    characters: fx.characters,
    shots: fx.shots,
  } satisfies CallSheet;
  return { fx, sheet };
}

/** rev2 口徑: 阿圖 packet 載入 require.location（Chau 22:24 後 packet 一律房間名詞）。 */
const PACKET_NEGS = ["街道", "路燈", "招牌燈箱", "濕地反光"];

function packetShots(fx: LdFixture): Shot[] {
  return fx.shots.map((s) => ({ ...s, require: { location: "地下室", angle: "high" as const, negatives: PACKET_NEGS } }));
}

/** Injected fetch: replies in call order, one per call. No socket. */
function fakeFetch(replies: string[]) {
  let n = 0;
  const impl = (async () => {
    const content = replies[Math.min(n, replies.length - 1)]!;
    n += 1;
    return new Response(
      JSON.stringify({ choices: [{ message: { content, reasoning_content: "" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return impl;
}

const crewCfg: CrewConfig = { ...DEFAULT_CREW, endpoint: "http://crew.invalid:4000" };

test("T32b C1: 阿圖回 charter 形 → sceneRetryNormalize map 後 valid=true", async () => {
  const charterReply = JSON.stringify({
    sceneId: "SC01",
    thinking: "呢鏡係室內，改做地下室。",
    shots: [
      { beatId: "SC01.B01", size: "wide", angle: "high", require: { location: "地下室", angle: "high" } },
    ],
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t32b-c1-"));
  const out = await chatJson({
    seat: "boards",
    unit: "SH01.scene-retry",
    model: "qwen-test",
    crew: crewCfg,
    system: "charter",
    user: sceneRetryUser({ ...shotWithProp(), id: "SH01" }, ["location: 0/3"]),
    schema: sceneRetrySchema,
    normalize: sceneRetryNormalize,
    receiptDir: dir,
    fetchImpl: fakeFetch([charterReply]),
  });
  assert.equal(out.value.location, "地下室", "charter 形 shots[].require.location map 到頂層");
});

test("T32b C2: 垃圾 shape 三次 → SchemaMismatchError（schema_mismatch，attempt 0）", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t32b-c2-"));
  await assert.rejects(
    chatJson({
      seat: "boards",
      unit: "SH01.scene-retry",
      model: "qwen-test",
      crew: crewCfg,
      system: "charter",
      user: sceneRetryUser({ ...shotWithProp(), id: "SH01" }, ["location: 0/3"]),
      schema: sceneRetrySchema,
      normalize: sceneRetryNormalize,
      schemaJunkCeiling: 3,
      receiptDir: dir,
      sleepImpl: async () => {},
      fetchImpl: fakeFetch([JSON.stringify({ nope: 1 }), JSON.stringify({ wrong: "shape" }), JSON.stringify({ shots: "not-an-array" })]),
    }),
    (err: unknown) => {
      assert.ok(err instanceof SchemaMismatchError, "SchemaMismatchError");
      assert.equal(err.reason, "schema_mismatch");
      assert.equal(err.attemptsBurned, 0, "junk 唔燒 attempt");
      assert.equal(err.receipts.length, 3, "三次垃圾各留收據");
      return true;
    },
  );
  assert.equal(fs.readdirSync(dir).length, 3, "三份收據檔名唔相撞（seq）");
});

test("T32 rev2 A1: packet require.location writes the scene line — prompt carries no sheet tail", () => {
  const { fx, sheet } = ldSheet();
  const shots = packetShots(fx);
  const text = keyframeEditPrompt({ ...sheet, shots }, shots[0]!, { first: true });
  assert.ok(text.includes(shots[0]!.require!.location!), "scene line names the packet location");
  assert.ok(text.includes(`；禁止${PACKET_NEGS.join("、")}`), "packet negatives assembled verbatim (Chau 17:48)");
  assert.ok(!text.includes(`，${fx.sheet.timeOfDay}，${fx.sheet.weather}`), "sheet 公版尾（timeOfDay，weather）absent");
  assert.ok(!text.includes(fx.sheet.location), "the sheet-wide location is gone too");
  for (const poison of POISON) assert.ok(!text.includes(poison), `no "${poison}"`);
});

test("BUG3 SUPERSEDE T32 17:48: Image-1 只錨人偶位置/姿勢/佔位 — 場景結構唔跟灰模", () => {
  const { fx, sheet } = ldSheet();
  const text = keyframeEditPrompt(sheet, fx.shots[0]!, { first: true });
  assert.ok(text.includes("人偶嘅位置、姿勢、佔位保持照 Image-1"), "法1 準錨清單");
  assert.ok(text.includes("變嘅係質感、材質同光線"), "法1 變邊");
  assert.ok(!text.includes("地平線"), "banned 地平線");
  assert.ok(!text.includes("完全照 Image-1"), "banned 完全照");
});

test("T32 Chau 17:48: sceneLine assembles packet negatives only — no packet negatives, no 禁止 clause", () => {
  const { fx, sheet } = ldSheet();
  const base = { ...sheet, shots: [] };
  const shot = fx.shots[0]!;
  const withNegs = sceneLine(base, { ...shot, require: { location: shot.location, negatives: ["街道", "濕地反光"] } });
  assert.ok(withNegs.includes("；禁止街道、濕地反光"), "negatives joined verbatim");
  const noNegs = sceneLine(base, { ...shot, require: { location: shot.location } });
  assert.ok(!noNegs.includes("禁止"), "no packet negatives ⇒ no 禁止 clause — code authors no ban list");
  const outdoorNegs = sceneLine(base, { ...shot, require: { location: "北岸跑道，黃昏大風", negatives: ["路人"] } });
  assert.ok(outdoorNegs.includes("；禁止路人。"), "outdoor packet line assembles the same way");
});

test("T32 Chau 17:48: negativePoison flags the T29 poison tokens anywhere in a packet negative", () => {
  assert.equal(negativePoison(["霓虹招牌"]), "霓虹招牌");
  assert.equal(negativePoison(["clean", "NEON glow"]), "NEON glow");
  assert.equal(negativePoison(["night street"]), "night street");
  assert.equal(negativePoison(["招牌燈箱", "濕地反光"]), null, "de-poisoned vocabulary passes");
});

test("T32 rev2 A2: same-set later shots SH02–SH05 also drop the sheet tail", () => {
  const { fx, sheet } = ldSheet();
  const shots = packetShots(fx);
  for (const shot of shots.slice(1)) {
    const text = keyframeEditPrompt({ ...sheet, shots }, shot, { first: false });
    assert.ok(text.includes(shot.require!.location!), `${shot.id} names the packet location`);
    assert.ok(!text.includes(`，${fx.sheet.timeOfDay}，${fx.sheet.weather}`), `${shot.id} no sheet tail`);
  }
});

test("T32 rev2 (e2-min): no packet ⇒ shot.location writes the scene slot; sheet tail only when the shot has no room", () => {
  // WR1Q SH01 receipt: boards emitted require on 0/87 real shots, so the tail
  // (總統府…night，rain) was prompted while photo-qc gated on shot.location 地下室
  // — two truth sources, guaranteed 地點 FAIL. Prompt now reads the same field the gate reads.
  const { fx, sheet } = ldSheet();
  const shot = fx.shots[0]!;
  const text = keyframeEditPrompt(sheet, shot, { first: true });
  assert.ok(text.includes(shot.location), "without require.location the shot's own room writes the scene slot");
  assert.ok(
    !text.includes(`${fx.sheet.location}，${fx.sheet.timeOfDay}，${fx.sheet.weather}`),
    "sheet tail never rides a shot that names its room",
  );
  const roomless = keyframeEditPrompt(baseSheet, { ...shotWithProp(), location: "" }, { first: false });
  assert.ok(roomless.includes("亂葬崗，dusk，wind"), "sheet tail is the fallback only for a roomless shot");
  assert.equal(isIndoorLocation("亂葬崗"), false, "unknown location defaults outdoor");
});

test("T32 rev2 sceneLine: angle picks the light word; outdoor packet drops the tail entirely", () => {
  const { fx, sheet } = ldSheet();
  const loc = fx.shots[0]!.location;
  const base = { ...sheet, shots: [] };
  assert.ok(sceneLine(base, { ...fx.shots[0]!, require: { location: loc, angle: "high" } }).includes("頂光"), "high ⇒ 頂光");
  assert.ok(sceneLine(base, { ...fx.shots[0]!, require: { location: loc, angle: "eye" } }).includes("均勻室內光"), "eye ⇒ 均勻光");
  assert.ok(sceneLine(base, { ...fx.shots[0]!, require: { location: loc, angle: "low" } }).includes("低位室內光"), "low ⇒ 低位光");
  const outdoorLine = sceneLine(base, { ...fx.shots[0]!, require: { location: "北岸跑道，黃昏大風" } });
  assert.ok(outdoorLine.startsWith("北岸跑道，黃昏大風"), "outdoor packet line starts with the packet location");
  assert.ok(!outdoorLine.includes(fx.sheet.timeOfDay) && !outdoorLine.includes(fx.sheet.weather), "no sheet tokens");
});

test("T32 rev2 isLocationFail: only location-flavoured fail reasons route back to 阿圖", () => {
  assert.equal(isLocationFail(["location: require \"室內\"; blind=street"]), true, "location reason matches");
  assert.equal(isLocationFail(["people_count: require 2, saw 3"]), false, "people fail is not a location fail");
  assert.equal(isLocationFail(["tool: named=false"]), false, "tool fail is not a location fail");
  assert.equal(isLocationFail([]), false, "no reasons ⇒ no route");
});

test("T32 classifier: fixture sets are indoor; outdoor markers override indoor-looking chars", () => {
  const { fx } = ldSheet();
  for (const s of fx.shots) assert.equal(isIndoorLocation(s.location), true, `${s.id} location is a closed set`);
  assert.equal(isIndoorLocation(fx.sheet.location), false, "the sheet-wide open-country line is not indoor");
  assert.equal(isIndoorLocation("室外走廊"), false, "室外 outranks the 室 hit");
  assert.equal(isIndoorLocation("野外射擊場邊"), false, "野外 outranks any indoor char");
});

/** CARD_BUG3_0920: four banned sentences + families never appear in any /edit brief. */
/** CARD_BUG3_0920 (Chau 0917 法1/2/4/5): the four banned sentences and their
 *  families never appear in any composed /edit brief. */
const BUG3_BANNED = [
  "地平線", // 法1: 場景結構唔跟灰模
  "背景結構", // 法1
  "室內外", // 法1
  "完全照 Image-1", // 法1 原句尾巴
  "比例", // 法1/4 同族: 灰模比例唔係錨
  "鏡位", // 法1: 只準錨人偶位置/姿勢/佔位
  "夜只由室內燈", // 法2 廢話句
  "身高照", // 法4 無意義句
  "只借五官", // 法5 閹 ref
  "只借樣貌", // 法5 閹 ref（本 lane 原字眼）
  "髮際", // 法5 閹 ref
  "正面肖像", // 法6 逼角色正面對鏡頭
  "唔好加第三人", // 法5 冇錨 negative
  "唔好加人", // 法5 冇錨 negative（本 lane 原字眼）
];

test("BUG3: the four Chau-banned sentences never appear (first/later, every prop class, facts shots)", () => {
  const texts = [
    keyframeEditPrompt(sheet, shotWithProp(coat), { first: true }),
    keyframeEditPrompt(sheet, shotWithProp(coat), { first: false }),
    keyframeEditPrompt(sheet, shotWithProp(decree), { first: true }),
    keyframeEditPrompt(sheet, shotWithProp(), { first: false }),
    keyframeEditPrompt(sheet, screenShot({ require: { facts: INFO_FACTS } }), { first: false }),
  ];
  for (const text of texts) {
    for (const b of BUG3_BANNED) assert.ok(!text.includes(b), `banned phrase "${b}" leaked:\n${text}`);
  }
});

test("BUG3: Image-1 anchors puppet 位置/姿勢/佔位 only; the change/keep pair is explicit (法1)", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: true });
  assert.ok(text.includes("人偶嘅位置、姿勢、佔位保持照 Image-1"), "keep side: 法1 allowed anchor list verbatim");
  assert.ok(text.includes("變嘅係質感、材質同光線"), "change side: what the edit changes");
});

test("BUG3: Image-N 對號 — each ref is the character's dressed body, facing follows Image-1 (法5/6/9)", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: true });
  assert.ok(text.includes("左起第1個人偶＝Image-2 嘅角色角色一"), "puppet 1 → Image-2");
  assert.ok(text.includes("左起第2個人偶＝Image-3 嘅角色角色二"), "puppet 2 → Image-3");
  assert.ok(text.includes("面容、髮型同成套衫著照 Image-2"), "dressed-body ref, never face-only");
  assert.ok(text.includes("朝向同動作跟 Image-1 人偶"), "facing follows the blockout, not forced frontal");
  assert.ok(text.includes("淨係得呢2個角色"), "people count anchored to the puppets (法5)");
});

test("BUG3: scene truth source is ONE field — require.location, then shot.location, sheet tail last", () => {
  const packet = shotWithProp();
  packet.require = { location: "地下室" };
  assert.ok(keyframeEditPrompt(baseSheet, packet, { first: false }).includes("【場景】地下室"), "packet require.location wins");
  const ownRoom = shotWithProp();
  ownRoom.location = "走廊";
  assert.ok(keyframeEditPrompt(baseSheet, ownRoom, { first: false }).includes("【場景】走廊"), "shot's own room next");
  assert.ok(
    keyframeEditPrompt(baseSheet, shotWithProp(), { first: false }).includes("【場景】亂葬崗"),
    "sheet tail only as the last fallback",
  );
  assert.equal(sceneLocation(baseSheet, packet), "地下室");
});

test("BUG3: the brief is 150–300 中文字 — thin refuses, fat refuses", () => {
  const text = keyframeEditPrompt(baseSheet, shotWithProp(coat), { first: false });
  const brief = text.split(/\n\n【動作】/)[0]!;
  const n = cjkCount(brief);
  assert.ok(n >= EDIT_MIN_CJK && n <= EDIT_MAX_CJK, `2-char cookbook brief in band: ${n}`);
  assert.ok(cjkCount(text) >= EDIT_MIN_CJK, "emitted prompt (brief+action/size) clears the floor");
  const empty = shotWithProp();
  empty.marks = [];
  assert.throws(() => keyframeEditPrompt(baseSheet, empty, { first: true }), /prompt_too_thin/);
  const many: Character[] = ["一", "二", "三", "四", "五"].map((suffix, i) => ({
    id: `C${i}`,
    name: `角色${suffix}`,
    role: "舊同事",
    wardrobe: "白襯衫",
    palette: ["#111", "#222", "#333"] as [string, string, string],
    voice: { pitchHz: 180, gender: "m" as const },
  }));
  const fatSheet: CallSheet = { ...baseSheet, characters: [...baseSheet.characters, ...many] };
  const fat = shotWithProp();
  fat.marks = fatSheet.characters.map((c, i) => ({
    characterId: c.id,
    start: { x: 10 + i * 20, y: 50 },
    end: { x: 10 + i * 20, y: 50 },
    facing: 1,
    handL: { x: 12 + i * 20, y: 45 },
    handR: { x: 14 + i * 20, y: 45 },
    footL: { x: 8 + i * 20, y: 80 },
    footR: { x: 12 + i * 20, y: 80 },
    gait: "plant" as const,
  }));
  assert.throws(() => keyframeEditPrompt(fatSheet, fat, { first: true }), /prompt_too_thick/);
});

test("L1b loadBaseCast: missing file / empty roster = no override; wardrobe override lands in prompt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "base-cast-"));
  assert.equal(loadBaseCast(dir, "no-drama"), undefined);
  const drama = path.join(dir, "d1", "base");
  fs.mkdirSync(drama, { recursive: true });
  fs.writeFileSync(path.join(drama, "cast.json"), JSON.stringify({ characters: [{ id: "A", wardrobe: "紅大衣" }] }));
  const cast = loadBaseCast(dir, "d1");
  assert.equal(cast?.characters[0]?.wardrobe, "紅大衣");
  const text = keyframeEditPrompt(baseSheet, shotWithProp(coat), { first: true, cast });
  assert.ok(text.includes("紅大衣"), "base-cast wardrobe overrides the sheet");
  assert.ok(!text.includes("深藍乾濕褸"), "sheet wardrobe dropped when base-cast hits");

});

test("BUG3: the facts block rides AFTER the band — packet rows never pad the brief", () => {
  const shot = screenShot({ require: { facts: INFO_FACTS } });
  const text = keyframeEditPrompt(sheet, shot, { first: false });
  assert.ok(text.includes("【上屏事實】"), "facts block appended");
  const brief = text.split("\n\n【上屏事實】")[0]!;
  assert.ok(cjkCount(brief) >= EDIT_MIN_CJK, "brief alone still clears the floor without the packet rows");
  assert.ok(cjkCount(brief) <= EDIT_MAX_CJK, "brief alone stays under the ceiling");
});

/** Card C1 (FABLE_INTAKE_SORT_0920 序1, §0b 0920 釘): a refAngle "45" shot
 *  feeds angle refs, so facing follows the slot's own Image — never the
 *  standing frontal puppet; the 45° formula carries the eye guard + 90° ban;
 *  the scene line and the compound location word are one string; 動作
 *  (freeze frame + spatial sentence) rides after the band. Single mark —
 *  the SH01 verified shape. */
test("C1: refAngle 45 — facing follows Image-2 with eye guard + 90° ban; compound location verbatim; 動作 rides after the band", () => {
  const shot = shotWithProp(coat);
  shot.marks = [shot.marks[0]!];
  shot.refAngle = "45";
  shot.require = { location: "地下室檔案室", action: "俯身雙手撐地、上身抬起", pose: "體重由雙膝同雙手掌承住，大腿同地面成角度唔貼地" };
  const text = keyframeEditPrompt(sheet, shot, { first: true });
  assert.ok(text.includes("朝向跟 Image-2"), "the puppet's facing follows its own 45° ref");
  assert.ok(text.includes("唔好轉成90度純側面"), "the 90° ban rides the 45° facing clause");
  assert.ok(text.includes("雙眼"), "eye guard present");
  assert.ok(text.includes("姿勢同佔位跟 Image-1 人偶"), "pose/occupancy still anchor Image-1");
  assert.ok(!text.includes("朝向同動作跟 Image-1 人偶"), "the frontal-drag sentence is gone on a 45° shot");
  assert.ok(text.includes("【場景】地下室檔案室"), "scene line carries the compound word verbatim (require.location 注入)");
  assert.ok(
    text.includes("【動作】俯身雙手撐地、上身抬起。體重由雙膝同雙手掌承住，大腿同地面成角度唔貼地。"),
    "動作 block: freeze frame + spatial sentence, verbatim from the packet",
  );
  const brief = text.split("\n\n【動作】")[0]!;
  const n = cjkCount(brief);
  assert.ok(n >= EDIT_MIN_CJK && n <= EDIT_MAX_CJK, `brief stays in band with the 45° clause: ${n}`);
});

test("C1: the 45° clause costs band width — a fat crew refuses loud (prompt_too_thick, 法11)", () => {
  // MERGE_THREE_0921: seats' trimmed sentences need five dressed bodies to blow
  // the ceiling where the lane's two-hander did — same law, recalibrated mass
  const many: Character[] = ["一", "二", "三", "四", "五"].map((suffix, i) => ({
    id: `C${i}`,
    name: `角色${suffix}`,
    role: "舊同事",
    wardrobe: "白襯衫",
    palette: ["#111", "#222", "#333"] as [string, string, string],
    voice: { pitchHz: 180, gender: "m" as const },
  }));
  const fatSheet: CallSheet = { ...sheet, characters: [...sheet.characters, ...many] };
  const shot = shotWithProp(coat);
  shot.refAngle = "45";
  shot.marks = fatSheet.characters.map((c, i) => ({
    characterId: c.id,
    start: { x: 10 + i * 20, y: 50 },
    end: { x: 10 + i * 20, y: 50 },
    facing: 1,
    handL: { x: 14 + i * 20, y: 45 },
    handR: { x: 16 + i * 20, y: 45 },
    footL: { x: 8 + i * 20, y: 80 },
    footR: { x: 12 + i * 20, y: 80 },
    gait: "plant",
  }));
  assert.throws(() => keyframeEditPrompt(fatSheet, shot, { first: true }), /prompt_too_thick/);
});

test("C1: absent refAngle stays front (old facing sentence, no 動作 line)", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: true });
  assert.ok(text.includes("朝向同動作跟 Image-1 人偶"), "front default unchanged");
  assert.ok(text.includes("【動作】扯過件外套披上肩"), "boards action rides the 動作 slot when the packet is silent (0c636e9 fallback, MERGE_THREE_0921)");
  assert.ok(!text.includes("90度"), "no 45° vocabulary on a front shot");
});

/** Card 1b (Chau 批①, §0b 0920 background-creep law): the 【不變】 lock rides
 *  after the band as packet extras — walls/dressing/object positions held
 *  verbatim, never counted into the 150–300 brief, ahead of the facts block. */
test("C1b: require.unchanged emits the 【不變】 lock after the band, verbatim and outside the CJK count", () => {
  const shot = shotWithProp(coat);
  shot.require = {
    location: "地下室檔案室",
    unchanged: ["右後牆身照舊係空牆", "左邊檔案架同架上檔案照原位", "地下散住嘅文件照原位唔搬"],
  };
  const text = keyframeEditPrompt(sheet, shot, { first: false });
  assert.ok(text.includes("【不變】以下保持不變："), "lock header verbatim");
  assert.ok(text.includes("1. 右後牆身照舊係空牆"), "items verbatim, numbered");
  assert.ok(text.includes("3. 地下散住嘅文件照原位唔搬"), "every item carried");
  const brief = text.split("\n\n【不變】")[0]!;
  const noKeep = shotWithProp(coat);
  noKeep.require = { location: "地下室檔案室" };
  const without = keyframeEditPrompt(sheet, noKeep, { first: false });
  assert.ok(!without.includes("【不變】"), "no lock without require.unchanged — code never invents items");
// MERGE_THREE_0921: 景別 rides after the lock (union extras order), so the
  // no-lock text minus the with-lock text must equal exactly the lock block
  const withText = text;
  const lockStart = withText.indexOf("【不變】");
  const lockBlock = withText.slice(lockStart, withText.indexOf("\n\n", lockStart));
  assert.equal(cjkCount(withText) - cjkCount(without), cjkCount(lockBlock), "the lock is the only delta — it never pads the brief band");
  const n = cjkCount(brief);
  assert.ok(n >= EDIT_MIN_CJK && n <= EDIT_MAX_CJK, `brief alone stays in band: ${n}`);
  // Editing PE pair order: the change extras (動作) then the keep lock, facts last
  const both = shotWithProp(coat);
  both.require = { facts: INFO_FACTS, unchanged: ["右後牆身照舊係空牆"], action: "俯身雙手撐地、上身抬起" };
  const ftext = keyframeEditPrompt(sheet, both, { first: false });
  assert.ok(ftext.indexOf("【動作】") < ftext.indexOf("【不變】"), "change extras before the keep lock");
  assert.ok(ftext.indexOf("【不變】") < ftext.indexOf("【上屏事實】"), "keep lock before the facts block");});

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
