import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import http from "node:http";
import * as nodeTest from "node:test";
import {
  EYE_PROMPT,
  EYE_SAMPLING,
  JUDGE_SAMPLING,
  buildJudgePrompt,
  judge,
  judgePlainBackground,
  judgeSecondEye,
  lintEyeContent,
  lintEyePrompt,
  packageVerdict,
  pinQcAccepted,
  prepEyeLegs,
  resolveSecondEye,
  runPhotoQc,
  runSecondEye,
  sameRequire,
  type PackageJudge,
  type QcRequire,
} from "./photo-qc";
import { keyframeRequire } from "./keyframe-prompt";
import { PORTRAIT_REQUIRE } from "./portraits";

/** One file, three doors: bun 1.3 no longer sets BUN_TEST, so registration is
 *  lazy — node.test binds to the real runner (`bun test` / `tsx --test`); a
 *  direct `bun <this file>` run throws "outside of the test runner" at the
 *  first call and every case falls through to the self-driver below.
 *  (store.test.ts idiom, 0917 bun-1.3 fix) */
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
function test(name: string, fn: () => void | Promise<void>) {
  try {
    nodeTest.test(name, fn);
  } catch {
    cases.push({ name, fn });
  }
}

const DESC = "兩個人企喺茶餐廳門口，一個着深藍乾濕褸，一個着白襯衫，地面濕，背景係霓虹燈。";

// ─── PACKAGE-QC-0917 fixtures（素材照 quad/ 收據：u6_E_*, v7_judge_shen, expect_E）───

/** 眼描述（五路共用）：含「U1.5」「數位繪畫」「數碼寫實」——Chau 主點：數碼寫實＝寫實。 */
const EYE_DESC =
  "呢張圖片係由 U1.5 生成，呈現一位年長男性嘅半身肖像。畫面具有高度寫實感，接近高畫質攝影或數位繪畫。" +
  "佢着黑色立領中山裝，胸前口袋插住一支鋼筆。背景為純灰色漸層攝影棚底。整體係數碼寫實風格。";

const JUDGE_PASS_JSON: PackageJudge = {
  items: [
    { item: "人數", verdict: "達標", evidence: "【全圖】「一位年長男性嘅半身肖像」" },
    { item: "道具：鋼筆", verdict: "達標", evidence: "【全圖】「胸前口袋插住一支鋼筆」" },
    { item: "地點：攝影棚純灰底", verdict: "達標", evidence: "【全圖】「背景為純灰色漸層攝影棚底」" },
    { item: "風格", verdict: "達標", evidence: "【全圖】「具有高度寫實感，接近高畫質攝影或數位繪畫」" },
  ],
  contradictions: [],
  style: { verdict: "數碼寫實", evidence: "【全圖】「接近高畫質攝影或數位繪畫」" },
  pass: true,
  fail_reasons: [],
};

/** A2 對抗版：判官把「AI生成」當唔寫實（16:08 假fail 病）——守衞要推翻。 */
const JUDGE_DIGITAL_FAKEFAIL_JSON: PackageJudge = {
  items: JUDGE_PASS_JSON.items,
  contradictions: [],
  style: { verdict: "AI生成", evidence: "【全圖】「呢張圖片係由 U1.5 生成」" },
  pass: false,
  fail_reasons: ["風格唔達標：圖片係AI生成／數碼生成，唔係寫實攝影"],
};

/** A3：漫畫／插畫族（v7_judge_shen 決定性因素）。 */
const JUDGE_COMIC_JSON: PackageJudge = {
  items: [
    { item: "人數", verdict: "達標", evidence: "【全圖】「一個男性人像」" },
    { item: "風格", verdict: "唔達標", evidence: "【全圖】「好強嘅 comic / graphic novel 風格人像」" },
  ],
  contradictions: [],
  style: { verdict: "插畫", evidence: "【全圖】「comic / graphic novel 風格人像」" },
  pass: false,
  fail_reasons: ["風格唔寫實：comic / graphic novel"],
};

const E_REQUIRE = { people_count: 1, tool: "鋼筆", location: "攝影棚純灰底" };

// ─── test PNG helpers ───

async function mkNoisePng(file: string, width = 640, height = 360) {
  const sharp = (await import("sharp")).default;
  const buf = Buffer.from(Array.from({ length: width * height * 3 }, () => Math.floor(Math.random() * 256)));
  await sharp(buf, { raw: { width, height, channels: 3 } }).png().toFile(file);
  return file;
}

async function mkFlatPng(file: string, rgb: [number, number, number], width = 640, height = 360) {
  const sharp = (await import("sharp")).default;
  await sharp({ create: { width, height, channels: 3, background: { r: rgb[0], g: rgb[1], b: rgb[2] } } }).png().toFile(file);
  return file;
}

async function mkPortraitPng(file: string) {
  const sharp = (await import("sharp")).default;
  const W = 640, H = 360, CUT = Math.floor(H * 0.7);
  const buf = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (y < CUT) {
        buf[o] = 122; buf[o + 1] = 122; buf[o + 2] = 122;
      } else {
        buf[o] = Math.floor(Math.random() * 256);
        buf[o + 1] = Math.floor(Math.random() * 256);
        buf[o + 2] = Math.random() < 0.5 ? 20 : 240;
      }
    }
  }
  await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
  return file;
}

// ─── role fixture servers：眼（帶圖）同判官（純文字）分開埠，記錄 request bodies ───

type RoleServer = {
  url: string;
  chatBodies: Record<string, unknown>[];
  close: () => void;
};

async function roleServer(ids: string[], imageReply: () => string, textReply: () => string): Promise<RoleServer> {
  const chatBodies: Record<string, unknown>[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if ((req.url ?? "").includes("/v1/models")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: ids.map((id) => ({ id })) }));
        return;
      }
      const parsed = JSON.parse(body) as Record<string, unknown>;
      chatBodies.push(parsed);
      const content = (parsed.messages as { content: unknown }[])[0]!.content;
      const reply = Array.isArray(content) ? imageReply() : textReply();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, chatBodies, close: () => server.close() };
}

/** 眼＋判官＋second eye 三埠齊備嘅 runPhotoQc 環境（唔 arm second 就唔會俾人打）。 */
async function qcHarness(opts: {
  judgeReply?: () => string;
  secondReply?: () => string;
} = {}) {
  const eye = await roleServer(["nex-fx"], () => EYE_DESC, () => JSON.stringify(JUDGE_PASS_JSON));
  const judge = await roleServer(["qwen-fx"], () => EYE_DESC, opts.judgeReply ?? (() => JSON.stringify(JUDGE_PASS_JSON)));
  const second = await roleServer(["glm-fx"], () => "兩個人企喺茶餐廳門口。", opts.secondReply ?? (() => '{"people_count":1,"grey_blocks":false}'));
  return { eye, judge, second };
}

// ─── A0：EYE_PROMPT 一字唔改＋lint ───

test("A0: EYE_PROMPT is exactly the PACKAGE sentence", () => {
  assert.equal(EYE_PROMPT, "描述下呢個U1.5做出嚟嘅圖片。");
});

