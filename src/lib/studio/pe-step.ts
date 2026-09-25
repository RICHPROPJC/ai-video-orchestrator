import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import type { ShotFact } from "./types";
import { factTokens } from "./photo-qc";

/** Card D 掣3 — search-first PE step (Chau 0919 law, CHAU_FULL_FLOW_LAW_0917 §1).
 *  Before /edit, a text/data-screen shot passes: wigolo evidence (quick depth)
 *  → local PE brain composes the Render JSON + the facts rows → the pipeline
 *  writes those rows into the packet's require.facts (code assembles, never
 *  authors a number).
 *
 *  Brain routing is law, not preference: nex :8017 first (call-shape =
 *  chat_template_kwargs.reasoning_effort "none" + official sampling 0.7/0.95/40
 *  + max_tokens >= 5000), qwen38 :8015 backup. GLM cloud brains are banned —
 *  thinking bursts the content field (0919 wire receipts: 13,486 chars of
 *  reasoning, finish=length, zero usable content). */

export type PeConfig = {
  endpoint: string;
  model: string;
  fallbackEndpoint: string;
  fallbackModel: string;
  maxTokens: number;
  wigoloClient: string;
  timeoutMs: number;
  /** 簡單改寫。缺席時 webSearch:false 會停，唔會偷偷改行上網那條。 */
  rewriteEndpoint?: string;
  rewriteModel?: string;
};

/** the slice of wigolo's output the PE brain needs: the cited report plus its
 *  citation rows (url/title), never the raw 100KB source dump */
export type WigoloReport = { report: string; citations: { url: string; title: string }[] };

export type PeStepResult = {
  facts: ShotFact[];
  render: string;
  brain: string;
  question: string;
  wigoloMs: number;
  /** why the primary brain lost, when the backup answered */
  notes?: string;
};

export type PeDeps = {
  /** test fixture hook: return a canned report instead of spawning the client */
  wigolo?: (question: string) => Promise<WigoloReport>;
  fetchImpl?: typeof fetch;
};

const FETCHED_AT_RE = /^\d{4}-\d{2}-\d{2}$/;

const REWRITE_SYSTEM = [
  "你係 Editing PE（簡單改寫）。呢次冇開網上搜尋。",
  "唔准估數字、日期、名。畫面冇要上屏嘅數字就唔好寫數字。",
  "輸出只係一個 JSON object（冇 markdown、冇解釋）：{\"render\":{\"主體\":\"…\",\"場景\":\"…\",\"風格光照\":\"…\",\"約束\":\"…\"}}",
  "render 四個 key 都要有，一個唔准漏。",
].join("\n");

const PE_SYSTEM = [
  "你係 search-first PE（U1.5 官方 Image PE 步）。你會收到一份搜證報告同一個畫面需求。",
  "規矩：",
  "1. 只准用證據入面嘅數字／日期／名。證據冇嘅嘢一律唔准上屏，唔准估、唔准靠記憶補。",
  '2. 輸出只係一個 JSON object（冇 markdown、冇解釋）：{"facts":[{"claim":"…","source":"…","fetched_at":"YYYY-MM-DD"}],"render":"…"}',
  "3. facts 最多 8 行，只列會上屏嘅關鍵數字／日期／名（唔係成個證據表）；claim 係會逐字上屏嘅文案；source 係證據 URL 或標題；fetched_at 係證據日期（報告冇就俾今天）。",
  "4. render 係一個 JSON object（唔係字串），U1.5 結構化配方四要素齊口，四個 key 一個唔准漏：\"主體\"（邊個／邊樣嘢做主角）、\"場景\"（地點、時段、環境）、\"風格光照\"（色調、光源、質感、飽和度）、\"約束\"（可見文案—同 facts 逐字一致、數量、版式、排除項；一串文字）。",
  "5. render 入面出現嘅數字／日期／名必須同 facts 完全一致，一個字都唔准差。",
].join("\n");

