import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectEvents } from "./projector";
import { wbQuery, latestEvents, failedDeathCauses, dispatchBySeat } from "./query";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-query-"));
const jobsDir = path.join(tmp, "jobs");
const db = path.join(tmp, "wb.db");

function mkJob(job: string, events: unknown[], jobJson?: Record<string, unknown>) {
  const dir = path.join(jobsDir, job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  if (jobJson) fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify(jobJson, null, 2));
}

const ev = (message: string, level = "info") => ({
  ts: "2026-09-23T10:47:11.702Z",
  agent: "layout",
  level,
  message,
});

mkJob("SC-Q1", [ev("開工"), ev("H3 落片 SH01", "pass"), ev("shot SH01 fail: ffprobe 0s", "error")], {
  id: "SC-Q1", status: "failed", error: "seat writer could not produce valid outline.fallback after 3 attempts",
});
mkJob("SC-Q2", [ev("Q2 開工")], { id: "SC-Q2", status: "failed", error: "decider parse incomplete after 2 calls (missing SH01)。raw head: C111 77_02" });
mkJob("SC-Q3", [ev("Q3 running")], { id: "SC-Q3", status: "running" });
projectEvents({ dbPath: db, jobsDir });

test("query: wbQuery 即揾即到（SQL 過濾器自由）", () => {
  const r = wbQuery(db, "SELECT source, message FROM events WHERE level='error' ORDER BY line");
  assert.equal(r.rows.length, 1);
  assert.equal(r.rows[0]!.source, "SC-Q1");
  assert.match(String(r.rows[0]!.message), /SH01/);
  // WITH 都放行
  const w = wbQuery(db, "WITH f AS (SELECT * FROM events WHERE level='error') SELECT COUNT(*) AS n FROM f");
  assert.equal(w.rows[0]!.n, 1);
});

test("query: 每個席只收回自己嘅事件", () => {
  const packets = dispatchBySeat(db, "SC-Q1");
  const layout = packets.find((p) => p.agent === "layout");
  const writer = packets.find((p) => p.agent === "writer");
  assert.equal(layout?.events.length, 3);
  assert.equal(writer?.events.length, 0);
  assert.ok(packets.every((p) => p.events.every((e) => e.agent === p.agent)));
});

test("query: 查詢層冇筆——UPDATE/DELETE/INSERT/ATTACH 全拒", () => {
  for (const bad of [
    "UPDATE events SET message='x'",
    "DELETE FROM events",
    "INSERT INTO events VALUES (1)",
    "DROP TABLE events",
    "PRAGMA journal_mode=delete",
  ]) {
    assert.throws(() => wbQuery(db, bad), /只放 SELECT\/WITH/, bad);
  }
});

test("query: db 唔存在大聲死，唔靜靜開空檔", () => {
  assert.throws(() => wbQuery(path.join(tmp, "唔存在.db"), "SELECT 1"), /db missing/);
});

test("query: latestEvents 最新 k 件，行序倒數", () => {
  const rows = latestEvents(db, "SC-Q1", 2);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.line, 3);
  assert.match(String(rows[0]!.message), /SH01 fail/);
});

test("query: failedDeathCauses——全廠 failed job 死因一句，running 唔入", () => {
  const rows = failedDeathCauses({ jobsDir, dbPath: db });
  assert.deepEqual(rows.map((r) => r.job).sort(), ["SC-Q1", "SC-Q2"]);
  const q1 = rows.find((r) => r.job === "SC-Q1")!;
  assert.equal(q1.cause, "seat writer could not produce valid outline.fallback after 3 attempts");
  // 死因一句：第一句為止
  const q2 = rows.find((r) => r.job === "SC-Q2")!;
  assert.equal(q2.cause, "decider parse incomplete after 2 calls (missing SH01)");
  // 尾對齊：db 有嘅話帶埋最新 fail 事件
  assert.match(q1.lastEvent, /SH01 fail/);
  assert.equal(rows.find((r) => r.job === "SC-Q3"), undefined);
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