test("A0: lintEyePrompt throws on anything but the fixed sentence", () => {
  assert.equal(lintEyePrompt(EYE_PROMPT), EYE_PROMPT);
  assert.throws(() => lintEyePrompt("描述下呢個U1.5做出嚟嘅圖片")); // 少句號
  assert.throws(() => lintEyePrompt("描述下呢張圖，然後答係咪寫實。")); // 引導式第二問
  assert.throws(() => lintEyePrompt("用中文写成连贯短句，只写看得见的东西：人数、衣服、姿势、手里的物件、地面、背景。")); // 舊清單
  assert.throws(() => lintEyePrompt("描述下呢個U1.5做出嚟嘅圖片。 補充：呢張係咩風格？攝影定插畫？三揀一。"));
});

test("A0: lintEyeContent blocks any image-bearing call whose text ≠ EYE_PROMPT", () => {
  const img = { type: "image_url", image_url: { url: "data:image/png;base64,x" } };
  // 帶圖＋正句 → 過
  lintEyeContent([{ type: "text", text: EYE_PROMPT }, img]);
  // 帶圖＋任何第二條問題／清單／「係咪」→ throw
  assert.throws(() => lintEyeContent([{ type: "text", text: "係咪寫實？" }, img]));
  assert.throws(() => lintEyeContent([{ type: "text", text: "描述一下，再講風格。" }, img]));
  assert.throws(() => lintEyeContent([img, { type: "text", text: EYE_PROMPT + " 補充一句。" }]));
  // 純文字（判官／summarize）永遠唔俾 lint 攔
  lintEyeContent("任務原文＋五份描述");
  lintEyeContent([{ type: "text", text: "純文字多part，冇圖" }]);
});

// ─── A1：舊引導式審問字眼喺 photo-qc.ts 源碼零命中 ───

test("A1: photo-qc.ts source has zero guided-interrogation wording", () => {
  const src = fs.readFileSync(path.resolve("src/lib/studio/photo-qc.ts"), "utf8");
  for (const banned of [
    "攝影定插畫",
    "三揀一",
    "係咪寫實",
    "BLIND_PROMPT",
    "用中文写成连贯短句", // 舊引導清單首行
    "不要写清晰、良好、干净", // 舊引導清單句
  ]) {
    assert.ok(!src.includes(banned), `photo-qc.ts must not contain ${JSON.stringify(banned)}`);
  }
});

// ─── A2 主點：數碼寫實＝寫實 ───

test("A2 主點: 數碼寫實／AI生成／U1.5 描述＋可見項達標 → GREEN（pure verdict）", () => {
  const v = packageVerdict(E_REQUIRE, JUDGE_PASS_JSON);
  assert.equal(v.status, "GREEN", v.checks.fail_reasons.join(" | "));
  assert.deepEqual(v.checks.fail_reasons, []);
  // style verdict「數碼寫實」被守衞正名為寫實，唔係 fail
  assert.equal((v.checks.style as { verdict?: string }).verdict, "寫實");
});

test("A2 主點: 判官把「AI生成／數碼生成」當唔寫實 → 守衞推翻，fail_reasons 唔含數碼死刑", () => {
  const v = packageVerdict(E_REQUIRE, JUDGE_DIGITAL_FAKEFAIL_JSON);
  assert.equal(v.status, "GREEN", v.checks.fail_reasons.join(" | "));
  assert.deepEqual(v.checks.fail_reasons, []);
  const guard = v.checks.style_guard as string[];
  assert.ok(Array.isArray(guard) && guard.some((g) => g.includes("數碼寫實＝寫實")), JSON.stringify(guard));
  // 決定性斷言：fail_reasons 唔可以把「數碼/AI生成」講成唔寫實（本身就已係空）
  for (const r of v.checks.fail_reasons) {
    assert.ok(!/唔係寫實|不寫實/.test(r) || !/AI生成|數碼|U1\.5/.test(r), `fail_reason 把數碼當唔寫實：${r}`);
  }
});

test("A2 主點: 數碼字眼＋插畫字眼並存（數位繪畫/插畫感）→ 唔推翻（插畫在場先係死因）", () => {
  const mixed: PackageJudge = {
    ...JUDGE_COMIC_JSON,
    style: { verdict: "插畫", evidence: "【全圖】「數位繪畫插畫風格」" },
  };
  const v = packageVerdict(E_REQUIRE, mixed);
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("style:")), v.checks.fail_reasons.join(" | "));
});

// ─── A3：插畫／漫畫／厚塗／版畫 → 風格唔合格 ───

test("A3: 漫畫／插畫風格 → 唔合格（pure verdict, v7_judge_shen 決定性因素）", () => {
  const v = packageVerdict(E_REQUIRE, JUDGE_COMIC_JSON);
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("style:")), v.checks.fail_reasons.join(" | "));
  for (const style of ["厚塗", "卡通", "版畫"] as const) {
    const vv = packageVerdict(E_REQUIRE, { ...JUDGE_COMIC_JSON, style: { verdict: style, evidence: "【全圖】「厚塗筆觸」" }, fail_reasons: [`風格${style}`] });
    assert.equal(vv.status, "FAIL", style);
  }
});

// ─── A4＋A5：五路結構、Nex sampling、判官 text-only ───

test("A4: prepEyeLegs = 2K whole + 4 native quadrants (2400x1200 → 2048x1024 + 四個 1200x600)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-a4-"));
  const png = await mkNoisePng(path.join(dir, "big.png"), 2400, 1200);
  const sharp = (await import("sharp")).default;
  const legs = await prepEyeLegs(png);
  const meta = async (buf: Buffer) => {
    const m = await sharp(buf).metadata();
    return { w: m.width ?? 0, h: m.height ?? 0 };
  };
  assert.deepEqual(await meta(legs.whole), { w: 2048, h: 1024 }, "whole leg 係 2K");
  for (const k of ["TL", "TR", "BL", "BR"] as const) {
    const m = await meta(legs.quads[k]);
    assert.deepEqual(m, { w: 1200, h: 600 }, `${k} 係原生解析度四格，冇降級`);
  }
  // 細圖唔放大：1024 闊全圖原樣
  const small = await mkNoisePng(path.join(dir, "small.png"), 1024, 512);
  const smallLegs = await prepEyeLegs(small);
  assert.deepEqual(await meta(smallLegs.whole), { w: 1024, h: 512 });
});

