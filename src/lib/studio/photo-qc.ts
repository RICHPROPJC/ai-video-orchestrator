import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { EMPTY_FRAME_MIN, judgePhotoGreyLeak, measureEmptyFrame } from "./workbench-grey-leak";

const BLIND_PROMPT = [
  "用中文写成连贯短句，只写看得见的东西：人数、衣服、姿势、手里的物件、地面、背景。",
  "姿势写坐、站、跪、蹲、躺、转身；从床上坐起来就写坐起。手在做什么要写（按胸口、拉白布、握徽章）。",
  "看得见的脸、眼、肩、胸口、白布、屏幕、徽章要写出来。",
  "背景写场所类型（停尸间、茶餐厅、街道、仓库、走廊、地下室）；能判断在地下就写地下。不要写城市名或故事人名。",
  "只写物件和结构，不要写清晰、良好、干净。",
  "叫不出物件名字就写形状（柄、刃、木、铁、弯不弯），不要编故事。",
].join("");

const SUMMARIZE_PROMPT =
  "The following text is an eyewitness description of one still image. " +
  "Using ONLY that text, fill JSON (no markdown). If the text does not say it, " +
  'use null or "unknown". Keys:\n' +
  "- people_count (integer or null)\n" +
  "- pose_notes (short string)\n" +
  '- tool_as_written (verbatim clause about any held object, including shape words)\n' +
  "- grey_blocks (true/false/unknown): grey cubes, mannequin/i-mannequin placeholders, placards, or white silhouettes\n" +
  "- location_notes (short string): place as written — indoor/outdoor, wet/dry, ground, walls, and place type if named\n" +
  "- action_notes (short string): what the body is doing\n" +
  "- size_notes (closeup|medium|wide|full|insert|unknown): how much of the body and set is in frame\n" +
  "Do not name characters. Do not decide whether an object is 'correct'.";

/** Traditional → simplified for gram matching. Not a story lexicon. */
const TRAD_SIMP: Record<string, string> = {
  屍: "尸", 間: "间", 國: "国", 監: "监", 鋼: "钢", 掙: "挣", 動: "动", 氣: "气",
  對: "对", 發: "发", 幾: "几", 號: "号", 傷: "伤", 數: "数", 圖: "图", 黃: "黄",
  紅: "红", 藍: "蓝", 燈: "灯", 門: "门", 東: "东", 頭: "头", 臉: "脸", 頸: "颈",
  髮: "发", 裏: "里", 裡: "里", 後: "后", 從: "从", 無: "无", 為: "为", 這: "这",
  說: "说", 時: "时", 長: "长", 開: "开", 車: "车", 飛: "飞", 風: "风", 雲: "云",
  電: "电", 視: "视", 螢: "荧", 與: "与", 於: "于", 並: "并", 個: "个", 們: "们",
  條: "条", 來: "来", 過: "过", 還: "还", 進: "进", 點: "点", 將: "将", 單: "单",
  齊: "齐", 張: "张", 塊: "块", 彎: "弯", 書: "书", 見: "见", 覺: "觉", 觀: "观",
  顯: "显", 廳: "厅", 場: "场", 層: "层", 廣: "广", 庫: "库", 廠: "厂", 佔: "占",
  捲: "卷", 掃: "扫", 擊: "击", 據: "据", 攝: "摄", 瞼: "睑", 顫: "颤", 麼: "么",
  衛: "卫", 術: "术", 繪: "绘", 製: "制", 餘: "余", 雙: "双", 業: "业", 嚴: "严",
  隱: "隐", 牀: "床", 佈: "布",
};

export function foldCjk(text: string): string {
  let out = "";
  for (const ch of text) out += TRAD_SIMP[ch] ?? ch;
  return out;
}

export type QcRequire = {
  people_count?: number | null;
  grey_blocks?: boolean;
  tool?: string;
  tool_shape?: string[];
  tool_forbid?: string[];
  location?: string;
  action?: string;
  size?: string;
  /** T43b 肖像閘：要純色背景——夜街字眼（street／街道／neon／霓虹）即 FAIL。
   *  只有 PORTRAIT_REQUIRE 會 set；keyframe stills 唔 set，location 閘形狀不變。 */
  plain_background?: boolean;
};

