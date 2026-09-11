import fs from "node:fs";
import path from "node:path";
import type { ZodType } from "zod";

/** The seat lane: an OpenAI-compatible endpoint that serves the seat models.
 *  endpoint "" is fail-loud on purpose — a seat must never quietly skip its model. */
export type CrewConfig = {
  endpoint: string;
  writerModel: string;
  boardsModel: string;
  deny: string[];
  apiKey: string;
  timeoutMs: number;
};

export const DEFAULT_CREW: CrewConfig = {
  endpoint: "",
  writerModel: "kimi-k3",
  boardsModel: "qwen3.6-35b",
  deny: ["glm-5.3"],
  apiKey: "",
  timeoutMs: 600_000,
};

export type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

export type CrewReceipt = {
  tool: "slatecrew.crew_llm";
  ts: string;
  seat: string;
  unit: string;
  model: string;
  endpoint: string;
  attempt: number;
  messages: ChatMessage[];
  content: string;
  reasoning: string;
  valid: boolean;
  errors: string[];
  elapsed_ms: number;
};

export function resolveCrewEndpoint(crew: CrewConfig): string {
  const env = process.env.CREW_LLM_URL?.trim();
  return (env || crew.endpoint || "").replace(/\/$/, "");
}

/** Quirks measured on this lane: kimi-k3 rejects any temperature but 1; qwen
 *  leaks its thoughts into content unless the chat template disables thinking. */
export function modelQuirks(model: string): Record<string, unknown> {
  const quirks: Record<string, unknown> = {};
  if (/^kimi-k3/i.test(model)) quirks.temperature = 1;
  if (/^qwen/i.test(model)) quirks.chat_template_kwargs = { enable_thinking: false };
  return quirks;
}

export function stripThink(raw: string): string {
  return raw.replace(/^\s*<think>[\s\S]*?<\/think>/i, "").trim();
}

/** JSON mode still occasionally arrives fenced or with a thought preamble. */
export function extractJsonObject(raw: string): string {
  let text = stripThink(raw);
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = (fence[1] ?? "").trim();
  const open = text.indexOf("{");
  const close = text.lastIndexOf("}");
  if (open < 0 || close <= open) {
    throw new Error(`no JSON object in reply: ${text.slice(0, 200) || "(empty)"}`);
  }
  return text.slice(open, close + 1);
}

function issueLines(error: unknown): string[] {
  const issues = (error as { issues?: { path?: (string | number)[]; message?: string }[] }).issues;
  if (!issues?.length) return [error instanceof Error ? error.message : String(error)];
  return issues.map((i) => `${(i.path ?? []).join(".") || "(root)"}: ${i.message ?? "invalid"}`);
}

function isEmptyJson(obj: unknown, seat: string): boolean {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return true;
  const keys = Object.keys(obj);
  if (keys.length === 0) return true;
  if (keys.every((k) => k === "")) return true;
  if (seat === "boards") {
    const r = obj as Record<string, unknown>;
    return !r.sceneId && !r.shots;
  }
  return false;
}

const RETRY_PREFIX = "你上一個回覆唔過 schema。逐項改，只回一個完整 JSON object，唔好道歉、唔好解釋：\n";

function retryUserText(errors: string[]): string {
  const lines = errors.slice(0, 6).map((e) => `- ${e}`);
  let text = RETRY_PREFIX + lines.join("\n");
  if (text.length > 800) text = text.slice(0, 800);
  return text;
}

export type ChatJsonResult<T> = { value: T; model: string; receipts: string[] };

/** One seat turn: charter as system, sealed packet as the only user content,
 *  zod as the gate. Every attempt leaves a receipt, valid or not. */
export async function chatJson<T>(opts: {
  seat: string;
  unit: string;
  model: string;
  crew: CrewConfig;
  system: string;
  user: string;
  schema: ZodType<T>;
  receiptDir: string;
  maxAttempts?: number;
  normalize?: (raw: unknown) => unknown;
  fetchImpl?: typeof fetch;
}): Promise<ChatJsonResult<T>> {
  const endpoint = resolveCrewEndpoint(opts.crew);
  if (!endpoint) {
    throw new Error("crew.endpoint unset — set crew.endpoint in slatecrew.config.json or CREW_LLM_URL");
  }
  if (opts.crew.deny.includes(opts.model)) {
    throw new Error(`seat ${opts.seat} refused model ${opts.model}: listed in crew.deny`);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const maxAttempts = opts.maxAttempts ?? 3;
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const receipts: string[] = [];
  fs.mkdirSync(opts.receiptDir, { recursive: true });

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const started = Date.now();
    const body = {
      model: opts.model,
      messages,
      response_format: { type: "json_object" },
      ...modelQuirks(opts.model),
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.crew.apiKey) headers.Authorization = `Bearer ${opts.crew.apiKey}`;
    const res = await doFetch(`${endpoint}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(opts.crew.timeoutMs),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`seat ${opts.seat} ${opts.unit}: ${endpoint} HTTP ${res.status}: ${text.slice(0, 300)}`);
    }
    const json = (await res.json()) as {
      choices?: { message?: { content?: string; reasoning_content?: string } }[];
    };
    const message = json.choices?.[0]?.message;
    const content = message?.content ?? "";
    const reasoning = message?.reasoning_content ?? "";

    let value: T | undefined;
    let errors: string[] = [];
    try {
      let raw: unknown = JSON.parse(extractJsonObject(content));
      if (isEmptyJson(raw, opts.seat)) errors = ["empty json"];
      else {
        if (opts.normalize) raw = opts.normalize(raw);
        const parsed = opts.schema.safeParse(raw);
        if (parsed.success) value = parsed.data;
        else errors = issueLines(parsed.error);
      }
    } catch (error) {
      errors = [error instanceof Error ? error.message : String(error)];
    }

    const receipt: CrewReceipt = {
      tool: "slatecrew.crew_llm",
      ts: new Date().toISOString(),
      seat: opts.seat,
      unit: opts.unit,
      model: opts.model,
      endpoint,
      attempt,
      messages,
      content,
      reasoning,
      valid: errors.length === 0,
      errors,
      elapsed_ms: Date.now() - started,
    };
    const file = path.join(opts.receiptDir, `${opts.seat}.${opts.unit}.${attempt}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
    receipts.push(path.basename(file));

    if (errors.length === 0) return { value: value as T, model: opts.model, receipts };

    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: retryUserText(errors) });
  }
  throw new Error(`seat ${opts.seat} could not produce valid ${opts.unit} after ${maxAttempts} attempts`);
}