/** GLM cloud brains (glm-5.3 / flash / turbo, deepseek) all fail PE — the
 *  guard fires on config, before any wire time is wasted. */
export function assertLocalPeBrain(model: string): void {
  if (/glm|deepseek/i.test(model)) {
    throw new Error(`PE 腦唔准用 ${model} — GLM 雲腦 thinking 爆 content（0919 法）；只有本地 nex :8017／qwen38 :8015 得`);
  }
}

/** slice the first JSON object out of raw text (wigolo prints the report JSON;
 *  the PE brain may fence or pad its answer) */
function sliceJsonObject(raw: string): unknown {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no JSON object in PE output: ${raw.slice(0, 300)}`);
  return JSON.parse(text.slice(a, b + 1));
}

/** run the wigolo research client (NDJSON MCP wrapper) at quick depth and keep
 *  the cited report + citations. Real calls are allowed; tests inject deps.wigolo. */
export async function runWigolo(question: string, clientPath: string, timeoutMs: number): Promise<WigoloReport> {
  const raw = await new Promise<string>((resolve, reject) => {
    const child = spawn("python3", [clientPath, "quick", question], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`wigolo quick research timed out after ${timeoutMs}ms: ${question.slice(0, 80)}`));
    }, timeoutMs);
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (err += d.toString()));
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(new Error(`wigolo client spawn failed (${clientPath}): ${e.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error(`wigolo client exit ${code}: ${err.slice(0, 300)}`));
      else resolve(out);
    });
  });
  const parsed = sliceJsonObject(raw) as { report?: unknown; citations?: unknown };
  const report = typeof parsed.report === "string" ? parsed.report : "";
  if (!report) throw new Error(`wigolo report empty for: ${question.slice(0, 80)}`);
  const citations = Array.isArray(parsed.citations)
    ? (parsed.citations as { url?: unknown; title?: unknown }[])
        .filter((c) => c && typeof c === "object")
        .map((c) => ({ url: String(c.url ?? ""), title: String(c.title ?? "") }))
    : [];
  return { report, citations };
}

type BrainCall = { endpoint: string; model: string; effortNone: boolean };

/** U1.5 結構化配方四要素 — the render object must carry all four, non-empty. */
const RENDER_KEYS = ["主體", "場景", "風格光照", "約束"] as const;

function renderMissingKeys(renderObj: Record<string, unknown>): string[] {
  return RENDER_KEYS.filter((k) => typeof renderObj[k] !== "string" || !(renderObj[k] as string).trim());
}

async function callBrain(
  brain: BrainCall,
  system: string,
  user: string,
  config: PeConfig,
  deps: PeDeps,
  maxTokens = config.maxTokens,
): Promise<string> {
  const doFetch = deps.fetchImpl ?? fetch;
  const body: Record<string, unknown> = {
    model: brain.model,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    temperature: 0.7,
    top_p: 0.95,
    top_k: 40,
    max_tokens: maxTokens,
  };
  if (brain.effortNone) body.chat_template_kwargs = { reasoning_effort: "none" };
  const res = await doFetch(`${brain.endpoint.replace(/\/$/, "")}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(config.timeoutMs),
  });
  if (!res.ok) throw new Error(`PE brain ${brain.model} HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = (await res.json()) as {
    choices?: { message?: { content?: string }; finish_reason?: string }[];
  };
  const choice = json.choices?.[0];
  const content = (choice?.message?.content ?? "").trim();
  if (!content) {
    throw new Error(`PE brain ${brain.model} empty content (finish=${choice?.finish_reason ?? "?"}) — thinking burst?`);
  }
  if (choice?.finish_reason === "length") {
    throw new Error(`PE brain ${brain.model} hit max_tokens (finish=length) — output truncated, refusing to parse`);
  }
  return content;
}

/** facts rows are validated hard: claim+source must be non-empty text; a bad
 *  fetched_at falls back to the run date (mechanical timestamp, not authored
 *  content). Rows without claim or source are dropped, never repaired. */
export function validateFacts(raw: unknown, runDate: string): ShotFact[] {
  if (!Array.isArray(raw)) return [];
  const facts: ShotFact[] = [];
  for (const row of raw) {
    if (!row || typeof row !== "object") continue;
    const r = row as Record<string, unknown>;
    const claim = typeof r.claim === "string" ? r.claim.trim() : "";
    const source = typeof r.source === "string" ? r.source.trim() : "";
    if (!claim || !source) continue;
    const at = typeof r.fetched_at === "string" && FETCHED_AT_RE.test(r.fetched_at) ? r.fetched_at : runDate;
    facts.push({ claim, source, fetched_at: at });
  }
  return facts;
}

const REWRITE_MAX_TOKENS = 8000;

function writePeReceipt(file: string, shotId: string, result: PeStepResult): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ tool: "slatecrew.pe_step", ts: new Date().toISOString(), shot: shotId, ...result }, null, 2));
}

