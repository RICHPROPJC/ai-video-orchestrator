import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import {
  cjkCount,
  isIndoorLocation,
  isLocationFail,
  isRoomNoun,
  keyframeEditPrompt,
  keyframeRequire,
  negativePoison,
  propNounClass,
  sceneLine,
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
  const n = cjkCount(text);
  assert.ok(n >= 150, `≥150 中文字，got ${n}`);
  assert.ok(n <= 300, `≤300 中文字，got ${n}`);
  assert.ok(text.includes("地下室"), "require.location 原句全文");
  assert.ok(text.includes("完全照 Image-1"), "Image-1 錨句");
  assert.ok(text.includes(`；禁止${PACKET_NEGS.join("、")}`), "packet negatives 組裝");
});

test("T41 E2: 六行電報薄 packet → 生成器拒出 prompt_too_thin", () => {
  const thin: Shot = {
    ...shotWithProp(),
    marks: [shotWithProp().marks[0]!],
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
  const prompt = keyframeEditPrompt(sheet, shotWithProp(coat), { first: true });
  assert.ok(prompt.includes("角色一") && prompt.includes("角色二"), "sheet-internal names stay");
  assert.ok(!/\.(png|jpe?g|webp)/i.test(prompt), `image filename leaked: ${prompt}`);
  assert.ok(!/(portraits|blockout|stills)\//.test(prompt), `lane path leaked: ${prompt}`);
});

test("noun classes: garments and documents never take the held-tool gate; 犁/槍/鋤 do", () => {
  for (const name of ["軍大衣", "蓑衣", "斗篷 cloak", "leather jacket", "silk robe"]) {
    assert.equal(propNounClass(name), "garment", `${name} is a garment`);
    assert.equal("tool" in keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })), false);
  }
  for (const name of ["詔書", "通緝令", "書信", "地圖", "secret letter", "land deed"]) {
    assert.equal(propNounClass(name), "document", `${name} is a document`);
    assert.equal("tool" in keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })), false);
  }
  for (const name of ["曲轅犁", "長槍", "鋤頭"]) {
    assert.equal(propNounClass(name), "tool", `${name} is a held tool`);
    assert.equal(keyframeRequire(shotWithProp({ name, shape: [], forbid: [] })).tool, name);
  }
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
  assert.ok(text.includes(shots[0]!.require!.location), "scene line names the packet location");
  assert.ok(text.includes(`；禁止${PACKET_NEGS.join("、")}`), "packet negatives assembled verbatim (Chau 17:48)");
  assert.ok(!text.includes(`，${fx.sheet.timeOfDay}，${fx.sheet.weather}`), "sheet 公版尾（timeOfDay，weather）absent");
  assert.ok(!text.includes(fx.sheet.location), "the sheet-wide location is gone too");
  for (const poison of POISON) assert.ok(!text.includes(poison), `no "${poison}"`);
});

test("T32 Chau 17:48: 錨段 anchors background structure, walls and interior/exterior to Image-1", () => {
  const { fx, sheet } = ldSheet();
  const text = keyframeEditPrompt(sheet, fx.shots[0]!, { first: true });
  assert.ok(
    text.includes("人偶位置、姿勢、比例、鏡位、地平線、背景結構、牆面、室內外完全照 Image-1"),
    "anchor line carries 背景結構、牆面、室內外",
  );
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
    assert.ok(text.includes(shot.require!.location), `${shot.id} names the packet location`);
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
