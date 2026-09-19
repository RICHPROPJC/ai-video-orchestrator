import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { EMPTY_FRAME_MIN, judgePhotoGreyLeak, measureEmptyFrame } from "./workbench-grey-leak";

// ─── PACKAGE-QC-FORMULA-0917（Chau 0917 收斂版，SUPERSEDE 16:08 引導式假fail）───
// 眼（五路並行）：2K 全圖一路 + 4K 原生切四格各一路；prompt 只准一句，一字唔改。
// 判官（一路，text-only）：任務原文逐項 → 引描述原句標 達標/唔達標/冇提及 →
// 矛盾並列 → 決定。釘死：數碼寫實＝寫實；插畫／漫畫／厚塗／卡通／版畫先係唔寫實。

/** 公版眼 prompt —— PACKAGE 0917 指定句，帶圖 call 一字唔改，改咗就 throw。 */
export const EYE_PROMPT = "描述下呢個U1.5做出嚟嘅圖片。";

/** 發射前 lint：任何帶圖 call 嘅 prompt 唔係規定句 → throw，唔落網。 */
export function lintEyePrompt(prompt: string): string {
  if (prompt !== EYE_PROMPT) {
    throw new Error(`eye lint: image-bearing prompt must be exactly EYE_PROMPT ${JSON.stringify(EYE_PROMPT)}, got ${JSON.stringify(prompt)}`);
  }
  return prompt;
}

/** chat 出口 lint：content 帶 image_url 而文字部份 ≠ EYE_PROMPT → throw。
 *  引導式審問（第二條問題／清單／選項／「係咪」）從此進唔到任何帶圖 request。 */
export function lintEyeContent(content: unknown): void {
  if (!Array.isArray(content)) return;
  const parts = content as { type?: string; text?: string }[];
  if (!parts.some((p) => p?.type === "image_url")) return;
  const text = parts.filter((p) => p?.type === "text").map((p) => p.text ?? "").join("");
  lintEyePrompt(text);
}

/** Nex-n2.5 官方 sampling（PACKAGE 0917；唔用 temp 0）。 */
export const EYE_SAMPLING = { temperature: 0.7, top_p: 0.95, top_k: 40, reasoning_effort: "none" } as const;

/** qwen38 判官 sampling（README 例；唔抄 MARS temp 0.0）。 */
export const JUDGE_SAMPLING = { temperature: 0.7 } as const;

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

/** GET /v1/models on an endpoint; resolves the exact model id or throws.
 *  0917 公版：唔再有 mars 模糊後備——眼＝nex-n2.5(:8017)、判官＝qwen38(:8015)，
 *  probe 唔中即 fail loud，唔准估。 */
