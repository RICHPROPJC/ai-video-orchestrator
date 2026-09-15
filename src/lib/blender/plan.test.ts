import assert from "node:assert/strict";
import test from "node:test";
import { GET } from "../../app/spec/route";
import { TOOL_CATALOG } from "./catalog";
import { executePlan, validatePlan } from "./plan";
import { getSpec, selectPlaybook, AuthoringToolCallSchema, ToolCallSchema, type PlanContext } from "./spec";
import skills from "./skills.json";
import malformed from "../../../shots/fixtures/f4/malformed.json";

const context: PlanContext = { intent: "plaza", nextAllowed: TOOL_CATALOG.map((entry) => entry.name) };
const plan = (calls: unknown[], extra = {}) => JSON.stringify({ playbookId: "pb.plaza.v2", calls, ...extra });

for (const fixture of malformed) {
  test(`malformed plan never calls executor: ${fixture.id}`, async () => {
    let calls = 0;
    const result = await executePlan(fixture.raw, { ...context, ...fixture.context } as PlanContext, async () => { calls++; return { ok: true }; });
    assert.equal(calls, 0);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, fixture.error);
  });
}

test("GET /spec exposes the same strict Zod schemas used by validation", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /application\/json/);
  const spec = await response.json();
  assert.equal(spec.planSchema.additionalProperties, false);
  const variants = spec.planSchema.properties.calls.items.oneOf ?? spec.planSchema.properties.calls.items.anyOf;
  assert.deepEqual(variants.map((schema: { properties: { tool: { const: string } } }) => schema.properties.tool.const).sort(), spec.tools.map((t: { name: string }) => t.name).sort());
  for (const schema of variants) {
    assert.equal(schema.additionalProperties, false);
    assert.equal(schema.properties.args.additionalProperties, false);
  }
});

test("frozen skills expand only to schema-valid typed calls", () => {
  for (const calls of Object.values(skills)) for (const call of calls) assert.equal(AuthoringToolCallSchema.safeParse(call).success, true, JSON.stringify(call));
  const result = validatePlan(plan([{ tool: "skill.run", args: { skill: "studio_soft" } }]), context);
  assert.equal(result.ok, true);
  if (result.ok) assert.deepEqual(result.calls, skills.studio_soft);
});

test("unknown intent has no substring or compiler fallback", () => {
  assert.equal(selectPlaybook("  PLAZA  ")?.id, "pb.plaza.v2");
  assert.equal(selectPlaybook("invent a dragon plaza"), null);
  const refusal = validatePlan('{"error":"no_playbook"}', context);
  assert.equal(refusal.ok, false);
  if (!refusal.ok) assert.equal(refusal.error, "no_playbook");
});

test("model cannot grant nextAllowed or supply executable/path escape arguments", () => {
  const cases = [
    plan([{ tool: "scene.clear", args: {} }], { nextAllowed: ["scene.clear"] }),
    plan([{ tool: "render.frame", args: { path: "shots/../escape.png" } }]),
    plan([{ tool: "render.frame", args: { path: "/tmp/escape.png" } }]),
    plan([{ tool: "skill.run", args: { skill: "invented_skill" } }]),
    plan([{ tool: "render.animation", args: { path: "shots/test.mp4", width: 319 } }]),
    plan([{ tool: "render.animation", args: { path: "shots/test.mp4", frameStart: 8, frameEnd: 2 } }]),
    "```json\n" + plan([{ tool: "scene.clear", args: {} }]) + "\n```",
  ];
  for (const raw of cases) assert.equal(validatePlan(raw, context).ok, false, raw);
  assert.equal(validatePlan(plan([{ tool: "scene.clear", args: {} }]), { ...context, nextAllowed: [] }).ok, false);
});

test("executor errors do not become successful plan results", async () => {
  const raw = plan([{ tool: "scene.clear", args: {} }]);
  for (const executor of [async () => ({ ok: false }), async () => { throw new Error("camera failed"); }]) {
    const result = await executePlan(raw, context, executor);
    assert.equal(result.ok, false);
    assert.equal(result.executorCalls, 1);
    if (!result.ok) assert.equal(result.error, "executor_failed");
  }
});

test("mutating a returned spec cannot change the validator vocabulary", () => {
  const spec = getSpec();
  spec.playbooks[0].intents.push("invented");
  assert.equal(selectPlaybook("invented"), null);
});


test("raw model coordinates are forbidden even when trusted context allows the authoring capability", () => {
  for (const call of [
    { tool: "object.create", args: { location: [1, 2, 3] } },
    { tool: "camera.create", args: { location: [1, 2, 3], lookAt: [0, 0, 0] } },
    { tool: "character.spawn", args: { name: "Hero", location: [1, 2, 3] } },
    { tool: "character.move", args: { name: "Hero", location: [1, 2, 3] } },
  ]) assert.equal(validatePlan(plan([call]), context).ok, false);
  assert.equal(ToolCallSchema.safeParse({ tool: "object.place_beside", args: { name: "Extra", reference: "Hero", gap: 0.8 } }).success, true);
});
