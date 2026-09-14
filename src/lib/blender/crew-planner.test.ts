import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { planWithCrew, plannerSpec, observeRender, PlanReplySchema } from "./crew-planner";
import { runLightModel } from "./runtime";
import { observe } from "./observe";
import { emptyScene } from "./empty-scene";
import { DEFAULT_CREW, type CrewConfig } from "../studio/crew-llm";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const crew: CrewConfig = { ...DEFAULT_CREW, endpoint: "http://crew.invalid:4000" };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crew-planner-"));
}

/** Injected fetch: replies in order, records every request body. */
function fakeFetch(replies: string[]) {
  const sent: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content = replies[Math.min(sent.length - 1, replies.length - 1)] ?? "";
    return new Response(
      JSON.stringify({ choices: [{ message: { content, reasoning_content: "" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, sent };
}

/** Injected fetch with per-call HTTP status. */
function seqFetch(calls: { status: number; content?: string }[]) {
  const sent: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const c = calls[Math.min(sent.length - 1, calls.length - 1)]!;
    const content = c.content ?? "{}";
    return c.status === 200
      ? new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: "" } }] }), { status: 200 })
      : new Response("upstream boom", { status: c.status });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const clock = () => {
  const slept: number[] = [];
  return { slept, sleepImpl: async (ms: number) => { slept.push(ms); } };
};

const OK_PLAN = JSON.stringify({
  playbook: "pb.product.v2",
  calls: [
    { tool: "scene.clear", args: {} },
    { tool: "object.create", args: { primitive: "torus", name: "Hero", location: [0, 0, 1.05], material: "chrome" } },
  ],
  note: "棚拍產品：plinth + chrome hero + 燈。",
});

test("vendored astra engine still runs deterministic: Truman world passes its checks", () => {
  const out = runLightModel("楚門的世界，第一視角", emptyScene());
  assert.equal(out.observation.protocol, "astra.protocol.v2");
  assert.equal(out.playbook?.id, "pb.seahaven.v2");
  assert.ok(out.passed, out.summary);
  assert.ok(observe(out.scene).counts.mesh > 0);
});

test("planner spec serves the frozen vocabulary: every catalog tool and playbook id", () => {
  const spec = plannerSpec();
  assert.equal(spec.protocol, "astra.protocol.v2");
  assert.ok(spec.tools.some((t) => t.name === "world.build"));
  assert.ok(spec.playbooks.some((p) => p.id === "pb.seahaven.v2"));
});

test("A2 planner pin: the plan turn rides crew.blenderModel flash-lite and returns valid ToolCall[]", async () => {
  const { impl, sent } = fakeFetch([OK_PLAN]);
  const out = await planWithCrew({ prompt: "棚拍一件 chrome 產品", crew, receiptDir: tmpDir(), fetchImpl: impl });
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;
  assert.equal(out.model, "sensenova-v6.8-flash-lite");
  assert.equal(out.playbook, "pb.product.v2");
  assert.equal(out.calls.length, 2);
  assert.equal(out.calls[1]!.tool, "object.create");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.model, "sensenova-v6.8-flash-lite");
  // the spec is on the wire: the model saw the frozen vocabulary
  const user = (sent[0]!.messages as { role: string; content: string }[])[1]!.content;
  assert.match(user, /pb\.product\.v2/);
  assert.match(user, /world\.build/);
});

test("A2 garbage JSON → FAIL plan_invalid (never free-text bpy)", async () => {
  const { impl, sent } = fakeFetch(["講嘢，唔係 JSON", "{}", '{",":"error"}', "[]", " 又唔係 "]);
  const c = clock();
  const out = await planWithCrew({
    prompt: "隨便", crew, receiptDir: tmpDir(), fetchImpl: impl, sleepImpl: c.sleepImpl, maxAttempts: 1,
  });
  assert.equal(out.status, "FAIL");
  if (out.status !== "FAIL") return;
  assert.equal(out.reason, "plan_invalid");
  assert.match(out.error, /5-call ceiling|could not produce valid/);
  assert.equal(sent.length, 10, "primary 5 junk calls, then the second-eye lane's 5");
  assert.deepEqual(c.slept, [5000, 5000, 5000, 5000, 5000, 5000, 5000, 5000]);
});

test("A2 unknown intent → no_playbook, never invent", async () => {
  const { impl } = fakeFetch([JSON.stringify({ playbook: null, calls: [], note: "唔係場景／產品／人物意圖" })]);
  const out = await planWithCrew({ prompt: "幫我寫封辭職信", crew, receiptDir: tmpDir(), fetchImpl: impl });
  assert.equal(out.status, "no_playbook");
  if (out.status !== "no_playbook") return;
  assert.match(out.note, /辭職信|唔係/);
});