export async function probeVisionEndpoint(url: string, model: string): Promise<string> {
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/models`, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`vision endpoint down: GET ${url}/v1/models -> HTTP ${res.status}`);
  const json = (await res.json()) as { data?: { id?: string }[] };
  const ids = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
  if (ids.includes(model)) return model;
  throw new Error(`model ${model} not served on ${url}: have ${ids.join(", ") || "none"}`);
}

type ChatSampling = { temperature: number; top_p?: number; top_k?: number; reasoning_effort?: string };

async function chat(
  url: string,
  model: string,
  content: unknown,
  maxTokens: number,
  sampling: ChatSampling = { temperature: 0.1 },
  timeoutMs = 180_000,
): Promise<string> {
  lintEyeContent(content); // 帶圖 prompt 唔係規定句＝呢度 throw，唔落網
  const res = await fetch(`${url.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content }],
      max_tokens: maxTokens,
      temperature: sampling.temperature,
      ...(sampling.top_p !== undefined ? { top_p: sampling.top_p } : {}),
      ...(sampling.top_k !== undefined ? { top_k: sampling.top_k } : {}),
      ...(sampling.reasoning_effort !== undefined ? { reasoning_effort: sampling.reasoning_effort } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`vision chat ${url} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (json.choices?.[0]?.message?.content ?? "").trim();
}

// ─── 眼：五路（whole 2K + TL/TR/BL/BR 原生四格） ───

export type QuadKey = "TL" | "TR" | "BL" | "BR";

/** 判官輸入用嘅格仔標籤（PACKAGE 0917）。 */
export const QUAD_LABELS: Record<QuadKey, string> = { TL: "左上角", TR: "右上角", BL: "左下角", BR: "右下角" };

export type EyeLegs = { whole: Buffer; quads: Record<QuadKey, Buffer> };

/** 2K 全圖一路 + 原生切四格各一路。四格由原圖原生像素切出（唔降級）——
 *  風格來源唔可以用 2K 降級碎片。 */
export async function prepEyeLegs(pngFile: string): Promise<EyeLegs> {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(pngFile).metadata();
  const W = meta.width ?? 0;
  const H = meta.height ?? 0;
  if (W < 8 || H < 8) throw new Error(`photo-qc eye: unreadable or tiny image ${pngFile} (${W}x${H})`);
  const whole = await sharp(pngFile)
    .resize({ width: 2048, height: 2048, fit: "inside", withoutEnlargement: true })
    .png()
    .toBuffer();
  const hw = Math.floor(W / 2);
  const hh = Math.floor(H / 2);
  const crop = (left: number, top: number) =>
    sharp(pngFile).extract({ left, top, width: hw, height: hh }).png().toBuffer();
  const quads: Record<QuadKey, Buffer> = {
    TL: await crop(0, 0),
    TR: await crop(W - hw, 0),
    BL: await crop(0, H - hh),
    BR: await crop(W - hw, H - hh),
  };
  return { whole, quads };
}

/** 帶圖 describe：唯一合法 prompt 係 EYE_PROMPT（lint 喺 chat 出口再閘一次）。 */
export async function eyeDescribe(
  url: string,
  model: string,
  png: Buffer,
  sampling: ChatSampling = EYE_SAMPLING,
  maxTokens = 4000,
): Promise<string> {
  const b64 = png.toString("base64");
  return chat(
    url,
    model,
    [
      { type: "text", text: lintEyePrompt(EYE_PROMPT) },
      { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
    ],
    maxTokens,
    sampling,
  );
}

export type EyeDescriptions = { whole: string } & Record<QuadKey, string>;

/** 五路並行 describe（whole + 四格），全部同一隻眼模型。 */
export async function describeFive(url: string, model: string, legs: EyeLegs): Promise<EyeDescriptions> {
  const [whole, TL, TR, BL, BR] = await Promise.all([
    eyeDescribe(url, model, legs.whole),
    eyeDescribe(url, model, legs.quads.TL),
    eyeDescribe(url, model, legs.quads.TR),
    eyeDescribe(url, model, legs.quads.BL),
    eyeDescribe(url, model, legs.quads.BR),
  ]);
  return { whole, TL, TR, BL, BR };
}

/** 相容出口（video-qc／second eye 用）：同一句 EYE_PROMPT，temp 0.7。 */
export async function blindDescribe(url: string, model: string, imageFile: string): Promise<string> {
  const png = fs.readFileSync(imageFile);
  return eyeDescribe(url, model, png, { temperature: 0.7 });
}

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

// ─── 判官：text-only，唔見圖 ───

export type PackageJudgeItem = { item?: string; verdict?: string; evidence?: string };

export type PackageJudge = {
  items?: PackageJudgeItem[];
  contradictions?: string[];
  style?: { verdict?: string; evidence?: string };
  pass?: boolean;
  fail_reasons?: string[];
} & Record<string, unknown>;

/** 任務原文（require 逐項）→ 判官 prompt 用嘅清單。 */
export function renderRequireLines(require: QcRequire): string[] {
  const lines: string[] = [];
  if (require.people_count != null) lines.push(`- 人數：${require.people_count}`);
  if (require.tool) {
    let line = `- 道具：${require.tool}`;
    if (require.tool_shape?.length) line += `（形狀線索：${require.tool_shape.join("、")}）`;
    if (require.tool_forbid?.length) line += `（禁：${require.tool_forbid.join("、")}）`;
    lines.push(line);
  }
  if (require.location) lines.push(`- 地點：${require.location}`);
  // a keyframe is one frozen instant of the beat: motion verbs (彈起／掃跌／散落)
  // are judged by whether the pose is a plausible mid-action frame, not by
  // whether a still shows movement — WR1Q SH01 failed three /edits on this alone
  if (require.action) lines.push(`- 動作（呢張係動作中途一格定格；動態動詞只睇姿勢係唔係該動作進行中嘅一瞬，唔要求見到移動）：${require.action}`);
  if (require.size) lines.push(`- 尺寸：${require.size}`);
  if (require.plain_background === true) lines.push("- 背景：純色平面背景（唔准街道／夜街／霓虹場景）");
  if (require.grey_blocks === false) lines.push("- 灰模佔位：禁止（唔准有灰色方塊／人偶／剪影）");
  lines.push("- 風格：寫實（寫實包括數碼生成嘅寫實；插畫／漫畫／厚塗／卡通／版畫先係唔寫實）");
  return lines;
}

/** 公版判官 prompt：任務原文＋五份描述＋程序＋釘死規則＋JSON 回覆格式。 */
export function buildJudgePrompt(require: QcRequire, eyes: EyeDescriptions): string {
  const quads: QuadKey[] = ["TL", "TR", "BL", "BR"];
  return [
    "你係公版QC判官：只讀文字，唔會見到圖。",
    "",
    "任務原文（request require，逐項）：",
    ...renderRequireLines(require),
    "",
    "五份眼描述（同一張U1.5成品圖；【左上角】【右上角】【左下角】【右下角】係呢張圖入面嘅四分一格局部座標，唔係四張獨立圖）：",
    "",
    `【全圖】\n${eyes.whole}`,
    ...quads.flatMap((k) => ["", `【${QUAD_LABELS[k]}】\n${eyes[k]}`]),
    "",
    "程序（照次序做，逐步寫出）：",
    "1. 將任務要求逐項列出。",
    "2. 每項喺描述入面搵證據，引描述原句，標：達標／唔達標／冇提及。",
    "3. 五份描述之間有矛盾，並列雙方原句。",
    "4. 最後決定。",
    "",
    "規則（釘死，唔准推翻）：",
    "1. 判斷範圍＝具體可見內容＋風格，唔好腦補。",
    "2. 寫實包括數碼生成嘅寫實——「數碼」「數碼化」「數碼生成」「AI生成」「U1.5」字眼唔等於唔寫實。",
    "3. 插畫／漫畫／厚塗／卡通／版畫——只有呢五類先係唔寫實。",
    "4. 風格判斷只可以根據【全圖】描述（呢張圖係U1.5出品）；四格只用嚟捉全圖睇漏嘅可見內容，唔准攞四格碎片判風格。",
    "",
    "最後另起一行只回一個 JSON object（冇 code fence 冇廢話）：",
    '{"items":[{"item":"…","verdict":"達標|唔達標|冇提及","evidence":"引描述原句"}],',
    '"contradictions":["並列原句"],',
    '"style":{"verdict":"寫實|插畫|漫畫|厚塗|卡通|版畫","evidence":"【全圖】原句"},',
    '"pass":true,"fail_reasons":["一句到點"]}',
  ].join("\n");
}

/** 判官 call：text-only（content 係純字串，唔收 image bytes）。 */
export async function runPackageJudge(
  url: string,
  model: string,
  require: QcRequire,
  eyes: EyeDescriptions,
): Promise<PackageJudge> {
  const raw = await chat(url, model, buildJudgePrompt(require, eyes), 6000, JUDGE_SAMPLING, 300_000);
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no JSON object in judge reply: ${raw.slice(0, 400)}`);
  return JSON.parse(text.slice(a, b + 1)) as PackageJudge;
}