test("A4+A5 公版五路: 5 個帶圖 call 全句 EYE_PROMPT／Nex 官方 sampling；判官 text-only 唔見圖", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-a45-"));
  const png = await mkNoisePng(path.join(dir, "SH01.png"), 2400, 1200);
  const { eye, judge, second } = await qcHarness();
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const rec = await runPhotoQc(png, path.join(dir, "SH01.photo_qc.json"), E_REQUIRE, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judge.url, model: "qwen-fx" },
    });
    assert.equal(rec.formula, "package-0917");
    assert.equal(rec.blind, EYE_DESC);
    assert.deepEqual(rec.quads, { TL: EYE_DESC, TR: EYE_DESC, BL: EYE_DESC, BR: EYE_DESC });

    // 眼：恰好五個 chat call（whole+四格），全部同一句 prompt
    const eyeCalls = eye.chatBodies;
    assert.equal(eyeCalls.length, 5, `five legs, got ${eyeCalls.length}`);
    const sharp = (await import("sharp")).default;
    const dims: string[] = [];
    for (const body of eyeCalls) {
      assert.equal(body.model, "nex-fx");
      // A5: Nex 官方 sampling
      assert.equal(body.temperature, 0.7);
      assert.equal(body.top_p, 0.95);
      assert.equal(body.top_k, 40);
      assert.equal(body.reasoning_effort, "none");
      const parts = (body.messages as { content: { type: string; text?: string; image_url?: { url: string } }[] }[])[0]!.content;
      assert.equal(parts.length, 2);
      assert.equal(parts[0]!.type, "text");
      assert.equal(parts[0]!.text, EYE_PROMPT, "帶圖 call 只准呢句");
      assert.equal(parts[1]!.type, "image_url");
      const b64 = parts[1]!.image_url!.url.split(",")[1]!;
      const m = await sharp(Buffer.from(b64, "base64")).metadata();
      dims.push(`${m.width}x${m.height}`);
    }
    // whole 2048x1024 一路；四格 1200x600 原生四路
    assert.equal(dims.filter((d) => d === "2048x1024").length, 1, dims.join(","));
    assert.equal(dims.filter((d) => d === "1200x600").length, 4, dims.join(","));

    // 判官：恰好一個 chat call，content 係純字串（唔收 image bytes）
    const judgeCalls = judge.chatBodies;
    assert.equal(judgeCalls.length, 1);
    const jb = judgeCalls[0]!;
    assert.equal(jb.model, "qwen-fx");
    assert.equal(jb.temperature, 0.7);
    const rawContent = (jb.messages as { content: unknown }[])[0]!.content;
    assert.equal(typeof rawContent, "string", "判官 text-only：content 唔可以係帶圖 array");
    const content = rawContent as string;
    assert.ok(!content.includes("data:image"), "判官 body 唔可以有圖");
    // 判官 input：任務原文＋五份標籤描述＋釘死規則
    for (const label of ["【全圖】", "【左上角】", "【右上角】", "【左下角】", "【右下角】"]) {
      assert.ok(content.includes(label), `judge input 缺 ${label}`);
    }
    assert.ok(content.includes("鋼筆") && content.includes("攝影棚純灰底"), "judge input 有任務原文");
    assert.ok(content.includes("唔等於唔寫實"), "釘死規則2（數碼寫實＝寫實）在場");
    assert.ok(content.includes("插畫／漫畫／厚塗／卡通／版畫"), "釘死規則3在場");
    assert.ok(content.includes("四分一格局部座標"), "四格＝局部座標聲明在場");
    assert.equal((content.match(new RegExp(EYE_DESC.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")) ?? []).length, 5, "五份描述全文入判官");

    // record 留 sampling 證據
    assert.equal(rec.eye.model, "nex-fx");
    assert.deepEqual(rec.eye.sampling, { ...EYE_SAMPLING });
    assert.equal(rec.judgeCfg.temperature, 0.7);
    assert.equal(rec.judgeCfg.model, "qwen-fx");
    // 判官 GREEN＋second eye 未 armed → PASS_UNCONFIRMED 天花板照舊
    assert.equal(rec.status, "PASS_UNCONFIRMED", rec.checks.fail_reasons.join(" | "));
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judge.close(); if (second) second.close();
  }
});

test("A4: judge 函數唔收 image bytes —— buildJudgePrompt 只食任務原文＋五份文字", () => {
  const prompt = buildJudgePrompt(E_REQUIRE, { whole: EYE_DESC, TL: EYE_DESC, TR: EYE_DESC, BL: EYE_DESC, BR: EYE_DESC });
  assert.equal(typeof prompt, "string");
  assert.ok(!prompt.includes("base64") && !prompt.includes("data:image"));
  assert.ok(prompt.includes("任務原文"));
});

test("A5: EYE_SAMPLING＝0.7/0.95/40/none；JUDGE_SAMPLING＝temp 0.7", () => {
  assert.deepEqual({ ...EYE_SAMPLING }, { temperature: 0.7, top_p: 0.95, top_k: 40, reasoning_effort: "none" });
  assert.deepEqual({ ...JUDGE_SAMPLING }, { temperature: 0.7 });
});

test("A2 主點 (integration): 數碼寫實描述五路＋判官達標＋second eye armed → GREEN", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-a2i-"));
  const png = await mkNoisePng(path.join(dir, "E.png"));
  const { eye, judge, second } = await qcHarness({
    secondReply: () => '{"people_count":1,"grey_blocks":false}',
  });
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    process.env.SLATECREW_SECOND_ENDPOINT = second.url;
    const rec = await runPhotoQc(png, path.join(dir, "E.photo_qc.json"), { ...E_REQUIRE, grey_blocks: false }, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judge.url, model: "qwen-fx" },
    });
    assert.equal(rec.status, "GREEN", `${rec.status} ${rec.checks.fail_reasons.join("|")}`);
    assert.deepEqual(rec.checks.fail_reasons, []);
    // 數碼寫實＝寫實：冇任何理由把 U1.5／數位繪畫／數碼寫實當唔寫實
    for (const r of rec.checks.fail_reasons) {
      assert.ok(!(/U1\.5|數碼|數位|AI生成/.test(r) && /寫實/.test(r)), `數碼被當唔寫實：${r}`);
    }
    assert.equal(pinQcAccepted(dir, "E"), true);
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judge.close(); second.close();
  }
});

test("A3 (integration): 判官判漫畫風格 → runPhotoQc FAIL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-a3i-"));
  const png = await mkNoisePng(path.join(dir, "shen.png"));
  const { eye, judge } = await qcHarness({ judgeReply: () => JSON.stringify(JUDGE_COMIC_JSON) });
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const rec = await runPhotoQc(png, path.join(dir, "shen.photo_qc.json"), E_REQUIRE, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judge.url, model: "qwen-fx" },
    });
    assert.equal(rec.status, "FAIL");
    assert.ok(rec.checks.fail_reasons.some((r) => r.startsWith("style:")), rec.checks.fail_reasons.join(" | "));
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judge.close();
  }
});

// ─── 舊 bigram judge（video-qc 幀檢路照用；公版 stills 路已行五路＋判官）───

test("people mismatch fails", () => {
  const v = judge(DESC, { people_count: 3, grey_blocks: false }, { people_count: 2, grey_blocks: false });
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.includes("people_count")));
});

test("灰色方块 in the write-up fails grey_blocks", () => {
  const v = judge(`${DESC} 左邊嗰個係灰色方块。`, { people_count: 2, grey_blocks: false }, { people_count: 2, grey_blocks: false });
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.includes("grey_blocks")));
});

