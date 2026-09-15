import { z } from "zod";
import {
  PlanContextSchema, PlanSchema, AuthoringToolCallSchema, expandedSkill, selectPlaybook,
  type PlanContext, type ValidatedToolCall,
} from "./spec";

export type PlanFailure = { ok: false; status: "FAIL"; error: "plan_invalid" | "no_playbook"; detail: string; executorCalls: 0 };
export type ValidatedPlan = { ok: true; playbookId: string; calls: ValidatedToolCall[] };
const fail = (error: PlanFailure["error"], detail: string): PlanFailure => ({ ok: false, status: "FAIL", error, detail, executorCalls: 0 });
const RefusalSchema = z.strictObject({ error: z.literal("no_playbook") });

/** No execution, repair, JSON extraction, coercion, or fallback is performed here. */
export function validatePlan(raw: string, context: PlanContext): ValidatedPlan | PlanFailure {
  if (typeof raw !== "string" || raw.length > 65536) return fail("plan_invalid", "plan must be a JSON string <=65536 characters");
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { return fail("plan_invalid", "invalid JSON"); }
  const trusted = PlanContextSchema.safeParse(context);
  if (!trusted.success) return fail("plan_invalid", "invalid trusted context");
  if (RefusalSchema.safeParse(value).success) return fail("no_playbook", "model selected no_playbook");
  const book = selectPlaybook(trusted.data.intent);
  if (!book) return fail("no_playbook", "intent is outside the authored vocabulary");
  const parsed = PlanSchema.safeParse(value);
  if (!parsed.success) return fail("plan_invalid", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  if (parsed.data.playbookId !== book.id) return fail("no_playbook", "selected playbook does not match the authored intent");
  const allowed = new Set(trusted.data.nextAllowed);
  const expanded: ValidatedToolCall[] = [];
  // Preflight ALL steps, including the tail and every authored skill expansion.
  for (const call of parsed.data.calls) {
    if (!allowed.has(call.tool)) return fail("plan_invalid", `nextAllowed forbids ${call.tool}`);
    const steps = call.tool === "skill.run" ? expandedSkill(call.args.skill) : [call];
    for (const step of steps) {
      if (!allowed.has(step.tool)) return fail("plan_invalid", `nextAllowed forbids expanded ${step.tool}`);
      if (step.tool === "render.animation" || step.tool === "render.matte") {
        const { width, height, frameStart, frameEnd } = step.args;
        if ((width !== undefined && width % 2 !== 0) || (height !== undefined && height % 2 !== 0)) return fail("plan_invalid", "animation dimensions must be even");
        if (frameStart !== undefined && frameEnd !== undefined && frameEnd < frameStart) return fail("plan_invalid", "frameEnd precedes frameStart");
      }
      expanded.push(AuthoringToolCallSchema.parse(step));
      if (expanded.length > 128) return fail("plan_invalid", "expanded plan exceeds 128 calls");
    }
  }
  return { ok: true, playbookId: book.id, calls: expanded };
}

/** The executor is a batch boundary: malformed plans cannot partially mutate Blender. */
export async function executePlan<T extends { ok: boolean }>(
  raw: string,
  context: PlanContext,
  executor: (calls: readonly ValidatedToolCall[]) => Promise<T>,
): Promise<PlanFailure | { ok: true; playbookId: string; executorCalls: 1; result: T }
  | { ok: false; status: "FAIL"; error: "executor_failed"; detail: string; executorCalls: 1 }> {
  const plan = validatePlan(raw, context);
  if (!plan.ok) return plan;
  try {
    const result = await executor(plan.calls);
    if (!result.ok) return { ok: false, status: "FAIL", error: "executor_failed", detail: "executor rejected the validated batch", executorCalls: 1 };
    return { ok: true, playbookId: plan.playbookId, executorCalls: 1, result };
  } catch (error) {
    return { ok: false, status: "FAIL", error: "executor_failed", detail: error instanceof Error ? error.message : "executor failed", executorCalls: 1 };
  }
}
