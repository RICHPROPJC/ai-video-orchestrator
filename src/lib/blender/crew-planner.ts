import { z } from "zod";
import { chatJsonWithFallback, type CrewConfig, type CrewImage } from "../studio/crew-llm";
import { TOOL_CATALOG } from "./engine";
import { PLAYBOOKS, PROTOCOL } from "./playbooks";
import type { JsonValue, ToolCall, ToolName } from "./types";

/** C9b: the run-time planner is crew.blenderModel (sensenova-v6.8-flash-lite,
 *  native multimodal, no VAE) through the same chatJson / LiteLLM :4000 door —
 *  glm-5.3-flash is the second eye / fallback, never the primary. The model
 *  UNDERSTANDS (picks playbook ids and ToolCalls from the frozen catalog);
 *  the typed engine DOES. World is obs JSON. The model never writes bpy and
 *  never executes a string. No matching vocab → no_playbook, never invent. */

const TOOL_NAMES = TOOL_CATALOG.map((t) => t.name) as [ToolName, ...ToolName[]];

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]),
);

export const ToolCallSchema = z.object({
  tool: z.enum(TOOL_NAMES),
  args: z.record(z.string(), JsonValueSchema).default({}),
});

/** The planner's whole legal vocabulary: a playbook id, or catalog ToolCalls. */
export const PlanReplySchema = z.object({
  playbook: z.string().nullable(),
  calls: z.array(ToolCallSchema),
  note: z.string().default(""),
});

export type PlanReply = z.infer<typeof PlanReplySchema>;

/** The /spec the planner reads — same shape the astra spec route serves,
 *  built in-repo; no HTTP loopback to ourselves. */
export function plannerSpec() {
  return {
    protocol: PROTOCOL.id,
    rule: PROTOCOL.ruleZh,
    tools: TOOL_CATALOG.map((t) => ({ name: t.name, summary: t.summary })),
    playbooks: PLAYBOOKS.map((p) => ({ id: p.id, version: p.version, intents: p.intents, checks: p.checks })),
  };
}

const PLANNER_SYSTEM = `你係 Astra planner（協議 ${PROTOCOL.id}）。規矩：
- 你唔准寫 bpy，唔准執行字串，唔准發明工具名或者 playbook id。
- 只准從 spec.tools 揀 ToolCall，同／或者從 spec.playbooks 揀一個 id。
- 意圖同 vocab 唔啱：回 {"playbook": null, "calls": [], "note": "<一句講點解唔啱>"}。唔好作。
- args 只用 JSON。只回一個 JSON object：{"playbook": <id|null>, "calls": [{"tool": "...", "args": {...}}], "note": "一句"}`;

export function plannerUser(prompt: string) {
  return `${JSON.stringify(plannerSpec())}\n\n用戶需求：${prompt}`;
}

export type PlannerStageLine = {
  agent: "blender";
  level: "info" | "pass" | "fail";
  message: string;
  data: { shot: string; stage: "plan"; eye: string; verdict: "pass" | "fail" | "info"; proof?: string; ms: number };
};

export type PlannerOutcome =
  | { status: "ok"; playbook: string | null; calls: ToolCall[]; note: string; model: string; receipts: string[]; ms: number }
  | { status: "no_playbook"; note: string; model: string; receipts: string[]; ms: number }
  | { status: "FAIL"; reason: "plan_invalid"; error: string; ms: number };

/** One planner turn: flash-lite picks, zod gates, code applies. A reply that
 *  cannot become valid ToolCall[] (or invents a playbook id) is plan_invalid;
 *  an honest empty pick is no_playbook. The caller pipes stage lines into
 *  store.emit so the turn lands in projects/<ep>/events.jsonl (A4). */