// ─── 風格守衞：Chau 0917 主點——數碼寫實＝寫實（code 層釘死，唔靠判官自覺） ───

/** 五類唔寫實（PACKAGE 0917 規則 3）。 */
export const NON_PHOTOREAL_RE =
  /插畫|插画|漫畫|漫画|厚塗|厚涂|卡通|版畫|版画|illustration|comic|graphic novel|cartoon|anime|manga|woodblock|printmak/i;

/** 數碼寫實家族（出現呢啲字眼而冇五類唔寫實字眼＝仍然寫實）。 */
export const DIGITAL_REALISM_RE =
  /數碼|数码|數位|数位|数字|數字|AI生成|人工智能|生成式|生成模型|U1\.5|電腦繪|电脑绘|電繪|电绘|渲染|digital|AI-generated|computer-generated|photoreal|3d render/i;

export type StyleGuardResult = {
  judge: PackageJudge;
  guard: string[]; // 推翻記錄（唔係 fail_reasons）
  styleNonPhotoreal: boolean;
};

/** 守衞只在「數碼家族字眼出現、而五類唔寫實字眼完全冇出現」時推翻風格死刑。 */
export function applyStyleGuard(judge: PackageJudge): StyleGuardResult {
  const guard: string[] = [];
  const out: PackageJudge = { ...judge, items: judge.items?.map((i) => ({ ...i })), fail_reasons: judge.fail_reasons ? [...judge.fail_reasons] : [] };

  const digitalOnly = (text: string | undefined) =>
    !!text && DIGITAL_REALISM_RE.test(text) && !NON_PHOTOREAL_RE.test(text);

  // 1. fail_reasons：淨係數碼字眼嘅風格死刑理由 → 推翻
  if (out.fail_reasons) {
    const kept: string[] = [];
    for (const reason of out.fail_reasons) {
      if (digitalOnly(reason)) guard.push(`style_guard: 數碼寫實＝寫實（推翻 ${JSON.stringify(reason)}）`);
      else kept.push(reason);
    }
    out.fail_reasons = kept;
  }

  // 2. 風格 item：唔達標但證據淨係數碼字眼 → 翻做達標
  if (out.items) {
    for (const item of out.items) {
      if (item.verdict === "唔達標" && /風格|风格|style/i.test(item.item ?? "") && digitalOnly(`${item.item ?? ""} ${item.evidence ?? ""}`)) {
        item.verdict = "達標";
        guard.push(`style_guard: 風格項推翻（${item.item ?? "?"} 證據只含數碼寫實字眼）`);
      }
    }
  }

  // 3. style verdict：數碼寫實家族 → 寫實
  let styleNonPhotoreal = false;
  if (out.style?.verdict) {
    if (NON_PHOTOREAL_RE.test(out.style.verdict)) {
      styleNonPhotoreal = true;
    } else if (DIGITAL_REALISM_RE.test(out.style.verdict) && out.style.verdict !== "寫實") {
      guard.push(`style_guard: ${out.style.verdict} → 寫實（數碼寫實＝寫實）`);
      out.style = { ...out.style, verdict: "寫實" };
    }
  }

  // 4. pass：所有被推翻後已無死因 → 翻做 pass
  const failedItems = (out.items ?? []).filter((i) => i.verdict === "唔達標");
  if (judge.pass === false && out.pass !== true && guard.length > 0 && failedItems.length === 0 && (out.fail_reasons?.length ?? 0) === 0 && !styleNonPhotoreal) {
    out.pass = true;
    guard.push("style_guard: 判官 pass=false 全部因數碼字眼成立 → 推翻");
  }
  return { judge: out, guard, styleNonPhotoreal };
}

