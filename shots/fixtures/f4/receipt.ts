import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { GET } from "../../../src/app/spec/route";
import { TOOL_CATALOG } from "../../../src/lib/blender/catalog";
import { executePlan } from "../../../src/lib/blender/plan";
import type { PlanContext, ValidatedToolCall } from "../../../src/lib/blender/spec";

async function main() {
const root = process.cwd();
const out = path.join(root, "shots/fixtures/f4");
const fixtures = JSON.parse(await readFile(path.join(out, "malformed.json"), "utf8")) as {
  id: string; raw: string; error: string; context?: Partial<PlanContext>;
}[];
const context: PlanContext = { intent: "plaza", nextAllowed: TOOL_CATALOG.map((entry) => entry.name) };
let executorCalls = 0;
let blenderProcesses = 0;
const dispatch = async (calls: readonly ValidatedToolCall[]) => {
  executorCalls++;
  const callsPath = path.join(out, "valid-calls.json");
  const receiptPath = path.join(out, "headless.json");
  await writeFile(callsPath, JSON.stringify(calls, null, 2) + "\n");
  blenderProcesses++;
  const { stdout, stderr } = await promisify(execFile)(process.env.FORGE_BLENDER ?? "blender", [
    "-b", "-t", "2", "--python-exit-code", "1", "-P", path.join(out, "headless.py"), "--", callsPath, receiptPath,
  ], { cwd: root, env: { ...process.env, LIBGL_ALWAYS_SOFTWARE: "1", GALLIUM_DRIVER: "llvmpipe" }, maxBuffer: 4 * 1024 * 1024 });
  await writeFile(path.join(out, "headless.log"), stdout + stderr);
  return JSON.parse(await readFile(receiptPath, "utf8")) as { ok: boolean; blender: string; bpyCalls: number };
};
const malformed = [];
for (const fixture of fixtures) {
  const result = await executePlan(fixture.raw, { ...context, ...fixture.context }, dispatch);
  assert.equal(result.ok, false, fixture.id);
  assert.equal(result.executorCalls, 0, fixture.id);
  if (result.ok) throw new Error("malformed plan passed");
  assert.equal(result.error, fixture.error, fixture.id);
  malformed.push({ id: fixture.id, ...result });
}
assert.equal(fixtures.length, 10);
assert.equal(executorCalls, 0);
assert.equal(blenderProcesses, 0);
const rejectedSummary = { count: malformed.length, executorCalls, blenderProcesses, bpyCalls: 0, verdict: "PASS", cases: malformed };
// A real positive control proves that the dispatcher isn't just a no-op stub.
const calls: ValidatedToolCall[] = [
  { tool: "scene.clear", args: {} },
  { tool: "character.spawn", args: { name: "Hero", role: "hero" } },
  { tool: "camera.frame", args: { follow: "Hero" } },
  { tool: "render.animation", args: { path: "shots/fixtures/f4/blockout.mp4", width: 320, height: 180, frameStart: 1, frameEnd: 3, fps: 6 } },
];
const valid = await executePlan(JSON.stringify({ playbookId: "pb.plaza.v2", calls }), context, dispatch);
assert.equal(valid.ok, true, JSON.stringify(valid));
assert.equal(executorCalls, 1);
assert.equal(blenderProcesses, 1);
const response = GET();
assert.equal(response.status, 200);
const spec = await response.json();
assert.ok(spec.tools.length < TOOL_CATALOG.length);
await writeFile(path.join(out, "spec.json"), JSON.stringify(spec, null, 2) + "\n");
const artifacts: Record<string, string> = {};
for (const name of ["malformed.json", "spec.json", "valid-calls.json", "headless.json", "blockout.mp4", "blockout.camera/observation.json", "blockout.camera/frame.png", "blockout.camera/hero-mask.png"]) {
  artifacts[name] = createHash("sha256").update(await readFile(path.join(out, name))).digest("hex");
}
await writeFile(path.join(out, "qc.json"), JSON.stringify({ verdict: "PASS", malformed: rejectedSummary, positiveControl: valid, artifacts, event_id: null, trace_id: null }, null, 2) + "\n");
console.log("PASS: 10 malformed plans FAIL; 0 executor calls / Blender processes / bpy calls. Positive control: 1 real Blender batch.");

}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
