import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";

const BLIND_PROMPT =
  "用中文只写看得见的东西：人数、衣服、姿势、手里的物件、地面、背景。" +
  "叫不出物件名字就写形状（柄、刃、木、铁、弯不弯），不要编名字或故事。";

const SUMMARIZE_PROMPT =
  "The following text is an eyewitness description of one still image. " +
  "Using ONLY that text, fill JSON (no markdown). If the text does not say it, " +
  'use null or "unknown". Keys:\n' +
  "- people_count (integer or null)\n" +
  "- pose_notes (short string)\n" +
  '- tool_as_written (verbatim clause about any held object, including shape words)\n' +
  "- grey_blocks (true/false/unknown): grey cubes, mannequin/i-mannequin placeholders, placards, or white silhouettes\n" +
  "Do not name characters. Do not decide whether an object is 'correct'.";

export type QcRequire = {
  people_count?: number | null;
  grey_blocks?: boolean;
  tool?: string;
  tool_shape?: string[];
  tool_forbid?: string[];
};

export type QcSummary = {
  people_count?: number | string | null;
  pose_notes?: string | null;
  tool_as_written?: string | null;
  grey_blocks?: boolean | string | null;
} & Record<string, unknown>;

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

export async function summarize(url: string, model: string, desc: string): Promise<QcSummary> {
  const raw = await chat(url, model, `${SUMMARIZE_PROMPT}\n\n---\n${desc}`, 800);
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  const a = text.indexOf("{");
  const b = text.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error(`no JSON object in summary: ${raw.slice(0, 400)}`);
  return JSON.parse(text.slice(a, b + 1)) as QcSummary;
}

export function judge(desc: string, summary: QcSummary, require: QcRequire): QcVerdict {
  const reasons: string[] = [];
  const checks: Record<string, unknown> = {};

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

  let status: "GREEN" | "FAIL" = Object.keys(checks).length > 0 && reasons.length === 0 ? "GREEN" : "FAIL";
  if (Object.keys(require).length === 0) {
    status = "FAIL";
    reasons.push("no require: cannot accept");
  }
  return { status, checks: { ...checks, status, fail_reasons: reasons } };
}

export type PhotoQcRecord = {
  tool: "slatecrew.photo_qc";
  ts: string;
  image: string;
  sha256: string;
  endpoint: string;
  model: string;
  require: QcRequire;
  status: "GREEN" | "FAIL";
  blind: string;
  summary: QcSummary | { parse_error: string; raw: string };
  checks: QcVerdict["checks"];
};

/** blind write-up → summarize → judge vs require. HTTP failures throw (no local
 *  schema substitute); only a summary-parse failure records FAIL. */
export async function runPhotoQc(pngFile: string, outJson: string, require: QcRequire): Promise<PhotoQcRecord> {
  const raw = fs.readFileSync(pngFile);
  const digest = crypto.createHash("sha256").update(raw).digest("hex");
  if (fs.existsSync(outJson)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outJson, "utf8")) as PhotoQcRecord;
      if (
        existing.tool === "slatecrew.photo_qc" &&
        existing.status === "GREEN" &&
        existing.sha256 === digest
      ) {
        return existing;
      }
    } catch {
      /* fall through — re-run QC */
    }
  }
  const cfg = loadConfig();
  const url = cfg.pictureQc.endpoint;
  const model = await probeVisionEndpoint(url, cfg.pictureQc.model);
  const desc = await blindDescribe(url, model, pngFile);
  let summary: QcSummary;
  let verdict: QcVerdict;
  try {
    summary = await summarize(url, model, desc);
    verdict = judge(desc, summary, require);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    summary = { parse_error: message, raw: desc.slice(0, 2000) };
    verdict = { status: "FAIL", checks: { status: "FAIL", fail_reasons: [`summary parse: ${message}`] } };
  }
  const record: PhotoQcRecord = {
    tool: "slatecrew.photo_qc",
    ts: new Date().toISOString(),
    image: pngFile,
    sha256: digest,
    endpoint: url,
    model,
    require,
    status: verdict.status,
    blind: desc,
    summary,
    checks: verdict.checks,
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