/** 已經寫好嘅改寫收據。四要素齊就直接用，唔再叫腦。 */
function readRewriteReceipt(file: string, shotId: string): PeStepResult | null {
  if (!fs.existsSync(file)) return null;
  try {
    const rec = JSON.parse(fs.readFileSync(file, "utf8")) as { shot?: string; render?: string; brain?: string; question?: string };
    if (rec.shot && rec.shot !== shotId) return null;
    const renderObj = JSON.parse(rec.render ?? "") as Record<string, unknown>;
    if (!renderObj || typeof renderObj !== "object" || Array.isArray(renderObj)) return null;
    if (renderMissingKeys(renderObj).length) return null;
    return {
      facts: [],
      render: JSON.stringify(renderObj),
      brain: rec.brain || "receipt",
      question: rec.question || "",
      wigoloMs: 0,
    };
  } catch {
    return null;
  }
}

/** 簡單改寫。唔叫 wigolo，唔要求 facts。腦係 6.8，max_tokens 低過 8000 會燒晒 thinking。 */
async function runRewrite(opts: {
  shotId: string;
  action: string;
  context: string;
  config: PeConfig;
  deps?: PeDeps;
  receiptFile?: string;
}): Promise<PeStepResult> {
  const endpoint = opts.config.rewriteEndpoint?.trim() ?? "";
  const model = opts.config.rewriteModel?.trim() ?? "";
  if (!endpoint || !model) throw new Error("PE 簡單改寫未設定 rewriteEndpoint／rewriteModel");
  assertLocalPeBrain(model);
  if (opts.receiptFile) {
    const have = readRewriteReceipt(opts.receiptFile, opts.shotId);
    if (have) return have;
  }
  const raw = await callBrain(
    { endpoint, model, effortNone: false },
    REWRITE_SYSTEM,
    JSON.stringify({ shot: opts.shotId, 畫面需求: opts.action, 場景: opts.context }),
    opts.config,
    opts.deps ?? {},
    REWRITE_MAX_TOKENS,
  );
  const parsed = sliceJsonObject(raw) as { render?: unknown };
  const renderObj =
    parsed.render && typeof parsed.render === "object" && !Array.isArray(parsed.render)
      ? (parsed.render as Record<string, unknown>)
      : null;
  if (!renderObj) throw new Error(`PE rewrite ${model} returned empty render`);
  const missing = renderMissingKeys(renderObj);
  if (missing.length > 0) throw new Error(`PE rewrite ${model} render 缺結構四要素：${missing.join("、")}`);
  const result: PeStepResult = {
    facts: [],
    render: JSON.stringify(renderObj),
    brain: model,
    question: opts.action,
    wigoloMs: 0,
  };
  if (opts.receiptFile) writePeReceipt(opts.receiptFile, opts.shotId, result);
  return result;
}

/** Two PE routes. webSearch true: wigolo then nex, qwen38 backup.
 *  webSearch false: simple rewrite on 6.8, no web search, no fact rows required. */