export type QcSummary = {
  people_count?: number | string | null;
  pose_notes?: string | null;
  tool_as_written?: string | null;
  grey_blocks?: boolean | string | null;
  location_notes?: string | null;
  action_notes?: string | null;
  size_notes?: string | null;
} & Record<string, unknown>;

export type PhotoQcCtx = { prevDesc?: string };

const FACE_RE = /脸|臉|头|頭|肩|胸口|眼|颈|頸|特写|特寫/;
const WIDE_SET_RE = /背景|环境|環境|全身|一排|房间|房間|室内|室內/;
/** medium ≈ person fills 25–60% of frame height — body visible but not filling it. */
const MEDIUM_BODY_RE = /胸口|胸前|肩膀|肩上|腰|膝|腿|腳|脚|鞋|半身|上身|全身|制服|大衣|大褸|褲|裙|着|穿|跪|站|坐|企|躺|蹲/;
const MEDIUM_GROUND_RE = /地面|地上|路面|地台|地板|水泥地|街道|跪在|跪喺|腳下|脚下/;

export type QcVerdict = {
  status: "GREEN" | "FAIL";
  checks: Record<string, unknown> & { status: string; fail_reasons: string[] };
};

const GREY_RE =
  /灰色方块|灰色方塊|灰块|灰塊|占位人偶|灰色立方|灰色人形|人偶|i-?mannequin|mannequin|placard|標牌|看板|剪影|silhouette|grey cubes?|gray cubes?|grey blocks?/i;

/** GET /v1/models on the configured vision endpoint; resolves the exact model,
 *  else any model with "mars" in its id. Throws when neither is served. */