/** 判官輸出 → QcVerdict（GREEN/FAIL ＋ fail_reasons）。 */
export function packageVerdict(require: QcRequire, judgeOut: PackageJudge): QcVerdict {
  const reasons: string[] = [];
  const checks: Record<string, unknown> = {};
  const { judge: j, guard, styleNonPhotoreal } = applyStyleGuard(judgeOut);

  if (Object.keys(require).length === 0) {
    reasons.push("no require: cannot accept");
  }

  for (const item of j.items ?? []) {
    if (item.verdict === "唔達標") {
      reasons.push(`${item.item ?? "項目"}: 唔達標 — ${item.evidence ?? "（判官冇引句）"}`);
    }
  }
  if (styleNonPhotoreal) {
    reasons.push(`style: ${j.style?.verdict ?? ""} 唔係寫實（插畫／漫畫／厚塗／卡通／版畫） — ${j.style?.evidence ?? ""}`);
  }
  for (const reason of j.fail_reasons ?? []) reasons.push(reason);
  if (j.pass === false && reasons.length === 0) {
    reasons.push("judge pass=false 但冇列任何理由 — fail loud");
  }

  checks.items = j.items ?? [];
  checks.style = j.style ?? null;
  checks.contradictions = j.contradictions ?? [];
  if (guard.length > 0) checks.style_guard = guard;

  const status: "GREEN" | "FAIL" = reasons.length === 0 ? "GREEN" : "FAIL";
  return { status, checks: { ...checks, status, fail_reasons: reasons } };
}