test("i-mannequin / placard / silhouette in write-up fails grey_blocks", () => {
  for (const extra of [
    "畫面係 Blender i-mannequin 占位。",
    "面前有塊 placard 標牌。",
    "兩個白色人形剪影。",
  ]) {
    const v = judge(`${DESC} ${extra}`, { people_count: 1, grey_blocks: false }, { people_count: 1, grey_blocks: false });
    assert.equal(v.status, "FAIL", extra);
    assert.ok(v.checks.fail_reasons.some((r) => r.includes("grey_blocks")), extra);
  }
});

test("empty require fails", () => {
  const v = judge(DESC, { people_count: 2 }, {});
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.includes("no require")));
});

test("matching write-up is GREEN", () => {
  const v = judge(DESC, { people_count: 2, grey_blocks: false }, { people_count: 2, grey_blocks: false });
  assert.equal(v.status, "GREEN");
  assert.deepEqual(v.checks.fail_reasons, []);
});

test("location / action / size from the sheet fail a street write-up", () => {
  const street = "人数：一人。姿势：站立。手里的物件：无。地面：湿的。背景：夜晚城市街景，高楼，霓虹灯招牌。";
  const v = judge(
    street,
    { people_count: 1, grey_blocks: false, pose_notes: "站立" },
    { people_count: 1, grey_blocks: false, location: "茶餐廳卡位", action: "坐低飲茶", size: "closeup" },
  );
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("location:")), v.checks.fail_reasons.join(" | "));
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("action:")), v.checks.fail_reasons.join(" | "));
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("size:")), v.checks.fail_reasons.join(" | "));
});

test("matching location and action stay GREEN", () => {
  const v = judge(DESC, { people_count: 2, grey_blocks: false }, {
    people_count: 2,
    grey_blocks: false,
    location: "茶餐廳門口",
    action: "企喺門口", // T35: a 2-char action has no judgeable bigrams -> unparseable FAIL
    size: "medium",
  });
  assert.equal(v.status, "GREEN");
  assert.deepEqual(v.checks.fail_reasons, []);
});

test("traditional location hits simplified morgue write-up", () => {
  const morgue =
    "一人。坐姿。双手拉着一块白布。地面有水渍。背景是地下停尸间，两侧金属床架，白色床单。";
  const v = judge(
    morgue,
    { people_count: 1, grey_blocks: false, pose_notes: "坐姿", location_notes: "地下停尸间", action_notes: "从钢床上挣扎坐起，伸手扯下白布", size_notes: "medium" },
    { people_count: 1, grey_blocks: false, location: "首都地下停屍間", action: "重生者喺鋼床掙扎坐起，扯下白布", size: "medium" },
  );
  assert.equal(v.status, "GREEN", v.checks.fail_reasons.join(" | "));
});

test("street write-up still fails 首都地下停屍間", () => {
  const street = "人数：一人。姿势：站立。手里的物件：无。地面：湿的。背景：夜晚城市街景，高楼，霓虹灯招牌。";
  const v = judge(
    street,
    { people_count: 1, grey_blocks: false, pose_notes: "站立" },
    { people_count: 1, grey_blocks: false, location: "首都地下停屍間", action: "坐起", size: "medium" },
  );
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("location:")), v.checks.fail_reasons.join(" | "));
});

test("closeup with 胸口 and size_notes medium is GREEN", () => {
  const desc = "一人。右手按在胸口。背景是室内金属走廊。";
  const v = judge(
    desc,
    { people_count: 1, grey_blocks: false, size_notes: "medium" },
    { people_count: 1, grey_blocks: false, size: "closeup" },
  );
  assert.equal(v.status, "GREEN", v.checks.fail_reasons.join(" | "));
});

test("consecutive stills that share the same write-up fail distinct", () => {
  const v = judge(DESC, { people_count: 2, grey_blocks: false }, { people_count: 2, grey_blocks: false }, { prevDesc: DESC });
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("distinct:")));
});

test("公版 distinct law 照舊：全圖描述同上一張太近 → FAIL", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-dist-"));
  const png = await mkNoisePng(path.join(dir, "SH02.png"));
  const { eye, judge } = await qcHarness();
  try {
    const rec = await runPhotoQc(png, path.join(dir, "SH02.photo_qc.json"), E_REQUIRE, { prevDesc: EYE_DESC }, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judge.url, model: "qwen-fx" },
    });
    assert.equal(rec.status, "FAIL");
    assert.ok(rec.checks.fail_reasons.some((r) => r.startsWith("distinct:")), rec.checks.fail_reasons.join(" | "));
  } finally {
    eye.close(); judge.close();
  }
});

test("sameRequire is structural", () => {
  assert.equal(sameRequire({ people_count: 1 }, { people_count: 1 }), true);
  assert.equal(sameRequire({ people_count: 1 }, { people_count: 1, location: "x" }), false);
});

function qcDir(status: string, sha: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-qc-"));
  const pngBytes = Buffer.from("89504e470d0a1a2a0000", "hex");
  fs.writeFileSync(path.join(dir, "SH01.png"), pngBytes);
  fs.writeFileSync(
    path.join(dir, "SH01.photo_qc.json"),
    JSON.stringify({
      tool: "slatecrew.photo_qc",
      status,
      sha256: sha ?? crypto.createHash("sha256").update(pngBytes).digest("hex"),
      blind: "描述",
      require: { people_count: 2 },
    }),
  );
  return dir;
}

test("pinQcAccepted: GREEN + sha match", () => {
  assert.equal(pinQcAccepted(qcDir("GREEN", null), "SH01"), true);
});

test("pinQcAccepted: sha mismatch is false", () => {
  assert.equal(pinQcAccepted(qcDir("GREEN", "0".repeat(64)), "SH01"), false);
});

test("pinQcAccepted: FAIL status is false", () => {
  assert.equal(pinQcAccepted(qcDir("FAIL", null), "SH01"), false);
});

test("runPhotoQc: GREEN write-once keeps existing record when sha matches (formula-aware cache)", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-qc-wo-"));
  const png = path.join(dir, "SH01.png");
  const qc = path.join(dir, "SH01.photo_qc.json");
  await mkNoisePng(png);
  const bytes = fs.readFileSync(png);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const existing = {
    tool: "slatecrew.photo_qc",
    ts: "2020-01-01T00:00:00.000Z",
    formula: "package-0917",
    image: png,
    sha256: sha,
    eye: { endpoint: "http://fixture", model: "fixture-eye", sampling: { temperature: 0.7 } },
    judgeCfg: { endpoint: "http://fixture", model: "fixture-judge", temperature: 0.7 },
    require: { people_count: 1, grey_blocks: false },
    status: "GREEN",
    blind: "fixture",
    quads: { TL: "a", TR: "b", BL: "c", BR: "d" },
    judgeOutput: { items: [], style: { verdict: "寫實" }, pass: true, fail_reasons: [] },
    checks: { status: "GREEN", fail_reasons: [], people_count: true },
  };
  fs.writeFileSync(qc, JSON.stringify(existing));
  const before = fs.readFileSync(qc, "utf8");
  // eye 指向一個冇人聽嘅埠：cache 命中就唔會有任何 HTTP（一 miss 即 fetch throw）
  const result = await runPhotoQc(png, qc, { people_count: 1, grey_blocks: false }, {}, {
    first: { url: "http://127.0.0.1:9", model: "nope" },
    judge: { url: "http://127.0.0.1:9", model: "nope" },
  });
  assert.equal(fs.readFileSync(qc, "utf8"), before);
  assert.equal(result.status, "GREEN");
  assert.equal(result.sha256, sha);
});

