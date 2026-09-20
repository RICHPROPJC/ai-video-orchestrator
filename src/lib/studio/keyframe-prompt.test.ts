import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import { keyframeEditPrompt, keyframeRequire, propNounClass, cjkCount, EDIT_MIN_CJK, EDIT_MAX_CJK } from "./keyframe-prompt";
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

const sheet: CallSheet = {
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
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: false });
  assert.ok(text.includes("軍大衣"), "prop name from sheet");
  assert.ok(text.includes("係一件衣物"), "card: garment-class sentence present");
  assert.ok(!text.includes("木犁"), "card: no 木犁");
  assert.ok(!text.includes("犁"), "no plow character at all — not even the forbid echo");
  assert.ok(/披上|着住/.test(text), "described as clothing on the body (披上／着住)");
});

test("garment prop: later-shot continuity carries the coat, not the 犁", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: false });
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
  const text = keyframeEditPrompt(sheet, shotWithProp(decree), { first: false });
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
  const text = keyframeEditPrompt(sheet, shotWithProp(plow), { first: false });
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
  const text = keyframeEditPrompt(sheet, shotWithProp(spear), { first: true });
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

test("BUG3: scene truth source is ONE field — require.location, then shot.location, sheet tail last (Fable 1d9bb51)", () => {
  const packet = shotWithProp();
  packet.require = { location: "地下室" };
  assert.ok(keyframeEditPrompt(sheet, packet, { first: false }).includes("【場景】地下室"), "packet require.location wins");
  const ownRoom = shotWithProp();
  ownRoom.location = "走廊";
  assert.ok(keyframeEditPrompt(sheet, ownRoom, { first: false }).includes("【場景】走廊"), "shot's own room next");
  assert.ok(
    keyframeEditPrompt(sheet, shotWithProp(), { first: false }).includes("【場景】亂葬崗"),
    "sheet tail only as the last fallback",
  );
});

test("BUG3: the brief is 150–300 中文字 — thin refuses (prompt_too_thin), fat refuses (prompt_too_thick)", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: false });
  const n = cjkCount(text);
  assert.ok(n >= EDIT_MIN_CJK && n <= EDIT_MAX_CJK, `2-char brief in band: ${n}`);
  // thin: no marks at all cannot reach 150 — refuse, never a six-line telegram
  const empty = shotWithProp();
  empty.marks = [];
  assert.throws(() => keyframeEditPrompt(sheet, empty, { first: true }), /prompt_too_thin/);
  // fat: five dressed characters push the brief past 300 — refuse (法11 no compensation)
  const many: Character[] = ["一", "二", "三", "四", "五"].map((suffix, i) => ({
    id: `C${i}`,
    name: `角色${suffix}`,
    role: "舊同事",
    wardrobe: "白襯衫",
    palette: ["#111", "#222", "#333"] as [string, string, string],
    voice: { pitchHz: 180, gender: "m" as const },
  }));
  const fatSheet: CallSheet = { ...sheet, characters: [...sheet.characters, ...many] };
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

test("C1: the 45° clause costs band width — a fat two-hander refuses loud (prompt_too_thick, 法11)", () => {
  const shot = shotWithProp(coat);
  shot.refAngle = "45";
  assert.throws(() => keyframeEditPrompt(sheet, shot, { first: true }), /prompt_too_thick/);
});

test("C1: absent refAngle stays front (old facing sentence, no 動作 line)", () => {
  const text = keyframeEditPrompt(sheet, shotWithProp(coat), { first: true });
  assert.ok(text.includes("朝向同動作跟 Image-1 人偶"), "front default unchanged");
  assert.ok(!text.includes("【動作】"), "no 動作 line without require.action/pose");
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
  assert.equal(cjkCount(without), cjkCount(brief), "the lock never pads the brief band");
  const n = cjkCount(brief);
  assert.ok(n >= EDIT_MIN_CJK && n <= EDIT_MAX_CJK, `brief alone stays in band: ${n}`);
  // Editing PE pair order: the change extras (動作) then the keep lock, facts last
  const both = shotWithProp(coat);
  both.require = { facts: INFO_FACTS, unchanged: ["右後牆身照舊係空牆"], action: "俯身雙手撐地、上身抬起" };
  const ftext = keyframeEditPrompt(sheet, both, { first: false });
  assert.ok(ftext.indexOf("【動作】") < ftext.indexOf("【不變】"), "change extras before the keep lock");
  assert.ok(ftext.indexOf("【不變】") < ftext.indexOf("【上屏事實】"), "keep lock before the facts block");
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