export async function probeVisionEndpoint(url: string, model: string): Promise<string> {
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`vision endpoint down: GET ${url}/v1/models -> HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  const ids = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  if (ids.includes(model)) return model;
  const alt = ids.find((id) => id.includes("mars"));
  if (alt) return alt;
  throw new Error(`no vision model on ${url}: want ${model}, have ${ids.join(", ") || "none"}`);
}

async function chat(url: string, model: string, content: unknown, maxTokens: number): Promise<string> {
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages: [{ role: "user", content }], max_tokens: maxTokens, temperature: 0.1 }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`vision chat ${url} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

export async function blindDescribe(url: string, model: string, imageFile: string): Promise<string> {
  const b64 = fs.readFileSync(imageFile).toString("base64");
  const mime = imageFile.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
  return chat(url, model, [
    { type: "text", text: BLIND_PROMPT },
    { type: "image_url", image_url: { url: `data:${mime};base64,${b64}` } },
  ], 2000);
}

export async function summarize(url: string, model: string, desc: string, maxTokens = 800): Promise<QcSummary> {
  const raw = await chat(url, model, `${SUMMARIZE_PROMPT}\n\n---\n${desc}`, maxTokens);
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no JSON object in summary: ${raw.slice(0, 400)}`);
  return JSON.parse(text.slice(a, b + 1)) as QcSummary;
}

/** CJK bigrams + latin words — sheet tokens, never hardcoded story nouns. */
export function sceneGrams(text: string): string[] {
  const folded = foldCjk(text);
  const out: string[] = [];
  const chars = [...folded];
  for (let i = 0; i < chars.length - 1; i++) {
    if (/[\u4e00-\u9fff]/.test(chars[i]!) && /[\u4e00-\u9fff]/.test(chars[i + 1]!)) {
      out.push(chars[i]! + chars[i + 1]!);
    }
  }
  for (const w of folded.match(/[A-Za-z]{4,}/g) ?? []) out.push(w.toLowerCase());
  return out;
}

/** Generic pose/object aliases so Cantonese sheet tokens can hit Mandarin write-ups. */
function requireGrams(need: string): string[] {
  const grams = new Set(sceneGrams(need));
  const folded = foldCjk(need);
  if (/坐/.test(folded)) for (const x of ["坐起", "坐姿", "坐着", "坐在"]) grams.add(x);
  if (/跪/.test(folded)) for (const x of ["跪下", "跪姿", "单跪", "屈膝"]) grams.add(x);
  if (/屏/.test(folded)) for (const x of ["屏幕", "显示屏", "监察"]) grams.add(x);
  return [...grams];
}

function gramHits(need: string, blob: string): number {
  const grams = requireGrams(need);
  if (grams.length === 0) return -1;
  const hay = foldCjk(blob);
  return grams.filter((g) => hay.includes(g)).length;
}

/** Bigram evidence for location/action gates: hit count + total judgeable grams.
 *  total < 2 means the require has no discipline (T35: never auto-pass).
 *  T35b §1: need = max(2, min(5, ceil(total*0.3))) — the gate asks whether key
 *  nouns/verbs show up, not for a literary paraphrase ratio. */
export function gramMatch(
  need: string,
  blob: string,
): { hits: number; total: number; need: number } {
  const grams = requireGrams(need);
  const hay = foldCjk(blob);
  const hits = grams.filter((g) => hay.includes(g)).length;
  const total = grams.length;
  const needCount = Math.max(2, Math.min(5, Math.ceil(total * 0.3)));
  return { hits, total, need: needCount };
}

function jaccardGrams(a: string, b: string): number {
  const A = new Set(sceneGrams(a));
  const B = new Set(sceneGrams(b));
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter += 1;
  return inter / (A.size + B.size - inter);
}

export function sameRequire(a: QcRequire, b: QcRequire): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function judge(desc: string, summary: QcSummary, require: QcRequire, ctx: PhotoQcCtx = {}): QcVerdict {
  const reasons: string[] = [];
  const checks: Record<string, unknown> = {};
  const blob = `${desc}\n${String(summary.location_notes ?? "")}\n${String(summary.action_notes ?? "")}\n${String(summary.pose_notes ?? "")}`;

  const wantN = require.people_count;
  const gotN = summary.people_count;
  if (wantN != null) {
    const ok = gotN === wantN;
    checks.people_count = ok;
    if (!ok) reasons.push(`people_count: write-up/summary=${JSON.stringify(gotN)} require=${wantN}`);
  }

  if (require.grey_blocks === false) {
    const grey = summary.grey_blocks;
    const mentioned = GREY_RE.test(desc);
    const ok = (grey === false || grey === "false") && !mentioned;
    checks.grey_blocks = ok;
    if (!ok) reasons.push("grey_blocks: description or summary still has placeholders");
  }

  const wantTool = require.tool;
  if (wantTool) {
    const blob = `${desc}\n${String(summary.tool_as_written ?? "")}`;
    const shape = require.tool_shape ?? [];
    const forbid = require.tool_forbid ?? [];
    const named = blob.includes(String(wantTool));
    const shaped = shape.length > 0 && shape.every((tok) => blob.includes(tok));
    const banned = forbid.filter((tok) => blob.includes(tok));
    const ok = (named || shaped) && banned.length === 0;
    checks.tool = ok;
    if (!ok) {
      reasons.push(
        `tool: require ${JSON.stringify(wantTool)}; written=${JSON.stringify(summary.tool_as_written)}; ` +
          `named=${named} shape=${shaped} forbid=${JSON.stringify(banned)}`,
      );
    }
  }

  if (require.location) {
    const { hits, total, need } = gramMatch(require.location, blob);
    const ok = total >= 2 && hits >= need;
    checks.location = ok;
    if (total < 2) {
      reasons.push(`location: require unparseable — no judgeable bigrams`);
    } else if (!ok) {
      reasons.push(`location: hits ${hits}/${need} — misses ${JSON.stringify(require.location)}`);
    }
  }

  if (require.action) {
    const { hits, total, need } = gramMatch(require.action, `${blob}\n${String(summary.action_notes ?? "")}`);
    const ok = total >= 2 && hits >= need;
    checks.action = ok;
    if (total < 2) {
      reasons.push(`action: require unparseable — no judgeable bigrams`);
    } else if (!ok) {
      reasons.push(`action: hits ${hits}/${need} — misses ${JSON.stringify(require.action)}`);
    }
  }

  if (require.size) {
    const noted = String(summary.size_notes ?? "").toLowerCase();
    const size = require.size;
    let ok = true;
    let unmeasured = false;
    if (size === "closeup" || size === "insert") {
      // MCU write-ups often say medium; face/chest tokens are the gate. Wide notes still fail.
      ok = FACE_RE.test(blob) && noted !== "wide" && noted !== "full";
    } else if (size === "wide" || size === "full") {
      ok = WIDE_SET_RE.test(blob) || noted === "wide" || noted === "full";
    } else if (size === "medium") {
      // T35 item 3: medium gets a real call — person fills ~25-60% of frame height.
      // Text path: the describer's scale note, or body+environment evidence
      // (person visibly in frame, not filling it). No evidence => fail loud.
      if (noted === "medium") {
        ok = true;
      } else if (["wide", "full", "closeup", "insert"].includes(noted)) {
        ok = false; // describer actively measured another scale
      } else if (MEDIUM_BODY_RE.test(blob) && MEDIUM_GROUND_RE.test(blob)) {
        ok = true;
      } else {
        ok = false;
        unmeasured = true; // no scale evidence either way - fail loud, not auto-pass
      }
    } else {
      ok = false;
      unmeasured = true;
    }
    checks.size = ok;
    if (!ok) {
      reasons.push(
        unmeasured
          ? `size: unmeasured - require ${size}; write-up carries no scale evidence`
          : `size: require ${size}; write-up is not that scale`,
      );
    }
  }

  if (ctx.prevDesc) {
    const sim = jaccardGrams(desc, ctx.prevDesc);
    const ok = sim < 0.42;
    checks.distinct = ok;
    if (!ok) reasons.push(`distinct: still too close to previous (jaccard ${sim.toFixed(2)})`);
  }

  let status: "GREEN" | "FAIL" = Object.keys(checks).length > 0 && reasons.length === 0 ? "GREEN" : "FAIL";
  if (Object.keys(require).length === 0) {
    status = "FAIL";
    reasons.push("no require: cannot accept");
  }
  return { status, checks: { ...checks, status, fail_reasons: reasons } };
}

/** C10 second eye — glm-5.3-flash via LiteLLM :4000. pictureQc (qwen38) stays the first eye;
 *  the second eye is one extra sequential pass, never fan-out. */
export type SecondEyeConfig = { endpoint: string; model: string };

export type SecondEyeRecord = {
  endpoint: string;
  model: string;
  blind: string;
  summary: QcSummary | { parse_error: string; raw: string };
};

export type SecondEyeOpts = { secondEndpoint?: string; secondModel?: string };

/** opts → env SLATECREW_SECOND_ENDPOINT/SLATECREW_SECOND_MODEL → default model.
 *  Empty endpoint ⇒ null: no second eye this run (skip, not fail). */
export function resolveSecondEye(opts: SecondEyeOpts = {}): SecondEyeConfig | null {
  const endpoint = (opts.secondEndpoint ?? process.env.SLATECREW_SECOND_ENDPOINT ?? "").trim();
  if (!endpoint) return null;
  const model = (opts.secondModel ?? process.env.SLATECREW_SECOND_MODEL ?? "glm-5.3-flash").trim();
  return { endpoint, model };
}

/** T35 item 5: pipeline call sites pass eyes explicitly (audit-visible) instead of
 *  relying on ambient env inside runPhotoQc. Same resolution law as resolveSecondEye:
 *  env set → :4000 glm-5.3-flash; env empty → un-armed (PASS_UNCONFIRMED ceiling). */
export function photoQcEyesFromEnv(): PhotoQcEyes {
  return {
    second: {
      secondEndpoint: process.env.SLATECREW_SECOND_ENDPOINT ?? "",
      secondModel: process.env.SLATECREW_SECOND_MODEL,
    },
  };
}

/** Sequential 拆步 against the second eye: describe the frame, THEN summarize.
 *  One describe + one summarize, awaited in order — never a parallel batch. */
export async function runSecondEye(
  endpoint: string,
  model: string,
  imageFile: string,
): Promise<SecondEyeRecord> {
  const blind = await blindDescribe(endpoint, model, imageFile);
  let summary: SecondEyeRecord["summary"];
  try {
    // glm reasoning models burn max_tokens on reasoning_content — give the
    // summarize leg a bigger budget so the JSON survives it (receipt 2026-09-14).
    summary = await summarize(endpoint, model, blind, 4000);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary = { parse_error: message, raw: blind.slice(0, 2000) };
  }
  return { endpoint, model, blind, summary };
}

/** Second-eye gate: only armed when the require bans grey blocks. glm grey ⇒ FAIL. */
export function judgeSecondEye(
  require: QcRequire,
  second: Pick<SecondEyeRecord, "blind" | "summary">,
): { ok: boolean; reason?: string } {
  if (require.grey_blocks !== false) return { ok: true };
  const summary = second.summary;
  if (!("grey_blocks" in summary)) return { ok: true }; // degraded second eye — first eye + machine grey still gate
  const grey = (summary as QcSummary).grey_blocks;
  const saidGrey = grey === true || grey === "true" || GREY_RE.test(second.blind);
  if (saidGrey) {
    return { ok: false, reason: "second_eye: glm second eye saw grey/placeholder blocks" };
  }
  return { ok: true };
}

// ─── T43b 肖像 plain_background 閘：夜街／霓虹即 FAIL（LD0F A/E 教訓）───

/** 夜街死刑詞（卡上釘死四個）：street／街道／neon／霓虹。 */
export const NIGHT_STREET_RE = /street|街道|neon|霓虹/i;

/** T43b: armed only when the require asks for a plain background (portraits).
 *  Night-street vocabulary in the whole-image description (blind) or the second
 *  eye's location_notes fails regardless of the judge — one face on a night
 *  street is a scene still, not a portrait anchor. Keyframe stills never set
 *  the flag, so their location gate keeps its shape. */
export function judgePlainBackground(
  require: QcRequire,
  texts: { blind: string; locationNotes?: string | null },
): { ok: boolean; reason?: string } {
  if (require.plain_background !== true) return { ok: true };
  for (const [where, text] of [["blind", texts.blind], ["location_notes", texts.locationNotes ?? ""]] as const) {
    const hit = text.match(NIGHT_STREET_RE);
    if (hit) {
      return { ok: false, reason: `plain_background: 夜街字眼「${hit[0]}」出現喺 ${where}（肖像背景要純色）` };
    }
  }
  return { ok: true };
}

export type PhotoQcStatus = "GREEN" | "PASS_UNCONFIRMED" | "PASS_WITH_WARN" | "FAIL";

export type PhotoQcRecord = {
  tool: "slatecrew.photo_qc";
  ts: string;
  image: string;
  sha256: string;
  endpoint: string;
  model: string;
  require: QcRequire;
  status: PhotoQcStatus;
  blind: string;
  summary: QcSummary | { parse_error: string; raw: string };
  checks: QcVerdict["checks"];
  second?: SecondEyeRecord;
};

/** eyes overrides keep runPhotoQc testable without touching config.ts: first.eye
 *  points the MARS leg at a fixture; second arms the glm second eye. */
export type PhotoQcEyes = {
  first?: { url?: string; model?: string };
  second?: SecondEyeOpts;
};

/** blind write-up → summarize → judge vs require. HTTP failures throw (no local
 *  schema substitute); only a summary-parse failure records FAIL. Second eye
 *  (when armed) runs AFTER the first-eye verdict, sequentially. */
export async function runPhotoQc(
  pngFile: string,
  outJson: string,
  require: QcRequire,
  ctx: PhotoQcCtx = {},
  eyes: PhotoQcEyes = {},
): Promise<PhotoQcRecord> {
  const raw = fs.readFileSync(pngFile);
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  const secondCfg = resolveSecondEye(eyes.second);
  if (fs.existsSync(outJson)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outJson, "utf8")) as PhotoQcRecord;
      if (
        existing.tool === "slatecrew.photo_qc" &&
        (existing.status === "GREEN" || existing.status === "PASS_UNCONFIRMED") &&
        existing.sha256 === digest &&
        sameRequire(existing.require, require) &&
        (!secondCfg || existing.second?.model === secondCfg.model)
      ) {
        return existing;
      }
    } catch {
      /* fall through — re-run QC */
    }
  }
  const cfg = loadConfig();
  const url = eyes.first?.url ?? cfg.pictureQc.endpoint;
  const model = await probeVisionEndpoint(url, eyes.first?.model ?? cfg.pictureQc.model);
  const desc = await blindDescribe(url, model, pngFile);
  let summary: QcSummary;
  let verdict: QcVerdict;
  try {
    summary = await summarize(url, model, desc);
    verdict = judge(desc, summary, require, ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary = { parse_error: message, raw: desc.slice(0, 2000) };
    verdict = { status: "FAIL", checks: { status: "FAIL", fail_reasons: [`summary parse: ${message}`] } };
  }
  let second: SecondEyeRecord | undefined;
  if (secondCfg) {
    second = await runSecondEye(secondCfg.endpoint, secondCfg.model, pngFile);
    const se = judgeSecondEye(require, second);
    if (!se.ok && se.reason) {
      verdict = {
        status: "FAIL",
        checks: { ...verdict.checks, status: "FAIL", fail_reasons: [...verdict.checks.fail_reasons, se.reason] },
      };
    }
  }
  // T43b: portrait plain-background gate — night-street words in the whole
  // description or the second eye's location_notes fail regardless of the judge.
  const pb = judgePlainBackground(require, {
    blind: desc,
    locationNotes: second && !("parse_error" in second.summary) ? String((second.summary as QcSummary).location_notes ?? "") : "",
  });
  if (!pb.ok && pb.reason) {
    verdict = {
      status: "FAIL",
      checks: { ...verdict.checks, status: "FAIL", fail_reasons: [...verdict.checks.fail_reasons, pb.reason] },
    };
  }
  // T35b §2 grey gate: blob silhouette still hard-fails; flat coverage fails only
  // when the eye agrees (grey_blocks true) — either alone is a recorded warn.
  const warns: string[] = [];
  if (require.grey_blocks === false) {
    const eyeSaidGrey = summary.grey_blocks === true || summary.grey_blocks === "true";
    const g = await judgePhotoGreyLeak(pngFile, eyeSaidGrey);
    if (g.fail) {
      verdict = {
        status: "FAIL",
        checks: { ...verdict.checks, status: "FAIL", fail_reasons: [...verdict.checks.fail_reasons, g.fail] },
      };
    } else if (g.warn) {
      warns.push(g.warn);
    }
  }
  // T35b §3: unconditional empty-frame blocking gate (all-black/all-white frame).
  const ef = await measureEmptyFrame(pngFile);
  if (ef.hit) {
    verdict = {
      status: "FAIL",
      checks: {
        ...verdict.checks,
        status: "FAIL",
        fail_reasons: [...verdict.checks.fail_reasons, `empty_frame: ${ef.kind} coverage ${ef.frac.toFixed(2)} >= ${EMPTY_FRAME_MIN}`],
      },
    };
  }
  // T35 item 5: one eye alone never issues a final pass. Un-armed second eye
  // downgrades GREEN to PASS_UNCONFIRMED; pin/delivery keeps demanding GREEN.
  let status: PhotoQcStatus = verdict.status;
  if (status === "GREEN" && !secondCfg) status = "PASS_UNCONFIRMED";
  // T35b §2: a surviving warn is never silent — it becomes the status itself.
  if (status !== "FAIL" && warns.length > 0) status = "PASS_WITH_WARN";
  const record: PhotoQcRecord = {
    tool: "slatecrew.photo_qc",
    ts: new Date().toISOString(),
    // T36: bare filename — zero absolute paths inside job JSON records
    image: path.basename(pngFile),
    sha256: digest,
    endpoint: url,
    model,
    require,
    status,
    blind: desc,
    summary,
    checks: { ...verdict.checks, status, ...(warns.length > 0 ? { warns } : {}) },
    ...(second ? { second } : {}),
  };
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(record, null, 2));
  return record;
}

/** True only for the current QC schema with a real require and GREEN, where GREEN
 *  still hash-matches the PNG now on disk. Old receipts never count. */
export function pinQcAccepted(dir: string, shotId: string): boolean {
  const qcFile = path.join(dir, `${shotId}.photo_qc.json`);
  const png = path.join(dir, `${shotId}.png`);
  if (!fs.existsSync(qcFile) || !fs.existsSync(png)) return false;
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(fs.readFileSync(qcFile, "utf8")) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (data.tool !== "slatecrew.photo_qc" || data.status !== "GREEN") return false;
  if ("part_b" in data || typeof data.blind !== "string") return false;
  const require = data.require;
  if (typeof require !== "object" || require === null || Object.keys(require).length === 0) return false;
  const digest = crypto.createHash("sha256").update(fs.readFileSync(png)).digest("hex");
  return data.sha256 === digest;
}