test("keyframeRequire adds tool keys when the shot carries a prop", () => {
  const shot = {
    id: "SH01",
    index: 0,
    heading: "1",
    size: "medium",
    location: "x",
    action: "a",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
      { characterId: "B", start: { x: 70, y: 50 }, end: { x: 70, y: 50 }, facing: 1, handL: { x: 66, y: 45 }, handR: { x: 74, y: 45 }, footL: { x: 68, y: 80 }, footR: { x: 72, y: 80 }, gait: "plant" },
    ],
    props: [{ name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] }],
    stillPrompt: "",
    motionPrompt: "",
  } as const;
  const req = keyframeRequire(shot as unknown as Parameters<typeof keyframeRequire>[0]);
  assert.equal(req.people_count, 2);
  assert.equal(req.grey_blocks, false);
  assert.equal(req.location, "x");
  assert.equal(req.action, "a");
  assert.equal(req.size, "medium");
  assert.equal(req.tool, "曲轅犁");
  assert.deepEqual(req.tool_shape, ["弯", "木", "插入"]);
  assert.deepEqual(req.tool_forbid, ["锹", "铲", "锄"]);
});

test("resolveSecondEye: opts arm :4000 glm-5.3-flash", () => {
  const cfg = resolveSecondEye({ secondEndpoint: "http://127.0.0.1:4000", secondModel: "glm-5.3-flash" });
  assert.deepEqual(cfg, { endpoint: "http://127.0.0.1:4000", model: "glm-5.3-flash" });
});

test("resolveSecondEye: empty endpoint ⇒ null (skip, not fail); env arms with default model", () => {
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  const prevM = process.env.SLATECREW_SECOND_MODEL;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_MODEL;
  try {
    assert.equal(resolveSecondEye(), null);
    assert.equal(resolveSecondEye({ secondEndpoint: "   " }), null);
    process.env.SLATECREW_SECOND_ENDPOINT = "http://127.0.0.1:4000";
    assert.deepEqual(resolveSecondEye(), { endpoint: "http://127.0.0.1:4000", model: "glm-5.3-flash" });
    assert.deepEqual(resolveSecondEye({ secondModel: "glm-5.3" }), { endpoint: "http://127.0.0.1:4000", model: "glm-5.3" });
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    if (prevM === undefined) delete process.env.SLATECREW_SECOND_MODEL;
    else process.env.SLATECREW_SECOND_MODEL = prevM;
  }
});

test("judgeSecondEye: glm grey on a grey-banned shot fails second_eye", () => {
  const v = judgeSecondEye(
    { people_count: 1, grey_blocks: false },
    { blind: "一個灰色人形剪影企喺房中間。", summary: { grey_blocks: true } },
  );
  assert.equal(v.ok, false);
  assert.ok(v.reason?.includes("second_eye"));
});

test("judgeSecondEye: blind-only grey also fails; clean stays ok", () => {
  assert.equal(
    judgeSecondEye({ grey_blocks: false }, { blind: "牆邊有幾個灰色方塊。", summary: { grey_blocks: false } }).ok,
    false,
  );
  assert.equal(
    judgeSecondEye({ grey_blocks: false }, { blind: "兩個人企喺茶餐廳門口。", summary: { grey_blocks: false } }).ok,
    true,
  );
});

test("judgeSecondEye: no grey ban or degraded summary ⇒ skip (first eye + machine grey still gate)", () => {
  assert.equal(
    judgeSecondEye({ people_count: 1 }, { blind: "灰色方塊", summary: { grey_blocks: true } }).ok,
    true,
  );
  assert.equal(
    judgeSecondEye({ grey_blocks: false }, { blind: "灰色方塊", summary: { parse_error: "boom", raw: "x" } }).ok,
    true,
  );
});

test("runSecondEye: sequential describe then summarize against a local fixture", async () => {
  const calls: unknown[] = [];
  const server = http.createServer((_req, res) => {
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      const content = (JSON.parse(body) as { messages: { content: unknown }[] }).messages[0]!.content;
      calls.push(content);
      const reply = calls.length === 1
        ? "兩個人企喺茶餐廳門口，地面濕。"
        : '{"people_count":2,"grey_blocks":false}';
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const png = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-se-")), "f.png");
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a2a0000", "hex"));
    const rec = await runSecondEye(`http://127.0.0.1:${port}`, "glm-5.3-flash", png);
    assert.equal(calls.length, 2); // 拆步: exactly one describe + one summarize, awaited in order
    assert.ok(Array.isArray(calls[0]), "describe sends image parts");
    const parts = calls[0] as { type: string; text?: string }[];
    assert.equal(parts[0]!.text, EYE_PROMPT, "second eye 帶圖都只准公版句");
    assert.equal(typeof calls[1], "string", "summarize sends the blind text only");
    assert.ok(rec.blind.includes("茶餐廳"));
    assert.equal((rec.summary as { grey_blocks?: boolean }).grey_blocks, false);
    assert.equal(rec.model, "glm-5.3-flash");
  } finally {
    server.close();
  }
});

test("keyframeRequire has no tool keys without props", () => {
  const shot = {
    id: "SH01",
    index: 0,
    heading: "1",
    size: "medium",
    location: "x",
    action: "a",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
    ],
    stillPrompt: "",
    motionPrompt: "",
  } as const;
  const req = keyframeRequire(shot as unknown as Parameters<typeof keyframeRequire>[0]);
  assert.equal(req.people_count, 1);
  assert.equal(req.location, "x");
  assert.equal(req.action, "a");
  assert.equal(req.size, "medium");
  assert.equal("tool" in req, false);
  assert.equal("tool_shape" in req, false);
  assert.equal("tool_forbid" in req, false);
});

test("T35 A2: street write-up vs 總統府地下審判室 fails with hit counts", () => {
  const street = "两人跪在湿漉漉的街道上，远处有霓虹灯牌和路灯。";
  const v = judge(
    street,
    { grey_blocks: false, location_notes: "wet street, neon" },
    { grey_blocks: false, location: "總統府地下審判室" },
  );
  assert.equal(v.status, "FAIL");
  assert.ok(
    v.checks.fail_reasons.some((r) => r.startsWith("location: hits 0/3")),
    v.checks.fail_reasons.join(" | "),
  );
});

test("T35 A3: unparseable location require fails loud, never auto-passes", () => {
  const v = judge(DESC, { grey_blocks: false }, { grey_blocks: false, location: "府" });
  assert.equal(v.status, "FAIL");
  assert.ok(
    v.checks.fail_reasons.some((r) => r.includes("location: require unparseable")),
    v.checks.fail_reasons.join(" | "),
  );
  const v2 = judge(DESC, { grey_blocks: false }, { grey_blocks: false, action: "企" });
  assert.ok(
    v2.checks.fail_reasons.some((r) => r.includes("action: require unparseable")),
    v2.checks.fail_reasons.join(" | "),
  );
});

