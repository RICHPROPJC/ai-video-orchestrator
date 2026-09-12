import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import * as nodeTest from "node:test";
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

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

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

/** Injected fetch with per-call HTTP status; 200 bodies carry one message content. */
function seqFetch(calls: { status: number; content?: string }[]) {
  const sent: Record<string, unknown>[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const c = calls[Math.min(sent.length - 1, calls.length - 1)]!;
    const content = c.content ?? "{}";
    return c.status === 200
      ? new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: "" } }] }), { status: 200 })
      : new Response("rate limited", { status: c.status });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

/** Records every wait instead of sleeping. */
function fakeClock() {
  const slept: number[] = [];
  return { slept, sleepImpl: async (ms: number) => { slept.push(ms); } };
}

function call(opts: {
  model?: string;
  replies: string[];
  dir: string;
  crewCfg?: CrewConfig;
  fetchImpl?: typeof fetch;
  sleepImpl?: (ms: number) => Promise<void>;
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
    sleepImpl: opts.sleepImpl,
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

test("deterministic repairs land on the attempt receipt as repair: lines", async () => {
  const dir = tmpDir();
  const { impl } = fakeFetch([JSON.stringify({ title: "門", beats: ["a", "b"], lang: "zh" })]);
  const out = await chatJson({
    seat: "writer",
    unit: "outline",
    model: "kimi-k3",
    crew,
    system: "編劇",
    user: "{}",
    schema,
    receiptDir: dir,
    fetchImpl: impl,
    normalize: (raw, note) => {
      note(`repair: lang saw "zh" became "zh-Hant"`);
      note(`mood saw 冷峻 became 冷`); // prefix is stamped on, never trusted
      return raw;
    },
  });
  assert.equal(out.value.title, "門");
  const receipt = JSON.parse(fs.readFileSync(path.join(dir, "writer.outline.1.json"), "utf8")) as CrewReceipt;
  assert.deepEqual(receipt.repairs, [
    'repair: lang saw "zh" became "zh-Hant"',
    "repair: mood saw 冷峻 became 冷",
  ]);
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
  // repair-prompt, not a re-roll: the zod path and a slice of its own last output
  assert.match(retryTurns[3]!.content, /beats/);
  assert.match(retryTurns[3]!.content, /門/);
  assert.ok(retryTurns[3]!.content.length <= 800);

  const first = JSON.parse(fs.readFileSync(path.join(dir, "writer.outline.1.json"), "utf8")) as CrewReceipt;
  assert.equal(first.valid, false);
  assert.match(first.errors.join(" "), /beats/);
  assert.deepEqual(first.repairs, []);
});

test("three bad attempts throw and leave three receipts", async () => {
  const dir = tmpDir();
  const bad = JSON.stringify({ thinking: "短。" });
  const { impl, sent } = fakeFetch([bad, bad, bad, bad]);
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
  // long enough not to be junk: a keyless-enough object that reaches the
  // schema lane still burns an attempt and gets the empty-json repair-prompt
  const longEmpty = JSON.stringify({ notes: "x".repeat(130) });
  const { impl, sent } = fakeFetch([
    longEmpty,
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

test("SC02 grave: the junk object { \",\": \"error\" } does not burn attempt 1", async () => {
  const dir = tmpDir();
  const boardsSchema = z.object({
    sceneId: z.string(),
    shots: z.array(z.object({ durationSec: z.number() })).min(1),
  });
  const { impl, sent } = fakeFetch([
    '{",":"error"}',
    JSON.stringify({ sceneId: "SC02", shots: [{ durationSec: 6 }] }),
  ]);
  const clock = fakeClock();
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
    sleepImpl: clock.sleepImpl,
  });

  // junk re-asked, not counted: the good reply is still attempt 1
  assert.equal(sent.length, 2);
  assert.deepEqual(out.receipts, ["boards.SC02.1.json"]);
  assert.deepEqual(clock.slept, [5000]);
});

test("junk passes are free even with fetchImpl set: attempts still reach three", async () => {
  const dir = tmpDir();
  const bad = JSON.stringify({ thinking: "短。" });
  const { impl, sent } = fakeFetch([
    "{}",
    '{",":"error"}',
    bad,
    JSON.stringify({ title: "門", beats: ["a", "b"] }),
  ]);
  const clock = fakeClock();
  const out = await call({ replies: [], dir, fetchImpl: impl, sleepImpl: clock.sleepImpl });

  assert.deepEqual(out.receipts, ["writer.outline.1.json", "writer.outline.2.json"]);
  assert.equal(sent.length, 4);
  assert.deepEqual(clock.slept, [5000, 5000]);
});

test("unparseable / junk-only lane stops at the 5-call ceiling and burns nothing", async () => {
  const dir = tmpDir();
  const { impl, sent } = fakeFetch(["講嘢，唔係 JSON", "{}", '{",":"error"}', "[]", " 又唔係 "]);
  const clock = fakeClock();
  await assert.rejects(
    () => call({ replies: [], dir, fetchImpl: impl, sleepImpl: clock.sleepImpl }),
    /5-call ceiling/,
  );
  assert.equal(sent.length, 5);
  assert.deepEqual(fs.readdirSync(dir), [], "junk leaves no attempt receipts");
  assert.deepEqual(clock.slept, [5000, 5000, 5000, 5000]);
});

test("schema retry feedback is capped at six lines and 800 chars", async () => {
  const dir = tmpDir();
  const manyIssues = z.object({ a: z.string(), b: z.string(), c: z.string(), d: z.string(), e: z.string(), f: z.string(), g: z.string() });
  const { impl, sent } = fakeFetch([
    JSON.stringify({ thinking: "七項。", a: 1 }),
    JSON.stringify({ thinking: "改好。", a: "x", b: "x", c: "x", d: "x", e: "x", f: "x", g: "x" }),
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

test("HTTP 429 backs off 20s/40s/80s then throws with the status intact", async () => {
  const { impl, sent } = seqFetch([{ status: 429 }, { status: 429 }, { status: 429 }, { status: 429 }]);
  const clock = fakeClock();
  await assert.rejects(
    () => call({ replies: [], dir: tmpDir(), fetchImpl: impl, sleepImpl: clock.sleepImpl }),
    /HTTP 429/,
  );
  assert.equal(sent.length, 4);
  assert.deepEqual(clock.slept, [20_000, 40_000, 80_000]);
});

test("HTTP 429 then 200 recovers after exactly one 20s backoff", async () => {
  const ok = JSON.stringify({ title: "門", beats: ["a", "b"] });
  const { impl, sent } = seqFetch([{ status: 429 }, { status: 200, content: ok }]);
  const clock = fakeClock();
  const out = await call({ replies: [], dir: tmpDir(), fetchImpl: impl, sleepImpl: clock.sleepImpl });
  assert.deepEqual(out.value, { title: "門", beats: ["a", "b"] });
  assert.equal(sent.length, 2);
  assert.deepEqual(clock.slept, [20_000]);
});

test("non-429 HTTP errors stay immediate: no backoff sleep at all", async () => {
  const bad = (async () => new Response("upstream boom", { status: 502 })) as unknown as typeof fetch;
  const clock = fakeClock();
  await assert.rejects(
    () => call({ replies: [], dir: tmpDir(), fetchImpl: bad, sleepImpl: clock.sleepImpl }),
    /HTTP 502/,
  );
  assert.deepEqual(clock.slept, []);
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