export async function runPeStep(opts: {
  shotId: string;
  action: string;
  context: string;
  config: PeConfig;
  deps?: PeDeps;
  receiptFile?: string;
  /** Default true keeps the search route. False is the rewrite route. */
  webSearch?: boolean;
}): Promise<PeStepResult> {
  const { config } = opts;
  if (opts.webSearch === false) return runRewrite(opts);
  assertLocalPeBrain(config.model);
  assertLocalPeBrain(config.fallbackModel);
  if (config.maxTokens < 5000) throw new Error(`PE max_tokens ${config.maxTokens} < 5000 — nex effort none needs ≥5000 (0919 law)`);

  const t0 = Date.now();
  const evidence = await (opts.deps?.wigolo?.(opts.action) ?? runWigolo(opts.action, config.wigoloClient, config.timeoutMs));
  const wigoloMs = Date.now() - t0;

  const user = JSON.stringify({
    shot: opts.shotId,
    畫面需求: opts.action,
    場景: opts.context,
    搜證報告: evidence.report,
    引用: evidence.citations.map((c) => `${c.title} ${c.url}`.trim()),
  });

  const errors: string[] = [];
  const brains: BrainCall[] = [
    { endpoint: config.endpoint, model: config.model, effortNone: true },
    { endpoint: config.fallbackEndpoint, model: config.fallbackModel, effortNone: false },
  ];
  let facts: ShotFact[] = [];
  let render = "";
  let brainUsed = "";
  for (const brain of brains) {
    try {
      const raw = await callBrain(brain, PE_SYSTEM, user, config, opts.deps ?? {});
      const parsed = sliceJsonObject(raw) as { facts?: unknown; render?: unknown };
      const runDate = new Date().toISOString().slice(0, 10);
      const got = validateFacts(parsed.facts, runDate);
      // render is a JSON object (Image PE Render form); it rides the /edit
      // prompt as a compact JSON block, so it must be a non-empty object
      const renderObj =
        parsed.render && typeof parsed.render === "object" && !Array.isArray(parsed.render) && Object.keys(parsed.render).length > 0
          ? parsed.render
          : null;
      const gotRender = renderObj ? JSON.stringify(renderObj) : "";
      if (got.length === 0) throw new Error(`PE brain ${brain.model} returned 0 valid fact rows — refuse (evidence-less screen)`);
      if (!gotRender) throw new Error(`PE brain ${brain.model} returned empty render`);
      // U1.5 官方配方：擴寫要齊 場景+風格+約束（Nell #32 四掣同方向）— a render
      // missing a structural key is refused to the backup brain, never mounted
      const missing = renderMissingKeys(renderObj as Record<string, unknown>);
      if (missing.length > 0) {
        throw new Error(`PE brain ${brain.model} render 缺結構四要素：${missing.join("、")}（U1.5 官方：主體/場景/風格光照/約束）`);
      }
      // facts ride the QC judge as the on-screen contract, so only rows the
      // render actually paints may stay (the wire receipts showed PE dumping
      // the whole evidence table — 45 rows — which the blind eye can never
      // echo). Cap at 8, the packet zod ceiling.
      const painted = got.filter((f) => factTokens(f.claim).some((tok) => gotRender.includes(tok)));
      facts = (painted.length > 0 ? painted : got).slice(0, 8);
      render = gotRender;
      brainUsed = brain.model;
      break;
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  if (!brainUsed) {
    throw new Error(`PE step failed on both brains (${config.model}, ${config.fallbackModel}): ${errors.join(" | ")}`);
  }

  const result: PeStepResult = {
    facts,
    render,
    brain: brainUsed,
    question: opts.action,
    wigoloMs,
    ...(brainUsed !== config.model && errors.length > 0
      ? { notes: `primary ${config.model} failed: ${errors[0]!.slice(0, 300)}` }
      : {}),
  };
  if (opts.receiptFile) writePeReceipt(opts.receiptFile, opts.shotId, result);
  return result;
}