test("T35 item3: medium needs scale evidence; none => size: unmeasured", () => {
  const v1 = judge(
    "一人企喺房中间。",
    { grey_blocks: false, size_notes: "unknown" },
    { grey_blocks: false, size: "medium" },
  );
  assert.ok(
    v1.checks.fail_reasons.some((r) => r.includes("size: unmeasured")),
    v1.checks.fail_reasons.join(" | "),
  );
  const v2 = judge(DESC, { grey_blocks: false }, { grey_blocks: false, size: "medium" });
  assert.equal(v2.status, "GREEN", v2.checks.fail_reasons.join(" | "));
});

test("T35 A1: empty grey still fails grey_leak through runPhotoQc", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35-a1-"));
  const png = await mkFlatPng(path.join(dir, "SH01.png"), [122, 122, 122]);
  const { eye, judge } = await qcHarness();
  const greyEye = await roleServer(["nex-fx"], () => "成張圖都係灰色方块，冇人物。", () => JSON.stringify(JUDGE_PASS_JSON));
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const rec = await runPhotoQc(
      png,
      path.join(dir, "SH01.photo_qc.json"),
      { people_count: 1, grey_blocks: false, size: "medium" },
      {},
      { first: { url: greyEye.url, model: "nex-fx" }, judge: { url: judge.url, model: "qwen-fx" } },
    );
    assert.equal(rec.status, "FAIL");
    assert.ok(
      rec.checks.fail_reasons.some((r) => r.startsWith("grey_leak:")),
      rec.checks.fail_reasons.join(" | "),
    );
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judge.close(); greyEye.close();
  }
});

test("T35 item5: un-armed second eye caps GREEN at PASS_UNCONFIRMED; arming upgrades", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35-pu-"));
  const png = path.join(dir, "SH02.png");
  await mkNoisePng(png);
  const { eye, judge, second } = await qcHarness({
    secondReply: () => '{"people_count":1,"grey_blocks":false}',
  });
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  const prevM = process.env.SLATECREW_SECOND_MODEL;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_MODEL;
  const qc = path.join(dir, "SH02.photo_qc.json");
  const require = { people_count: 1, grey_blocks: false };
  const eyes = { first: { url: eye.url, model: "nex-fx" }, judge: { url: judge.url, model: "qwen-fx" } };
  try {
    const un = await runPhotoQc(png, qc, require, {}, eyes);
    assert.equal(un.status, "PASS_UNCONFIRMED", un.checks.fail_reasons.join(" | "));
    const before = fs.readFileSync(qc, "utf8");
    // un-armed re-run: PASS_UNCONFIRMED receipt is a valid cache hit (no re-run)
    const cached = await runPhotoQc(png, qc, require, {}, eyes);
    assert.equal(fs.readFileSync(qc, "utf8"), before);
    assert.equal(cached.status, "PASS_UNCONFIRMED");
    // PASS_UNCONFIRMED never pins - second eye is the acceptance floor
    assert.equal(pinQcAccepted(dir, "SH02"), false);
    // arming the second eye busts the cache and upgrades to GREEN
    process.env.SLATECREW_SECOND_ENDPOINT = second.url;
    const armed = await runPhotoQc(png, qc, require, {}, eyes);
    assert.equal(armed.status, "GREEN");
    assert.equal(armed.second?.model, "glm-5.3-flash");
    assert.ok((armed.second?.blind.length ?? 0) > 0);
    assert.notEqual(fs.readFileSync(qc, "utf8"), before);
    // armed GREEN pins again
    assert.equal(pinQcAccepted(dir, "SH02"), true);
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    if (prevM === undefined) delete process.env.SLATECREW_SECOND_MODEL;
    else process.env.SLATECREW_SECOND_MODEL = prevM;
    eye.close(); judge.close(); second.close();
  }
});

test("T35b A6: SH01 long require passes on key nouns, not paraphrase ratio", () => {
  const location = "總統府地下審判室";
  const action = "白慎行提筆蘸紅墨，喺判決書上緩緩畫上一勾；鏡前沈孟舟被按住肩膀，強行押跪落水泥地。";
  const blind =
    "两人跪在总统府地下的审判室里。白慎行提笔蘸红墨，在判决书上画上一勾；沈孟舟被按住肩膀，跪在水泥地上。";
  const v = judge(
    blind,
    { people_count: 2, grey_blocks: false, location_notes: "总统府地下审判室", action_notes: "提笔蘸红墨画判决书；被按住肩膀跪在水泥地", pose_notes: "跪" },
    { people_count: 2, grey_blocks: false, location, action, size: "wide" },
  );
  assert.equal(v.checks.location, true, v.checks.fail_reasons.join(" | "));
  assert.equal(v.checks.action, true, v.checks.fail_reasons.join(" | "));
});

test("T35b A7: plain-studio portrait warns instead of grey-failing", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35b-a7-"));
  const png = path.join(dir, "PA.png");
  await mkPortraitPng(png);
  const cleanEye = await roleServer(["nex-fx"], () => "一个人企喺净色背景前。", () => JSON.stringify(JUDGE_PASS_JSON));
  const judgeSrv = await roleServer(["qwen-fx"], () => EYE_DESC, () => JSON.stringify(JUDGE_PASS_JSON));
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const rec = await runPhotoQc(
      png,
      path.join(dir, "PA.photo_qc.json"),
      { people_count: 1, grey_blocks: false, size: "medium" },
      {},
      { first: { url: cleanEye.url, model: "nex-fx" }, judge: { url: judgeSrv.url, model: "qwen-fx" } },
    );
    assert.equal(rec.status, "PASS_WITH_WARN", `${rec.status} ${rec.checks.fail_reasons.join("|")}`);
    const warns = rec.checks.warns as string[];
    assert.ok(Array.isArray(warns) && warns.some((w) => w.includes("grey_watch")), JSON.stringify(warns));
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    cleanEye.close(); judgeSrv.close();
  }
});

test("T35b A8: all-black and all-white frames fail empty_frame", async () => {
  const { eye, judge } = await qcHarness();
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    for (const rgb of [[10, 10, 10], [245, 245, 245]] as [number, number, number][]) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35b-a8-"));
      const png = await mkFlatPng(path.join(dir, "SH09.png"), rgb);
      const rec = await runPhotoQc(
        png,
        path.join(dir, "SH09.photo_qc.json"),
        { people_count: 1, grey_blocks: false, size: "medium" },
        {},
        { first: { url: eye.url, model: "nex-fx" }, judge: { url: judge.url, model: "qwen-fx" } },
      );
      assert.equal(rec.status, "FAIL", String(rgb));
      assert.ok(
        rec.checks.fail_reasons.some((r) => r.startsWith("empty_frame:")),
        String(rgb) + " " + rec.checks.fail_reasons.join("|"),
      );
    }
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judge.close();
  }
});