export async function planWithCrew(opts: {
  prompt: string;
  crew: CrewConfig;
  receiptDir: string;
  shot?: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  onEvent?: (line: PlannerStageLine) => void;
}): Promise<PlannerOutcome> {
  const started = Date.now();
  const shot = opts.shot ?? "*";
  const emit = (verdict: "pass" | "fail" | "info", message: string, extra?: { proof?: string }) =>
    opts.onEvent?.({
      agent: "blender",
      level: verdict === "pass" ? "pass" : verdict === "fail" ? "fail" : "info",
      message,
      data: {
        shot, stage: "plan", eye: opts.crew.blenderModel, verdict,
        ...(extra?.proof ? { proof: extra.proof } : {}), ms: Date.now() - started,
      },
    });
  try {
    const out = await chatJsonWithFallback({
      seat: "blender",
      unit: opts.shot ? `plan.${opts.shot}` : "plan",
      model: opts.crew.blenderModel,
      fallbackModel: opts.crew.blenderFallback,
      crew: opts.crew,
      system: PLANNER_SYSTEM,
      user: plannerUser(opts.prompt),
      schema: PlanReplySchema,
      receiptDir: opts.receiptDir,
      fetchImpl: opts.fetchImpl,
      sleepImpl: opts.sleepImpl,
      maxAttempts: opts.maxAttempts,
    });
    const ms = Date.now() - started;
    if (out.value.playbook !== null && !PLAYBOOKS.some((p) => p.id === out.value.playbook)) {
      emit("fail", `plan_invalid：model 發明咗 playbook id ${out.value.playbook}`);
      return { status: "FAIL", reason: "plan_invalid", error: `invented playbook id ${out.value.playbook}`, ms };
    }
    if (!out.value.playbook && out.value.calls.length === 0) {
      emit("info", `no_playbook：${out.value.note || "冇命中 vocab"}`);
      return { status: "no_playbook", note: out.value.note, model: out.model, receipts: out.receipts, ms };
    }
    emit("pass", `plan ok：${out.value.calls.length} 個 ToolCall${out.value.playbook ? ` · playbook ${out.value.playbook}` : ""}`, {
      proof: out.receipts[0],
    });
    return { status: "ok", playbook: out.value.playbook, calls: out.value.calls, note: out.value.note, model: out.model, receipts: out.receipts, ms };
  } catch (err) {
    const ms = Date.now() - started;
    const error = err instanceof Error ? err.message : String(err);
    emit("fail", `plan_invalid：${error.slice(0, 160)}`);
    return { status: "FAIL", reason: "plan_invalid", error, ms };
  }
}

const OBSERVE_SYSTEM = `你係 Astra 觀察眼（one call，native multimodal）。你收：U1.5 still（Image 1）、Blender render frame（Image 2）、observation JSON（text）。比較兩張圖同個 obs，回 {"match": <bool>, "description": "<40字以上：講畫面同 obs 有咩出入>", "risks": ["一句一個風險"]}。
規矩：你嘅判斷係描述，唔係閘。PIL mask centroid（hero_on_screen）係代碼閘；你一句話永遠唔會將一個 ✗ 變 ✓。`;

export const ObserveReplySchema = z.object({
  match: z.boolean(),
  description: z.string().min(20),
  risks: z.array(z.string()).default([]),
});

export type ObserveReply = z.infer<typeof ObserveReplySchema>;

/** The A7 one-call: U1.5 still + render frame + obs JSON in a single
 *  multimodal turn on the planner model. glm-5.3-flash is the second eye
 *  when Flash Lite misses. Describes — never gates. */
export async function observeRender(opts: {
  shot: string;
  obsJson: string;
  still: CrewImage;
  frame: CrewImage;
  crew: CrewConfig;
  receiptDir: string;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
  maxAttempts?: number;
}): Promise<{ reply: ObserveReply; model: string; ms: number; fellBack: boolean }> {
  const started = Date.now();
  const out = await chatJsonWithFallback({
    seat: "blender",
    unit: `observe.${opts.shot}`,
    model: opts.crew.blenderModel,
    fallbackModel: opts.crew.blenderFallback,
    crew: opts.crew,
    system: OBSERVE_SYSTEM,
    user: `shot ${opts.shot}。observation JSON：\n${opts.obsJson}\nImage 1 係 U1.5 still；Image 2 係 render frame。`,
    schema: ObserveReplySchema,
    receiptDir: opts.receiptDir,
    images: [opts.still, opts.frame],
    fetchImpl: opts.fetchImpl,
    sleepImpl: opts.sleepImpl,
    maxAttempts: opts.maxAttempts,
  });
  return { reply: out.value, model: out.model, ms: Date.now() - started, fellBack: out.fellBack };
}
