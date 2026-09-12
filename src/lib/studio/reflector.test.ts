import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { DEFAULT_CREW, type CrewConfig } from "./crew-llm";
import { reflectorOpsSchema } from "./reflector";
import { collectSeatFailure, runReflector } from "./reflector";
import { loadPlaybook } from "./playbook";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const crew: CrewConfig = { ...DEFAULT_CREW, endpoint: "http://reflector.invalid:4000" };

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "reflector-"));
}

type Grave = {
  status?: string;
  error?: string;
  seats?: { name: string; seat: string; unit: string; attempt: number; valid: boolean; model?: string; errors?: string[]; repairs?: string[]; content?: string }[];
};

function graveJob(g: Grave): string {
  const dir = tmp();
  fs.mkdirSync(path.join(dir, "seats"), { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({
    id: path.basename(dir), slate: path.basename(dir),
    status: g.status ?? "failed", error: g.error ?? "seat boards could not produce valid SC02 after 3 attempts",
  }, null, 2));
  for (const s of g.seats ?? []) {
    fs.writeFileSync(path.join(dir, "seats", s.name), JSON.stringify({
      tool: "slatecrew.crew_llm", ts: "2026-09-12T00:00:00.000Z", endpoint: "http://reflector.invalid:4000",
      model: s.model ?? "qwen3.6-35b", messages: [], reasoning: "", elapsed_ms: 1, repairs: s.repairs ?? [],
      seat: s.seat, unit: s.unit, attempt: s.attempt, valid: s.valid,
      errors: s.errors ?? [], content: s.content ?? "{}",
    }, null, 2));
  }
  return dir;
}

function fetchReturning(content: string) {
  const sent: { model: string; system: string; user: string }[] = [];
  const impl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { model: string; messages: { role: string; content: string }[] };
    sent.push({
      model: body.model,
      system: body.messages.find((m) => m.role === "system")?.content ?? "",
      user: body.messages.find((m) => m.role === "user")?.content ?? "",
    });
    return new Response(JSON.stringify({ choices: [{ message: { content, reasoning_content: "" } }] }), { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, sent };
}

const SC02_GRAVE = {
  name: "boards.SC02.3.json",
  seat: "boards",
  unit: "SC02",
  attempt: 3,
  valid: false,
  errors: [
    "sceneId: Invalid input: expected string, received undefined",
    "shots: this scene must run 91.0–109.0s (budget 100.0s); your shots add up to 84.9s",
  ],
  content: '{"sceneId":"SC02","shots":[{"durationSec":8.5}]}',
};

test("collectSeatFailure reads the grave: failing seat, zod paths, output tail", () => {
  const dir = graveJob({
    seats: [
      SC02_GRAVE,
      { name: "boards.SC01.1.json", seat: "boards", unit: "SC01", attempt: 1, valid: true, content: "{}" },
    ],
  });
  const failure = collectSeatFailure(dir);
  assert.ok(failure, "failed job parses");
  assert.equal(failure!.seat, "boards");
  assert.equal(failure!.attempts.length, 1);
  assert.match(failure!.attempts[0]!.errors.join(" "), /sceneId/);
  assert.match(failure!.attempts[0]!.errors.join(" "), /84\.9s/);
  assert.match(failure!.attempts[0]!.contentSlice, /8\.5/);
  assert.match(failure!.context, /boards×2.*qwen3\.6-35b.*invalid 1/);
});

test("a both-seats grave follows the job error, not filename order: boards lessons never land in the writer file", () => {
  const dir = graveJob({
    error: "seat boards could not produce valid SC05 after 3 attempts",
    seats: [
      { name: "boards.SC05.3.json", seat: "boards", unit: "SC05", attempt: 3, valid: false, errors: ["shots: this scene must run 91.0–109.0s (budget 100.0s); your shots add up to 89.0s"] },
      // writer receipts sort AFTER boards filenames — the trap this test freezes
      { name: "writer.outline.1.json", seat: "writer", unit: "outline", attempt: 1, valid: false, errors: ["language: Invalid option"] },
    ],
  });
  const failure = collectSeatFailure(dir);
  assert.equal(failure!.seat, "boards", "the job error names boards");
  assert.equal(failure!.attempts.length, 1, "writer's earlier repaired fail is not boards' lesson");
  assert.equal(failure!.attempts[0]!.unit, "SC05");
  assert.match(failure!.context, /writer×1（qwen3\.6-35b，invalid 1）/, "both seats still visible for global lessons");
});

test("a 429 grave with no invalid receipt still names its seat from the error", () => {
  const dir = graveJob({
    error: "seat writer outline: http://127.0.0.1:4000 HTTP 429: litellm.RateLimitError",
    seats: [{ name: "writer.outline.1.json", seat: "writer", unit: "outline", attempt: 1, valid: true, content: "{}" }],
  });
  const failure = collectSeatFailure(dir);
  assert.equal(failure!.seat, "writer");
  assert.deepEqual(failure!.attempts, []);
  assert.match(failure!.jobError, /HTTP 429/);
});

test("Reflector refuses kimi, Flash and glm before any HTTP call", async () => {
  const dir = graveJob({ seats: [SC02_GRAVE] });
  const books = tmp();
  const { impl, sent } = fetchReturning('{"thinking":"x","ops":[]}');
  for (const model of ["kimi-k3", "glm-5.3-flash", "qwen3.6-35b-flash"]) {
    await assert.rejects(
      () => runReflector({ jobId: "X", crew: { ...crew, boardsModel: model }, seatsDir: books, jobDir: dir, fetchImpl: impl }),
      /Reflector refuses model/,
    );
  }
  assert.equal(sent.length, 0, "no socket opened");
});

test("ops schema caps at three and demands single-token field/saw", () => {
  const op = { op: "ADD", to: "seat", class: "schema.enum", field: "cast.stanceEnd", saw: "plant", rule: "只可以 stand|lean|crouch" };
  assert.ok(reflectorOpsSchema.safeParse({ thinking: "推", ops: [op, op, op] }).success);
  assert.ok(!reflectorOpsSchema.safeParse({ thinking: "推", ops: [op, op, op, op] }).success, "4 ops rejected");
  assert.ok(!reflectorOpsSchema.safeParse({ thinking: "推", ops: [{ ...op, saw: "兩個 token" }] }).success, "saw with a space rejected");
  assert.ok(!reflectorOpsSchema.safeParse({ thinking: "推", ops: [{ ...op, field: "" }] }).success, "empty field rejected");
});

test("full loop on fake fetch: 27B ops land as trial bullets with real field/saw, global routes to global", async () => {
  const dir = graveJob({
    seats: [
      SC02_GRAVE,
      { name: "writer.outline.1.json", seat: "writer", unit: "outline", attempt: 1, valid: true, model: "kimi-k3", content: "{}" },
    ],
  });
  const books = tmp();
  // a pre-existing global bullet proves the prompt carried playbook ids for UPDATE
  fs.mkdirSync(books, { recursive: true });
  fs.writeFileSync(path.join(books, "global.playbook.md"),
    "# global playbook — 機器級教訓，全部 seat 共用（Curator 代碼寫；Chau 刪一行即否決）\n- [g1] machine.empty field=boardsModel saw=qwen3.6-35b rule=空 JSON 時隔 5s 重問 hits=1 status=trial src=SC-0912-YGTS\n");
  const reply = JSON.stringify({
    thinking: "SC02 attempt 3 冇 sceneId 同 sum 短：兩個 class。",
    ops: [
      { op: "UPDATE", to: "global", id: "g1", rule: "空 JSON 時隔 5s 重問，兩次都空就停" },
      { op: "ADD", to: "seat", class: "arithmetic.sum", field: "shots.durationSec", saw: "84.9s", rule: "budget 均分 base，交前逐鏈加總到 91–109s" },
      { op: "ADD", to: "global", class: "machine.429", field: "writerModel", saw: "kimi-k3", rule: "kimi TPM 窄，stage 之間唞 5s" },
    ],
  });
  const { impl, sent } = fetchReturning(reply);

  const lines = await runReflector({ jobId: "SC-0912-YGTS", crew, seatsDir: books, jobDir: dir, fetchImpl: impl });

  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.model, "qwen3.6-35b", "27B via crew.boardsModel");
  assert.match(sent[0]!.system, /場外/);
  assert.match(sent[0]!.user, /sceneId: Invalid input/);
  assert.match(sent[0]!.user, /84\.9s/);
  assert.match(sent[0]!.user, /g1/, "current playbook ids travel with the prompt");

  const boards = loadPlaybook("boards", books);
  assert.equal(boards.length, 1);
  assert.equal(boards[0]!.field, "shots.durationSec");
  assert.equal(boards[0]!.saw, "84.9s");
  assert.equal(boards[0]!.status, "trial", "new bullets ship as trial");
  assert.equal(boards[0]!.src, "SC-0912-YGTS");
  const global = loadPlaybook("global", books);
  assert.equal(global.length, 2);
  assert.match(global.find((b) => b.id === "g1")!.rule, /兩次都空就停/, "UPDATE landed");
  assert.equal(global.find((b) => b.id === "g2")!.field, "writerModel");
  assert.ok(lines.some((l) => /ADD b1/.test(l)), lines.join(" | "));
  assert.ok(lines.some((l) => /UPDATE g1/.test(l)), lines.join(" | "));
  // the reflector's own receipt is in the job's seats dir
  assert.ok(fs.existsSync(path.join(dir, "seats", "reflector.SC-0912-YGTS.1.json")));
});

test("empty ops reply is a real attempt, not junk: nothing written, no re-ask", async () => {
  const dir = graveJob({ seats: [SC02_GRAVE] });
  const books = tmp();
  const { impl, sent } = fetchReturning('{"thinking":"冇嘢好學。","ops":[]}');
  const lines = await runReflector({ jobId: "SC-0912-9KM0", crew, seatsDir: books, jobDir: dir, fetchImpl: impl });
  assert.equal(sent.length, 1, '{"ops":[]} is 20 chars — the ops key keeps it off the junk lane');
  assert.deepEqual(lines, []);
  assert.equal(loadPlaybook("boards", books).length, 0);
});

test("a job not marked failed is never reflected — no HTTP at all", async () => {
  const dir = graveJob({ status: "running", seats: [SC02_GRAVE] });
  const books = tmp();
  const { impl, sent } = fetchReturning('{"thinking":"x","ops":[]}');
  const lines = await runReflector({ jobId: "SC-LIVE", crew, seatsDir: books, jobDir: dir, fetchImpl: impl });
  assert.deepEqual(lines, []);
  assert.equal(sent.length, 0, "off-path: a live stage never triggers the Reflector");
});

test("a no-seat grave (fetch failed, no receipts) reflects global only; seat ops are rejected", async () => {
  const dir = graveJob({ error: "fetch failed" });
  const books = tmp();
  const reply = JSON.stringify({
    thinking: "endpoint 死咗，機器級。",
    ops: [
      { op: "ADD", to: "global", class: "machine.endpoint", field: "crew.endpoint", saw: "failed", rule: "job error 係 fetch failed：開 produce 前先 curl 一次 endpoint 健康" },
      { op: "ADD", to: "seat", class: "schema.enum", field: "language", saw: "zh", rule: "language 淨係 zh-Hant|yue|en" },
    ],
  });
  const { impl } = fetchReturning(reply);
  const lines = await runReflector({ jobId: "SC-0912-0NB8", crew, seatsDir: books, jobDir: dir, fetchImpl: impl });
  assert.equal(loadPlaybook("global", books).length, 1);
  assert.equal(loadPlaybook("boards", books).length, 0, "no seat playbook exists for a no-seat grave");
  assert.ok(lines.some((l) => /REJECT 1 seat op/.test(l)), lines.join(" | "));
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