/** CJK bigrams + latin words — sheet tokens, never hardcoded story nouns. */
export function sceneGrams(text: string): string[] {
  const folded = foldCjk(text);
  const out: string[] = [];
  const chars = [...folded];
  for (let i = 0; i < chars.length - 1; i++) {
    if (/[一-鿿]/.test(chars[i]!) && /[一-鿿]/.test(chars[i + 1]!)) {
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

/** 舊 bigram judge（video-qc 幀檢同舊收據路仲用；公版 stills 路已行五路＋判官）。 */
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

/** C10 second eye — glm-5.3-flash via LiteLLM :4000. The second eye is one extra
 *  sequential pass, never fan-out; it describes with the same EYE_PROMPT. */
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
 *  relying on ambient env inside runPhotoQc. Eye/judge endpoints come from config
 *  (nex :8017 / pictureQc :8015); env set → :4000 glm-5.3-flash second eye. */
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

/** 公版 record（0917 五路眼＋text-only 判官）。blind 保留＝全圖路描述（pin 法讀佢）。 */
export type PhotoQcRecord = {
  tool: "slatecrew.photo_qc";
  ts: string;
  formula: "package-0917";
  image: string;
  sha256: string;
  eye: { endpoint: string; model: string; sampling: ChatSampling };
  judgeCfg: { endpoint: string; model: string; temperature: number };
  require: QcRequire;
  status: PhotoQcStatus;
  blind: string;
  quads: Record<QuadKey, string>;
  judgeOutput: PackageJudge | { parse_error: string; raw: string };
  checks: QcVerdict["checks"];
  second?: SecondEyeRecord;
};

export const QC_FORMULA = "package-0917" as const;

/** eyes overrides keep runPhotoQc testable without touching config.ts: first
 *  points the five-path eye at a fixture; judge points the text-only judge at a
 *  fixture; second arms the glm second eye. */
export type PhotoQcEyes = {
  first?: { url?: string; model?: string };
  judge?: { url?: string; model?: string };
  second?: SecondEyeOpts;
};

/** 公版 stills QC：五路眼（nex :8017）並行 describe → text-only 判官（qwen38 :8015）
 *  逐項引句判 → 風格守衞（數碼寫實＝寫實）→ second eye／grey／empty 機器閘照舊。
 *  HTTP failures throw (no local schema substitute); only a judge-parse failure
 *  records FAIL. Cache law: formula+sha+require+parsed judge+second-eye model. */
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
      // T35b-cache: every terminal verdict caches - GREEN, PASS_UNCONFIRMED,
      // PASS_WITH_WARN and FAIL alike. Only a judge-parse failure re-runs (the
      // gate itself never issued a verdict there). 0917 公版：收據必須係本公式
      // 先算數（formula 不符＝舊公式收據，重跑）。
      const judgeParsed =
        !!existing.judgeOutput && typeof existing.judgeOutput === "object" && !("parse_error" in existing.judgeOutput);
      if (
        existing.tool === "slatecrew.photo_qc" &&
        existing.formula === QC_FORMULA &&
        ["GREEN", "PASS_UNCONFIRMED", "PASS_WITH_WARN", "FAIL"].includes(existing.status) &&
        judgeParsed &&
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
  const eyeUrl = eyes.first?.url ?? cfg.nex.endpoint;
  const eyeModel = await probeVisionEndpoint(eyeUrl, eyes.first?.model ?? cfg.nex.model);
  const judgeUrl = eyes.judge?.url ?? cfg.pictureQc.endpoint;
  const judgeModel = await probeVisionEndpoint(judgeUrl, eyes.judge?.model ?? cfg.pictureQc.model);

  const legs = await prepEyeLegs(pngFile);
  const desc = await describeFive(eyeUrl, eyeModel, legs);
  const blind = desc.whole;

  let judgeOutput: PhotoQcRecord["judgeOutput"];
  let verdict: QcVerdict;
  try {
    judgeOutput = await runPackageJudge(judgeUrl, judgeModel, require, desc);
    verdict = packageVerdict(require, judgeOutput);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    judgeOutput = { parse_error: message, raw: blind.slice(0, 2000) };
    verdict = { status: "FAIL", checks: { status: "FAIL", fail_reasons: [`judge parse: ${message}`] } };
  }

  if (ctx.prevDesc) {
    const sim = jaccardGrams(blind, ctx.prevDesc);
    if (sim >= 0.42) {
      verdict = {
        status: "FAIL",
        checks: { ...verdict.checks, status: "FAIL", fail_reasons: [...verdict.checks.fail_reasons, `distinct: still too close to previous (jaccard ${sim.toFixed(2)})`] },
      };
    }
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
    blind,
    locationNotes: second && !("parse_error" in second.summary) ? String((second.summary as QcSummary).location_notes ?? "") : "",
  });
  if (!pb.ok && pb.reason) {
    verdict = {
      status: "FAIL",
      checks: { ...verdict.checks, status: "FAIL", fail_reasons: [...verdict.checks.fail_reasons, pb.reason] },
    };
  }
  // T35b §2 grey gate: blob silhouette still hard-fails; flat coverage fails only
  // when the eye agrees (five descriptions mention grey) — either alone is a warn.
  const warns: string[] = [];
  if (require.grey_blocks === false) {
    const eyeSaidGrey = GREY_RE.test(`${blind}\n${desc.TL}\n${desc.TR}\n${desc.BL}\n${desc.BR}`);
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
    formula: QC_FORMULA,
    image: pngFile,
    sha256: digest,
    eye: { endpoint: eyeUrl, model: eyeModel, sampling: EYE_SAMPLING },
    judgeCfg: { endpoint: judgeUrl, model: judgeModel, temperature: JUDGE_SAMPLING.temperature },
    require,
    status,
    blind,
    quads: { TL: desc.TL, TR: desc.TR, BL: desc.BL, BR: desc.BR },
    judgeOutput,
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