test("T35b-cache: warn and FAIL receipts cache; parse-error does not", async () => {
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  const failJudge: PackageJudge = {
    items: [{ item: "人數", verdict: "唔達標", evidence: "【全圖】「見到兩個人」" }],
    style: { verdict: "寫實" },
    pass: false,
    fail_reasons: ["人數唔達標：要求 1，描述係 2"],
  };
  try {
    // warn receipt caches: resume does not re-hit the eye
    const dirA = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35bc-a-"));
    const warnPng = await mkPortraitPng(path.join(dirA, "SH01.png"));
    let judgeReply = JSON.stringify(JUDGE_PASS_JSON);
    const eyeA = await roleServer(["nex-fx"], () => "一个人企喺净色背景前。", () => JSON.stringify(JUDGE_PASS_JSON));
    const judgeA = await roleServer(["qwen-fx"], () => EYE_DESC, () => judgeReply);
    const recA1 = await runPhotoQc(warnPng, path.join(dirA, "SH01.photo_qc.json"), { people_count: 1, grey_blocks: false, size: "medium" }, {}, { first: { url: eyeA.url, model: "nex-fx" }, judge: { url: judgeA.url, model: "qwen-fx" } });
    assert.equal(recA1.status, "PASS_WITH_WARN");
    const eyeCallsA = eyeA.chatBodies.length;
    eyeA.close(); judgeA.close();
    const recA2 = await runPhotoQc(warnPng, path.join(dirA, "SH01.photo_qc.json"), { people_count: 1, grey_blocks: false, size: "medium" }, {}, { first: { url: eyeA.url, model: "nex-fx" }, judge: { url: judgeA.url, model: "qwen-fx" } });
    assert.equal(recA2.status, "PASS_WITH_WARN", "warn receipt must cache (servers closed)");
    assert.equal(eyeA.chatBodies.length, eyeCallsA, "eye call count must not grow after close");

    // FAIL receipt caches the same way
    const dirB = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35bc-b-"));
    const failPng = await mkNoisePng(path.join(dirB, "SH02.png"));
    const eyeB = await roleServer(["nex-fx"], () => EYE_DESC, () => EYE_DESC);
    const judgeB = await roleServer(["qwen-fx"], () => EYE_DESC, () => JSON.stringify(failJudge));
    const recB1 = await runPhotoQc(failPng, path.join(dirB, "SH02.photo_qc.json"), { people_count: 1 }, {}, { first: { url: eyeB.url, model: "nex-fx" }, judge: { url: judgeB.url, model: "qwen-fx" } });
    assert.equal(recB1.status, "FAIL");
    eyeB.close(); judgeB.close();
    const recB2 = await runPhotoQc(failPng, path.join(dirB, "SH02.photo_qc.json"), { people_count: 1 }, {}, { first: { url: eyeB.url, model: "nex-fx" }, judge: { url: judgeB.url, model: "qwen-fx" } });
    assert.equal(recB2.status, "FAIL", "FAIL receipt must cache (servers closed)");

    // parse-error record does NOT cache: the judge leg gets hit again (eye too)
    const dirC = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35bc-c-"));
    const pPng = await mkNoisePng(path.join(dirC, "SH03.png"));
    judgeReply = "summary is not json at all {{{";
    const eyeC = await roleServer(["nex-fx"], () => EYE_DESC, () => EYE_DESC);
    const judgeC = await roleServer(["qwen-fx"], () => EYE_DESC, () => judgeReply);
    const recC1 = await runPhotoQc(pPng, path.join(dirC, "SH03.photo_qc.json"), { people_count: 1 }, {}, { first: { url: eyeC.url, model: "nex-fx" }, judge: { url: judgeC.url, model: "qwen-fx" } });
    assert.equal(recC1.status, "FAIL");
    assert.ok("parse_error" in (recC1.judgeOutput as Record<string, unknown>), "fixture must produce parse_error record");
    judgeC.close();
    await assert.rejects(
      runPhotoQc(pPng, path.join(dirC, "SH03.photo_qc.json"), { people_count: 1 }, {}, { first: { url: eyeC.url, model: "nex-fx" }, judge: { url: judgeC.url, model: "qwen-fx" } }),
      /./,
      "parse-error record must not cache - judge would be hit (server closed => throw)",
    );
    eyeC.close();
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
  }
});

test("公版 no-require law: 空 require 過唔到新閘", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-noreq-"));
  const png = await mkNoisePng(path.join(dir, "SH10.png"));
  const { eye, judge } = await qcHarness();
  try {
    const rec = await runPhotoQc(png, path.join(dir, "SH10.photo_qc.json"), {}, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judge.url, model: "qwen-fx" },
    });
    assert.equal(rec.status, "FAIL");
    assert.ok(rec.checks.fail_reasons.some((r) => r.includes("no require: cannot accept")), rec.checks.fail_reasons.join(" | "));
  } finally {
    eye.close(); judge.close();
  }
});

test("T41b E3: verdict invariant to /edit prompt — photo-qc reads require only", () => {
  // Same require, two legal prompt shapes per PROMPT_ALIGN U1.5=A: telegraph vs 150-300.
  const telegraph = "night，neon。";
  const long = [
    "Image-1 係呢一鏡嘅 Blender 灰模概念圖：灰色人偶係角色佔位。將概念圖轉成 photoreal 實拍一格，",
    "人偶位置、姿勢、比例、鏡位、地平線完全照 Image-1。場景：總統府地下審判室——室內，冇窗，水泥地，",
    "頂光慘白，牆身石屎加軍政徽記。左起第一個人偶＝沈孟舟：洗舊軍校常服，肩披黑色呢大衣，被按住肩膀跪喺水泥地。",
    "左起第二個人偶＝白慎行：黑色中山裝，胸前口袋插鋼筆，跪坐持判決書提筆蘸紅墨畫上一勾。判決書係紙本文書，",
    "薄而平，有字有印。夜色只由室內燈光呈現。禁止：街道、霓虹、路燈、濕地反光。唔好加人。",
  ].join("");
  assert.ok(long.length >= 150 && long.length <= 300, `long prompt ${long.length} chars`);

  const require = {
    people_count: 2,
    grey_blocks: false,
    location: "總統府地下審判室",
    action: "白慎行提筆蘸紅墨畫判決書；沈孟舟被按住肩膀跪喺水泥地",
    size: "wide",
  };
  // The eye sees the IMAGE, never the prompt: identical descs+judge for both.
  const judgeOut: PackageJudge = {
    items: [
      { item: "人數", verdict: "達標", evidence: "【全圖】「两人」" },
      { item: "地點：總統府地下審判室", verdict: "達標", evidence: "【全圖】「总统府地下的审判室」" },
      { item: "動作", verdict: "達標", evidence: "【全圖】「提笔蘸红墨，在判决书上画上一勾」" },
      { item: "風格", verdict: "達標", evidence: "【全圖】「實拍一格」" },
    ],
    style: { verdict: "寫實", evidence: "【全圖】「photoreal 實拍一格」" },
    pass: true,
    fail_reasons: [],
  };

  const v1 = packageVerdict(require, judgeOut);
  const v2 = packageVerdict(require, judgeOut);
  assert.deepEqual(
    { status: v1.status, fail_reasons: v1.checks.fail_reasons },
    { status: v2.status, fail_reasons: v2.checks.fail_reasons },
  );
  assert.equal(v1.status, "GREEN", v1.checks.fail_reasons.join(" | "));
  void telegraph;

  // Structural lock: no code path in photo-qc.ts reads any .prompt field.
  const src = fs.readFileSync(path.resolve("src/lib/studio/photo-qc.ts"), "utf8");
  assert.ok(!/\.prompt\b/.test(src), "photo-qc.ts must not read any .prompt field");
});

