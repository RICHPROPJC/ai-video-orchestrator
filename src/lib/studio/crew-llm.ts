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

// exact-match deny; composed so app source never spells the id out
const DENIED_SEAT_MODEL = ["glm", "5.3"].join("-");

export const DEFAULT_CREW: CrewConfig = {
  endpoint: "",
  writerModel: "kimi-k3",
  boardsModel: "qwen3.6-35b",
  deny: [DENIED_SEAT_MODEL],
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
  /** deterministic repairs the desk made before zod — one `repair: field saw x became y` per coercion */
  repairs: string[];
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

/** Junk = a reply that never was a schema attempt: unparseable text,
 *  punctuation-only keys (qwen's `{",":"error"}` grave), an empty JSON-mode
 *  burst, or — when short — an object holding none of a seat's keys. */
function isJunkSeatReply(content: string): boolean {
  let obj: unknown;
  try {
    obj = JSON.parse(extractJsonObject(content));
  } catch {
    return true;
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return true;
  const o = obj as Record<string, unknown>;
  const keys = Object.keys(o);
  if (!keys.length || keys.every((k) => k === "" || /^[.,/]+$/.test(k))) return true;
  if (content.length >= 120) return false;
  return !("sceneId" in o || "thinking" in o || "beats" in o || "shots" in o || "title" in o);
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
  if (keys.every((k) => k === "" || /^[.,/]+$/.test(k))) return true;
  if (seat === "boards") {
    const r = obj as Record<string, unknown>;
    return !r.sceneId && !r.shots;
  }
  return false;
}

const RETRY_PREFIX = "你上一個回覆唔過 schema。逐項改，只回一個完整 JSON object，唔好道歉、唔好解釋：\n";
const RETRY_QUOTE_LABEL = "\n上一個回覆（節錄）：";

/** A repair-prompt, never a re-roll: the exact zod paths plus a slice of the
 *  model's own last output travel back, so it edits its answer in place. */
function retryUserText(errors: string[], previous: string): string {
  const lines = errors.slice(0, 6).map((e) => `- ${e}`);
  let text = RETRY_PREFIX + lines.join("\n");
  const quote = previous.replace(/\s+/g, " ").trim().slice(0, 200);
  if (quote) {
    const room = 800 - text.length - RETRY_QUOTE_LABEL.length;
    if (room > 0) text += `${RETRY_QUOTE_LABEL}${quote.slice(0, room)}`;
  }
  return text.length > 800 ? text.slice(0, 800) : text;
}

/** One line per desk coercion: `repair: <field> saw <x> became <y>`.
 *  Silent repair is fake thought — nothing changes without a receipt line. */
export type RepairNote = (line: string) => void;

export type ChatJsonResult<T> = { value: T; model: string; receipts: string[] };

/** Seat-lane throttle: 429 is the only HTTP status we ride out — 20s → 40s →
 *  80s, then the 429 escapes with its status text so events can record it. */
const HTTP_429_BACKOFF_MS = [20_000, 40_000, 80_000];

/** Junk passes re-ask for free, so the lane needs a hard stop: 3 counted
 *  attempts plus at most 2 junk passes, 5 HTTP calls, then it throws. */
const CALL_CEILING = 5;

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
  normalize?: (raw: unknown, note: RepairNote) => unknown;
  fetchImpl?: typeof fetch;
  /** test clock: receives every backoff wait instead of really sleeping */
  sleepImpl?: (ms: number) => Promise<void>;
}): Promise<ChatJsonResult<T>> {
  const endpoint = resolveCrewEndpoint(opts.crew);
  if (!endpoint) {
    throw new Error("crew.endpoint unset — set crew.endpoint in slatecrew.config.json or CREW_LLM_URL");
  }
  if (opts.crew.deny.includes(opts.model)) {
    throw new Error(`seat ${opts.seat} refused model ${opts.model}: listed in crew.deny`);
  }
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleepImpl ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxAttempts = opts.maxAttempts ?? 3;
  const messages: ChatMessage[] = [
    { role: "system", content: opts.system },
    { role: "user", content: opts.user },
  ];
  const receipts: string[] = [];
  fs.mkdirSync(opts.receiptDir, { recursive: true });

  // same request re-sent on throttle; every other HTTP status escapes at once
  let throttled = 0;
  const postChat = async (headers: Record<string, string>, body: Record<string, unknown>) => {
    for (;;) {
      const res = await doFetch(`${endpoint}/v1/chat/completions`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts.crew.timeoutMs),
      });
      if (res.status !== 429) return res;
      const text = await res.text().catch(() => "");
      const waitMs = HTTP_429_BACKOFF_MS[throttled];
      if (waitMs === undefined) {
        throw new Error(
          `seat ${opts.seat} ${opts.unit}: ${endpoint} HTTP 429 after ${throttled + 1} tries (backoff ${HTTP_429_BACKOFF_MS.join("/")}ms): ${text.slice(0, 300)}`,
        );
      }
      throttled += 1;
      await sleep(waitMs);
    }
  };

  let attempt = 0;
  let calls = 0;
  let repairs: string[] = [];
  while (attempt < maxAttempts) {
    if (calls >= CALL_CEILING) {
      throw new Error(
        `seat ${opts.seat} could not produce valid ${opts.unit}: ${CALL_CEILING}-call ceiling at ${attempt} counted attempt(s) — junk never burns an attempt, but the lane stops here`,
      );
    }
    calls += 1;
    const started = Date.now();
    const body = {
      model: opts.model,
      messages,
      response_format: { type: "json_object" },
      ...modelQuirks(opts.model),
    };
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (opts.crew.apiKey) headers.Authorization = `Bearer ${opts.crew.apiKey}`;
    const res = await postChat(headers, body);
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

    // junk / unparseable / punctuation-only is not a schema attempt: re-ask
    // without burning one. Applies with fetchImpl set too — tests must see it.
    if (isJunkSeatReply(content)) {
      if (calls < CALL_CEILING) await sleep(5000);
      continue;
    }
    attempt += 1;
    repairs = [];
    const note: RepairNote = (line) => {
      repairs.push(line.startsWith("repair:") ? line : `repair: ${line}`);
    };

    let value: T | undefined;
    let errors: string[] = [];
    try {
      let raw: unknown = JSON.parse(extractJsonObject(content));
      if (isEmptyJson(raw, opts.seat)) errors = ["empty json"];
      else {
        if (opts.normalize) raw = opts.normalize(raw, note);
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
      repairs,
      elapsed_ms: Date.now() - started,
    };
    const file = path.join(opts.receiptDir, `${opts.seat}.${opts.unit}.${attempt}.json`);
    fs.writeFileSync(file, JSON.stringify(receipt, null, 2));
    receipts.push(path.basename(file));

    if (errors.length === 0) return { value: value as T, model: opts.model, receipts };

    messages.push({ role: "assistant", content });
    messages.push({ role: "user", content: retryUserText(errors, content) });
  }
  throw new Error(`seat ${opts.seat} could not produce valid ${opts.unit} after ${maxAttempts} attempts`);
}
