import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { tapJob, tapAll, tapRow, tapKind, tapStatus } from "./obs-tap";
import type { JobEvent } from "./types";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "obs-tap-"));
}

function writeJob(root: string, slate: string, events: JobEvent[]): string {
  const dir = path.join(root, slate);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    events.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  return dir;
}

const EVTS: JobEvent[] = [
  {
    ts: "2026-09-14T03:24:56.697Z",
    agent: "producer",
    level: "info",
    message: "開工",
    data: { name: "何晴", thinking: "可以 dispatch" },
  },
  { ts: "2026-09-14T03:30:00.000Z", agent: "delivery", level: "pass", message: "photo QC GREEN" },
  { ts: "2026-09-14T03:31:00.000Z", agent: "delivery", level: "fail", message: "video_qc FAIL" },
];

test("kind/status mapping: thinking→agent_turn, pass/fail→qc_verdict, fail level→fail", () => {
  assert.equal(tapKind(EVTS[0]), "agent_turn");
  assert.equal(tapKind(EVTS[1]), "qc_verdict");
  assert.equal(tapKind(EVTS[2]), "qc_verdict");
  assert.equal(tapStatus(EVTS[2]), "fail");
  assert.equal(tapStatus(EVTS[0]), "ok");
});

test("tapRow: trace/span/actor 契約 + epoch_ms", () => {
  const r = tapRow(EVTS[1], "SC-X", 7);
  assert.equal(r.trace_id, "SC-X");
  assert.equal(r.span_id, "SC-X#7");
  assert.equal(r.actor, "slatecrew:delivery");
  assert.equal(r.phase, "execution");
  assert.equal(r.epoch_ms, Date.parse("2026-09-14T03:30:00.000Z"));
});

test("tapJob: 首跑全送、重跑零送（cursor 冪等）、bus 一行一 JSON", () => {
  const root = tmpDir();
  writeJob(root, "SC-A", EVTS);
  const bus = path.join(root, "bus", "eventbus.jsonl");

  const first = tapJob(root, "SC-A", bus);
  assert.equal(first.sent, 3);
  assert.equal(first.total, 3);

  const second = tapJob(root, "SC-A", bus);
  assert.equal(second.sent, 0);

  const rows = fs.readFileSync(bus, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  assert.equal(rows.length, 3);
  assert.deepEqual(
    rows.map((r) => r.kind),
    ["agent_turn", "qc_verdict", "qc_verdict"],
  );
  assert.ok(rows.every((r) => r.trace_id === "SC-A"));
});

test("tapJob: 新事件只送新增嗰兩行", () => {
  const root = tmpDir();
  const dir = writeJob(root, "SC-B", EVTS);
  const bus = path.join(root, "bus2.jsonl");
  tapJob(root, "SC-B", bus);

  fs.appendFileSync(
    path.join(dir, "events.jsonl"),
    JSON.stringify({ ts: "2026-09-14T04:00:00Z", agent: "system", level: "warn", message: "late" }) + "\n",
  );
  const r = tapJob(root, "SC-B", bus);
  assert.equal(r.sent, 1);
  assert.equal(r.total, 4);
});

test("tapAll: 冇 events.jsonl 嘅目錄略過；only 過濾", () => {
  const root = tmpDir();
  writeJob(root, "SC-C", EVTS);
  fs.mkdirSync(path.join(root, "SC-D")); // 空 slate
  const bus = path.join(root, "bus3.jsonl");
  const all = tapAll(root, bus);
  assert.deepEqual(all.map((r) => r.slate), ["SC-C"]);
  const only = tapAll(root, bus, "SC-D");
  assert.deepEqual(only, []);
});

test("tapJob: bus 寫唔到（路徑係目錄）→ fail-loud", () => {
  const root = tmpDir();
  writeJob(root, "SC-E", EVTS);
  const busAsDir = path.join(root, "i-am-a-dir");
  fs.mkdirSync(busAsDir);
  assert.throws(() => tapJob(root, "SC-E", busAsDir), /bus 寫唔到/);
});