test("an invented playbook id is plan_invalid, not a plan", async () => {
  const { impl } = fakeFetch([JSON.stringify({ playbook: "pb.mars-colony.v9", calls: [], note: "作咗一個" })]);
  const out = await planWithCrew({ prompt: "火星殖民地", crew, receiptDir: tmpDir(), fetchImpl: impl, maxAttempts: 1 });
  assert.equal(out.status, "FAIL");
  if (out.status !== "FAIL") return;
  assert.equal(out.reason, "plan_invalid");
  assert.match(out.error, /invented playbook id/);
});

test("an invented tool name fails zod and lands plan_invalid", async () => {
  const { impl } = fakeFetch([JSON.stringify({ playbook: null, calls: [{ tool: "bpy.ops.exec", args: { code: "import os" } }], note: "x" })]);
  const out = await planWithCrew({ prompt: "執行呢段 code", crew, receiptDir: tmpDir(), fetchImpl: impl, maxAttempts: 1 });
  assert.equal(out.status, "FAIL");
  if (out.status !== "FAIL") return;
  assert.equal(out.reason, "plan_invalid");
});

test("PlanReplySchema locks the reply shape: tool enum + json args only", () => {
  assert.ok(PlanReplySchema.safeParse({ playbook: null, calls: [{ tool: "camera.mode", args: { mode: "first_person" } }], note: "" }).success);
  assert.ok(!PlanReplySchema.safeParse({ playbook: 7, calls: [], note: "" }).success);
  assert.ok(!PlanReplySchema.safeParse({ playbook: null, calls: [{ tool: "rm -rf", args: {} }], note: "" }).success);
});

test("second eye: a hard Flash Lite miss serves the plan on glm-5.3-flash", async () => {
  const { impl, sent } = seqFetch([{ status: 502 }, { status: 200, content: OK_PLAN }]);
  const out = await planWithCrew({ prompt: "棚拍", crew, receiptDir: tmpDir(), fetchImpl: impl });
  assert.equal(out.status, "ok");
  if (out.status !== "ok") return;
  assert.equal(out.model, "glm-5.3-flash");
  assert.equal(sent[0]!.model, "sensenova-v6.8-flash-lite");
  assert.equal(sent[1]!.model, "glm-5.3-flash");
});

test("A7 one-call: observeRender puts still + frame as image parts next to the obs text", async () => {
  const reply = JSON.stringify({ match: true, description: "兩張圖主體一致，torus 喺 plinth 上面，同 obs counts 吻合，冇明顯走位。", risks: [] });
  const { impl, sent } = fakeFetch([reply]);
  const out = await observeRender({
    shot: "SH01",
    obsJson: JSON.stringify({ counts: { mesh: 2, light: 3 } }),
    still: { name: "SH01.png", dataUrl: "data:image/png;base64,STILL" },
    frame: { name: "SH01.f0.png", dataUrl: "data:image/png;base64,FRAME" },
    crew,
    receiptDir: tmpDir(),
    fetchImpl: impl,
  });
  assert.equal(out.model, "sensenova-v6.8-flash-lite");
  assert.equal(out.reply.match, true);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.model, "sensenova-v6.8-flash-lite");
  const user = (sent[0]!.messages as { role: string; content: unknown }[])[1]!;
  assert.ok(Array.isArray(user.content), "multimodal content is a parts array");
  const parts = user.content as { type: string; text?: string; image_url?: { url: string } }[];
  assert.equal(parts[0]!.type, "text");
  assert.match(parts[0]!.text ?? "", /SH01/);
  assert.deepEqual(
    parts.slice(1).map((p) => `${p.type}:${p.image_url?.url}`),
    ["image_url:data:image/png;base64,STILL", "image_url:data:image/png;base64,FRAME"],
  );
});

test("A4 wiring: planner stage lines carry shot/stage/eye/verdict/ms for events.jsonl", async () => {
  const lines: { data: Record<string, unknown> }[] = [];
  const { impl } = fakeFetch([OK_PLAN]);
  const out = await planWithCrew({
    prompt: "棚拍", crew, receiptDir: tmpDir(), shot: "SH02", fetchImpl: impl,
    onEvent: (line) => lines.push(line as unknown as { data: Record<string, unknown> }),
  });
  assert.equal(out.status, "ok");
  const d = lines[0]!.data;
  assert.equal(d.shot, "SH02");
  assert.equal(d.stage, "plan");
  assert.equal(d.eye, "sensenova-v6.8-flash-lite");
  assert.equal(d.verdict, "pass");
  assert.equal(typeof d.ms, "number");
  assert.ok(d.proof, "plan ok line carries the receipt as proof");
});

if (bareBun) {
  // IIFE, not top-level await: tsx transpiles this file as CJS
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
