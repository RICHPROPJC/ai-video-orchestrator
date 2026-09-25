import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { toNeedsHuman, emitNeedsHuman, rethrowNeedsHuman, NeedsHumanError } from "./needs-human";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-nh-"));
const jobsDir = path.join(tmp, "jobs");

function mkJob(job: string, slate: string) {
  const dir = path.join(jobsDir, job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "events.jsonl"),
    `${JSON.stringify({ ts: "2026-09-23T05:38:59.967Z", agent: "producer", level: "info", message: "開工" })}\n`,
  );
  fs.writeFileSync(path.join(dir, "job.json"), JSON.stringify({ id: job, slate, status: "running" }));
  return dir;
}

test("needs-human: 認得 seat fallback 三連敗（BEQ5/OLHR 死法原句）", () => {
  const err = new Error("seat writer could not produce valid outline.fallback after 3 attempts");
  const nh = toNeedsHuman(err);
  assert.ok(nh instanceof NeedsHumanError);
  assert.equal(nh!.reason, "seat_fallback_exhausted");
  assert.match(nh!.message, /^needs_human: seat_fallback_exhausted/);
  // boards 席同款
  const b = toNeedsHuman(new Error("seat boards could not produce valid SC01.fallback after 3 attempts"));
  assert.equal(b!.reason, "seat_fallback_exhausted");
});

test("needs-human: 認得 decider parse 兩次唔齊（LM1L 死法原句）", () => {
  const err = new Error(
    "decider parse incomplete after 2 calls (missing SH01); raw head: C111 77_02 | C120 111_28",
  );
  const nh = toNeedsHuman(err);
  assert.equal(nh!.reason, "decider_parse_incomplete");
});

test("needs-human: 唔認得嘅死法返 null——唔好乜都當 needs_human", () => {
  assert.equal(toNeedsHuman(new Error("HTTP 429 after 3 tries")), null);
  assert.equal(toNeedsHuman(new Error("crew.endpoint unset")), null);
  assert.equal(toNeedsHuman("一段字"), null);
  // 非 fallback 嘅三連敗（primary 淨死，未經 fallback 門）唔當
  assert.equal(
    toNeedsHuman(new Error("seat writer could not produce valid outline after 3 attempts")),
    null,
  );
});

test("needs-human: emitNeedsHuman——job log＋ep log 同一行兩處，job.json 唔掂", () => {
  const dir = mkJob("SC-N1", "SC-EP-N1");
  const jobBefore = fs.readFileSync(path.join(dir, "job.json"), "utf8");
  const ev = emitNeedsHuman("SC-N1", {
    reason: "decider_parse_incomplete",
    receipts: ["decider parse incomplete after 2 calls (missing SH01)"],
    jobsDir,
    projectsRoot: path.join(tmp, "projects"),
    ts: "2026-09-24T00:00:00.000Z",
  });
  assert.equal(ev.agent, "system");
  assert.equal(ev.level, "warn");
  assert.equal(ev.data.needs_human, true);
  // job log 尾行就係佢
  const jobLines = fs.readFileSync(path.join(dir, "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(jobLines.length, 2);
  assert.deepEqual(JSON.parse(jobLines[1]!), ev);
  // ep log 同一行
  const epLines = fs
    .readFileSync(path.join(tmp, "projects", "SC-EP-N1", "events.jsonl"), "utf8")
    .trim()
    .split("\n");
  assert.deepEqual(JSON.parse(epLines[epLines.length - 1]!), ev);
  // job.json 冇被改寫
  assert.equal(fs.readFileSync(path.join(dir, "job.json"), "utf8"), jobBefore);
});

test("needs-human: rethrowNeedsHuman——認得出就發事件再 NeedsHumanError；認唔出原樣過", () => {
  mkJob("SC-N2", "SC-EP-N2");
  assert.throws(
    () =>
      rethrowNeedsHuman("SC-N2", new Error("seat writer could not produce valid outline.fallback after 3 attempts"), {
        jobsDir,
        projectsRoot: path.join(tmp, "projects"),
      }),
    (e: Error) => e instanceof NeedsHumanError && /needs_human: seat_fallback_exhausted/.test(e.message),
  );
  const lines = fs.readFileSync(path.join(jobsDir, "SC-N2", "events.jsonl"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  assert.equal(JSON.parse(lines[1]!).data.reason, "seat_fallback_exhausted");
  // 唔認得：原錯誤原樣重 throw，冇事件
  assert.throws(
    () => rethrowNeedsHuman("SC-N2", new Error("HTTP 500")),
    /HTTP 500/,
  );
  assert.equal(fs.readFileSync(path.join(jobsDir, "SC-N2", "events.jsonl"), "utf8").trim().split("\n").length, 2);
});

test("needs-human: job dir 唔存在——大聲死", () => {
  assert.throws(
    () => emitNeedsHuman("SC-GHOST", { reason: "decider_parse_incomplete", jobsDir }),
    /job dir 唔存在/,
  );
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
