import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import {
  chatJson,
  DEFAULT_CREW,
  extractJsonObject,
  modelQuirks,
  resolveCrewEndpoint,
  stripThink,
  type CrewConfig,
  type CrewReceipt,
} from "./crew-llm";

const schema = z.object({ title: z.string(), beats: z.array(z.string()).min(2) });

const crew: CrewConfig = { ...DEFAULT_CREW, endpoint: "http://crew.invalid:4000" };

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "crew-llm-"));
}

/** Injected fetch: replies in order, records every request body. No socket. */
function fakeFetch(replies: string[]) {
  const sent: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const content = replies[sent.length - 1] ?? "";
    return new Response(
      JSON.stringify({ choices: [{ message: { content, reasoning_content: "諗咗" } }] }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, sent };
}

function call(opts: {
  model?: string;
  replies: string[];
  dir: string;
  crewCfg?: CrewConfig;
  fetchImpl?: typeof fetch;
}) {
  return chatJson({
    seat: "writer",
    unit: "outline",
    model: opts.model ?? "kimi-k3",
    crew: opts.crewCfg ?? crew,
    system: "你係編劇檯。",
    user: "{\"brief\":\"x\"}",
    schema,
    receiptDir: opts.dir,
    fetchImpl: opts.fetchImpl,
  });
}

test("stripThink drops a leaked leading think block", () => {
  assert.equal(stripThink("<think>諗緊</think>\n{\"a\":1}"), '{"a":1}');
  assert.equal(stripThink('{"a":1}'), '{"a":1}');
});

test("extractJsonObject survives fences and preambles", () => {
  assert.equal(extractJsonObject('```json\n{"a":1}\n```'), '{"a":1}');
  assert.equal(extractJsonObject('<think>x</think>好：{"a":1}'), '{"a":1}');
  assert.throws(() => extractJsonObject("冇 JSON"), /no JSON object/);
});

test("model quirks: kimi-k3 temperature 1, qwen thinking off, others bare", () => {
  assert.deepEqual(modelQuirks("kimi-k3"), { temperature: 1 });
  assert.deepEqual(modelQuirks("qwen3.6-35b"), { chat_template_kwargs: { enable_thinking: false } });
  assert.deepEqual(modelQuirks("deepseek-v4-flash-sensenova"), {});
});

test("CREW_LLM_URL overrides the config endpoint and trailing slash goes", () => {
  assert.equal(resolveCrewEndpoint({ ...crew, endpoint: "http://a:4000/" }), "http://a:4000");
  process.env.CREW_LLM_URL = "http://override:4000/";
  try {
    assert.equal(resolveCrewEndpoint(crew), "http://override:4000");
  } finally {
    delete process.env.CREW_LLM_URL;
  }
});

test("default deny holds glm-5.3 and the defaults are not GLM", () => {
  assert.deepEqual(DEFAULT_CREW.deny, ["glm-5.3"]);
  assert.equal(DEFAULT_CREW.endpoint, "");
  for (const m of [DEFAULT_CREW.writerModel, DEFAULT_CREW.boardsModel]) {
    assert.ok(!/glm/i.test(m), `${m} must not be a GLM model`);
  }
});

test("unset endpoint fails loud before any request", async () => {
  const { impl, sent } = fakeFetch([]);
  await assert.rejects(
    () => call({ replies: [], dir: tmpDir(), crewCfg: { ...crew, endpoint: "" }, fetchImpl: impl }),
    /crew\.endpoint unset/,
  );
  assert.equal(sent.length, 0);
});

test("a denied model is refused before any request", async () => {
  const { impl, sent } = fakeFetch(["{}"]);
  await assert.rejects(
    () => call({ model: "glm-5.3", replies: [], dir: tmpDir(), fetchImpl: impl }),
    /refused model glm-5\.3: listed in crew\.deny/,
  );
  assert.equal(sent.length, 0);
});

test("first-pass success: quirks on the wire, JSON mode, one receipt", async () => {
  const dir = tmpDir();
  const { impl, sent } = fakeFetch([JSON.stringify({ title: "門", beats: ["a", "b"] })]);
  const out = await call({ replies: [], dir, fetchImpl: impl });

  assert.deepEqual(out.value, { title: "門", beats: ["a", "b"] });
  assert.deepEqual(out.receipts, ["writer.outline.1.json"]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.temperature, 1);
  assert.deepEqual(sent[0]!.response_format, { type: "json_object" });
  assert.equal((sent[0]!.messages as { role: string }[])[0]!.role, "system");

  const receipt = JSON.parse(fs.readFileSync(path.join(dir, "writer.outline.1.json"), "utf8")) as CrewReceipt;
  assert.equal(receipt.tool, "slatecrew.crew_llm");
  assert.equal(receipt.seat, "writer");
  assert.equal(receipt.unit, "outline");
  assert.equal(receipt.model, "kimi-k3");
  assert.equal(receipt.attempt, 1);
  assert.equal(receipt.valid, true);
  assert.equal(receipt.reasoning, "諗咗");
  assert.deepEqual(receipt.errors, []);
  assert.equal(receipt.messages.length, 2);
});

test("schema failure feeds the validator's errors back and recovers", async () => {
  const dir = tmpDir();
  const { impl, sent } = fakeFetch([
    JSON.stringify({ title: "門", beats: ["only-one"] }),
    JSON.stringify({ title: "門", beats: ["a", "b"] }),
  ]);
  const out = await call({ replies: [], dir, fetchImpl: impl });

  assert.deepEqual(out.receipts, ["writer.outline.1.json", "writer.outline.2.json"]);
  assert.equal(sent.length, 2);
  const retryTurns = sent[1]!.messages as { role: string; content: string }[];
  assert.equal(retryTurns.length, 4);
  assert.equal(retryTurns[2]!.role, "assistant");
  assert.match(retryTurns[3]!.content, /beats/);

  const first = JSON.parse(fs.readFileSync(path.join(dir, "writer.outline.1.json"), "utf8")) as CrewReceipt;
  assert.equal(first.valid, false);
  assert.match(first.errors.join(" "), /beats/);
});

test("three bad attempts throw and leave three receipts", async () => {
  const dir = tmpDir();
  const { impl, sent } = fakeFetch(["{}", "{}", "{}", "{}"]);
  await assert.rejects(
    () => call({ replies: [], dir, fetchImpl: impl }),
    /seat writer could not produce valid outline after 3 attempts/,
  );
  assert.equal(sent.length, 3);
  assert.deepEqual(fs.readdirSync(dir).sort(), [
    "writer.outline.1.json",
    "writer.outline.2.json",
    "writer.outline.3.json",
  ]);
});

test("empty-key boards reply yields one empty-json error and a short retry", async () => {
  const dir = tmpDir();
  const boardsSchema = z.object({
    sceneId: z.string(),
    shots: z.array(z.object({ durationSec: z.number() })).min(1),
  });
  const { impl, sent } = fakeFetch([
    '{"":""}',
    JSON.stringify({ sceneId: "SC02", shots: [{ durationSec: 6 }] }),
  ]);
  const out = await chatJson({
    seat: "boards",
    unit: "SC02",
    model: "qwen3.6-35b",
    crew,
    system: "分鏡",
    user: "{}",
    schema: boardsSchema,
    receiptDir: dir,
    fetchImpl: impl,
  });

  assert.deepEqual(out.value, { sceneId: "SC02", shots: [{ durationSec: 6 }] });
  const first = JSON.parse(fs.readFileSync(path.join(dir, "boards.SC02.1.json"), "utf8")) as CrewReceipt;
  assert.deepEqual(first.errors, ["empty json"]);
  const retryTurns = sent[1]!.messages as { role: string; content: string }[];
  assert.match(retryTurns[3]!.content, /empty json/);
  assert.ok(retryTurns[3]!.content.length <= 800);
});

test("schema retry feedback is capped at six lines and 800 chars", async () => {
  const dir = tmpDir();
  const manyIssues = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string(), g: z.string() });
  const { impl, sent } = fakeFetch([
    JSON.stringify({ a: 1 }),
    JSON.stringify({ a: "x", b: "x", c: "x", d: "x", e: "x", f: "x", g: "x" }),
  ]);
  await chatJson({
    seat: "writer",
    unit: "outline",
    model: "kimi-k3",
    crew,
    system: "編劇",
    user: "{}",
    schema: manyIssues,
    receiptDir: dir,
    fetchImpl: impl,
  });
  const retry = (sent[1]!.messages as { content: string }[])[3]!.content;
  const bulletLines = retry.split("\n").filter((l) => l.startsWith("- "));
  assert.ok(bulletLines.length <= 6);
  assert.ok(retry.length <= 800);
});

test("a leaked <think> block still parses, and HTTP errors fail loud", async () => {
  const dir = tmpDir();
  const { impl } = fakeFetch([`<think>唔應該出街</think>${JSON.stringify({ title: "t", beats: ["a", "b"] })}`]);
  const out = await call({ model: "qwen3.6-35b", replies: [], dir, fetchImpl: impl });
  assert.equal(out.value.title, "t");

  const bad = (async () => new Response("upstream boom", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(() => call({ replies: [], dir: tmpDir(), fetchImpl: bad }), /HTTP 502/);
});