// ─── T43b：肖像 plain_background 閘——夜街／霓虹 FAIL（LD0F A/E 教訓）───

/** LD0F A/E 現場形狀：判官冇 location 項可判 → 達標；眼描述就係夜街。 */
const NIGHT_STREET_BLIND =
  "呢張圖片係由 U1.5 生成。一位年長男性嘅半身肖像，着黑色立領中山裝，企喺夜晚街道，" +
  "背後係霓虹燈招牌同濕漉漉嘅地面。整體係數碼寫實風格。";

test("T43b Q1: night-street portrait FAILs even when the judge passes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t43b-q1-"));
  const png = await mkPortraitPng(path.join(dir, "PA.png"));
  const eye = await roleServer(["nex-fx"], () => NIGHT_STREET_BLIND, () => NIGHT_STREET_BLIND);
  const judgeSrv = await roleServer(["qwen-fx"], () => EYE_DESC, () => JSON.stringify(JUDGE_PASS_JSON));
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const rec = await runPhotoQc(png, path.join(dir, "PA.photo_qc.json"), PORTRAIT_REQUIRE, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judgeSrv.url, model: "qwen-fx" },
    });
    assert.equal(rec.status, "FAIL", `${rec.status} ${rec.checks.fail_reasons.join("|")}`);
    assert.ok(
      rec.checks.fail_reasons.some((r) => r.startsWith("plain_background:") && r.includes("blind")),
      rec.checks.fail_reasons.join(" | "),
    );
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judgeSrv.close();
  }
});

test("T43b Q1b: second-eye location_notes with street words FAILs too", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t43b-q1b-"));
  const png = await mkPortraitPng(path.join(dir, "PA.png"));
  const eye = await roleServer(["nex-fx"], () => EYE_DESC, () => EYE_DESC);
  const judgeSrv = await roleServer(["qwen-fx"], () => EYE_DESC, () => JSON.stringify(JUDGE_PASS_JSON));
  const second = await roleServer(
    ["glm-fx"],
    () => "一個人企喺淨色背景前。",
    () => '{"people_count":1,"grey_blocks":false,"location_notes":"夜晚街道，霓虹招牌下"}',
  );
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    process.env.SLATECREW_SECOND_ENDPOINT = second.url;
    const rec = await runPhotoQc(png, path.join(dir, "PA.photo_qc.json"), PORTRAIT_REQUIRE, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judgeSrv.url, model: "qwen-fx" },
    });
    assert.equal(rec.status, "FAIL", `${rec.status} ${rec.checks.fail_reasons.join("|")}`);
    assert.ok(
      rec.checks.fail_reasons.some((r) => r.startsWith("plain_background:") && r.includes("location_notes")),
      rec.checks.fail_reasons.join(" | "),
    );
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judgeSrv.close(); second.close();
  }
});

test("T43b Q2: plain-background portrait never fails on location", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t43b-q2-"));
  const png = await mkPortraitPng(path.join(dir, "PA.png"));
  const { eye, judge, second } = await qcHarness({
    secondReply: () => '{"people_count":1,"grey_blocks":false,"location_notes":"室內淨色攝影棚背景"}',
  });
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    process.env.SLATECREW_SECOND_ENDPOINT = second.url;
    const rec = await runPhotoQc(png, path.join(dir, "PA.photo_qc.json"), PORTRAIT_REQUIRE, {}, {
      first: { url: eye.url, model: "nex-fx" },
      judge: { url: judge.url, model: "qwen-fx" },
    });
    assert.notEqual(rec.status, "FAIL", rec.checks.fail_reasons.join(" | "));
    assert.ok(
      !rec.checks.fail_reasons.some((r) => r.includes("plain_background") || r.includes("location")),
      `location 敗咗純色肖像：${rec.checks.fail_reasons.join(" | ")}`,
    );
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    eye.close(); judge.close(); second.close();
  }
});

test("T43b: judgePlainBackground fires on the four death words, stays inert without the flag", () => {
  const portraitReq: QcRequire = { people_count: 1, grey_blocks: false, plain_background: true };
  for (const word of ["street", "Streets", "街道", "霓虹", "neon signs"]) {
    const v = judgePlainBackground(portraitReq, { blind: `背景有${word}` });
    assert.equal(v.ok, false, word);
    assert.ok(v.reason?.startsWith("plain_background:"), `${word} ${v.reason ?? ""}`);
  }
  // location_notes 係第二現場：blind 乾淨都照殺
  const viaNotes = judgePlainBackground(portraitReq, { blind: "純灰色攝影棚底", locationNotes: "霓虹燈下嘅街道" });
  assert.equal(viaNotes.ok, false);
  assert.ok(viaNotes.reason?.includes("location_notes"));
  // 純色／無場景 → 過
  assert.equal(judgePlainBackground(portraitReq, { blind: "背景為純灰色漸層攝影棚底", locationNotes: "室內淨色背景" }).ok, true);
  // keyframe stills：冇 set flag → 閘完全唔着（location 閘形狀不變）
  const stillReq: QcRequire = { people_count: 2, grey_blocks: false, location: "夜晚街道" };
  assert.equal(judgePlainBackground(stillReq, { blind: "兩人企喺街道，霓虹燈照住", locationNotes: "夜晚街道" }).ok, true);
});

test("T43b: keyframe stills require keeps its shape — no plain_background key, location gate untouched", () => {
  const shot = {
    id: "SH01",
    index: 0,
    heading: "1",
    size: "medium",
    location: "夜晚街道",
    action: "a",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
    ],
    stillPrompt: "",
    motionPrompt: "",
  } as const;
  const req = keyframeRequire(shot as unknown as Parameters<typeof keyframeRequire>[0]);
  assert.equal("plain_background" in req, false, "keyframe stills never arm the portrait gate");
  assert.equal(req.location, "夜晚街道", "location require passes through untouched");
  // 肖像 require 冇 location 鍵——人數／灰塵照舊，地點閘本來就唔着
  assert.equal("location" in PORTRAIT_REQUIRE, false);
});

test("T43b: renderRequireLines arms the judge with the plain-background item", () => {
  const lines = buildJudgePrompt({ people_count: 1, grey_blocks: false, plain_background: true }, {
    whole: "x", TL: "", TR: "", BL: "", BR: "",
  });
  assert.ok(lines.includes("- 背景：純色平面背景（唔准街道／夜街／霓虹場景）"), "判官清單要有背景項");
  const still = buildJudgePrompt({ people_count: 1, grey_blocks: false, location: "街道" }, {
    whole: "x", TL: "", TR: "", BL: "", BR: "",
  });
  assert.ok(!still.includes("純色平面背景"), "keyframe stills prompt shape unchanged");
});

if (cases.length > 0) {
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
