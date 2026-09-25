import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectEvents, openWbDb, wbDbPath } from "./projector";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-proj-"));
const jobsDir = path.join(tmp, "jobs");

function writeEvents(job: string, lines: unknown[]) {
  const dir = path.join(jobsDir, job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
  );
}

const ev = (message: string, extra: Record<string, unknown> = {}) => ({
  ts: "2026-09-23T10:47:11.702Z",
  agent: "producer",
  level: "info",
  message,
  ...extra,
});

test("projector: 兩個 job 分 source 入庫，行序做鍵，data JSON 原樣", () => {
  writeEvents("SC-A", [ev("開工"), { ts: "2026-09-23T10:48:00.000Z", agent: "writer", level: "fail", message: "schema miss", data: { shot: "SC01", attempts: 3 } }]);
  writeEvents("SC-B", [ev("B 場開工")]);
  const db = path.join(tmp, "wb.db");
  const r = projectEvents({ dbPath: db, jobsDir });
  assert.equal(r.projected, 3);
  assert.equal(r.skipped, 0);
  assert.deepEqual(r.sources.map((s) => s.source), ["SC-A", "SC-B"]);

  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const a = conn.prepare("SELECT line, agent, message, data FROM events WHERE source='SC-A' ORDER BY line").all() as Record<string, unknown>[];
    assert.equal(a.length, 2);
    assert.equal(a[0]!.line, 1);
    assert.equal(a[1]!.agent, "writer");
    assert.deepEqual(JSON.parse(a[1]!.data as string), { shot: "SC01", attempts: 3 });
  } finally {
    conn.close();
  }
});

test("projector: 增量——append 三行只入三行，重跑零入（冪等）", () => {
  const db = path.join(tmp, "wb.db");
  writeEvents("SC-A2", [ev("開工"), ev("第二行")]);
  const first = projectEvents({ dbPath: db, jobsDir });
  assert.equal(first.projected, 2);
  // append：真相源續行，投影只食新行
  fs.appendFileSync(path.join(jobsDir, "SC-A2", "events.jsonl"), JSON.stringify(ev("第三行")) + "\n");
  const inc = projectEvents({ dbPath: db, jobsDir });
  assert.equal(inc.projected, 1);
  // 重跑：append-only 源零新行
  const again = projectEvents({ dbPath: db, jobsDir });
  assert.equal(again.projected, 0);
  const conn = new DatabaseSync(db, { readOnly: true });
  try {
    const n = conn.prepare("SELECT COUNT(*) AS n FROM events WHERE source='SC-A2'").get() as { n: number };
    assert.equal(n.n, 3);
  } finally {
    conn.close();
  }
});

test("projector: 爛行跳過照數，唔阻後面好行", () => {
  const dir = path.join(jobsDir, "SC-C");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    `${JSON.stringify(ev("好行"))}\n{這不是json\n\n${JSON.stringify(ev("尾行"))}\n`,
  );
  const r = projectEvents({ dbPath: path.join(tmp, "wb.db"), jobsDir });
  const src = r.sources.find((s) => s.source === "SC-C");
  assert.equal(src!.projected, 2);
  assert.equal(r.skipped, 1);
  assert.ok(openWbDb(path.join(tmp, "wb.db"))); // db 開得
});

test("projector: wbDbPath 喺 data/ 底（合約位）", () => {
  assert.equal(wbDbPath(), path.join(process.cwd(), "data", "wb.db"));
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
