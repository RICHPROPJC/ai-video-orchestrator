import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { listJobs, newSlateId, readEpEvents, readEvents, readJob, runningBlocker, writeJob, emit, failedRecent, failedRecentLines } from "./store";
import type { JobEvent, JobRecord, StageFacts } from "./types";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function job(id: string, status: JobRecord["status"]): JobRecord {
  return {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status,
    input: { brief: "測試", wavDir: "" },
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [], blockout: [], receipts: [] },
  };
}

/** The store hangs off process.cwd()/data — point that at a scratch dir. */
async function scratch(fn: () => void | Promise<void>) {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "store-guard-"));
  process.chdir(tmp);
  try {
    await fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("writeJob/readJob round-trip and listJobs sorts newest first", async () =>
  scratch(() => {
    const a = job(newSlateId(), "boarded");
    a.createdAt = "2026-09-13T00:00:00.000Z";
    const b = job(newSlateId(), "failed");
    b.createdAt = "2026-09-13T09:00:00.000Z";
    writeJob(a);
    writeJob(b);
    assert.equal(readJob(b.id)!.status, "failed");
    assert.equal(readJob("SC-0000-NOPE"), null);
    assert.deepEqual(listJobs().map((j) => j.id), [b.id, a.id]);
  }));

test("a running slate blocks a new produce and names itself", async () =>
  scratch(() => {
    writeJob(job("SC-0913-RUN1", "running"));
    const blocker = runningBlocker();
    assert.ok(blocker);
    assert.equal(blocker!.id, "SC-0913-RUN1");
  }));

test("boarded, failed and queued history do not block", async () =>
  scratch(() => {
    writeJob(job("SC-0913-OLD1", "boarded"));
    writeJob(job("SC-0913-OLD2", "failed"));
    writeJob(job("SC-0913-OLD3", "queued"));
    assert.equal(runningBlocker(), null);
  }));

test("resuming the running slate itself is allowed", async () =>
  scratch(() => {
    writeJob(job("SC-0913-RUN1", "running"));
    assert.equal(runningBlocker("SC-0913-RUN1"), null);
  }));

test("resuming a different slate while one runs is still blocked", async () =>
  scratch(() => {
    writeJob(job("SC-0913-RUN1", "running"));
    const blocker = runningBlocker("SC-0913-OTHR");
    assert.ok(blocker);
    assert.equal(blocker!.id, "SC-0913-RUN1");
  }));

test("A4: emit writes the same line to job events.jsonl and projects/<ep>/events.jsonl", async () =>
  scratch(() => {
    writeJob(job("SC-0914-EVNT", "running"));
    const stage: StageFacts = { shot: "SH03", stage: "require", eye: "pictureQc", verdict: "pass", proof: "data/jobs/SC-0914-EVNT/stills/SH03.png", ms: 812 };
    emit("SC-0914-EVNT", { agent: "pictureQc", level: "pass", message: "SH03 GREEN", data: { ...stage } });
    const jobLines = readEvents("SC-0914-EVNT");
    const epLines = readEpEvents("SC-0914-EVNT");
    assert.equal(jobLines.length, 1);
    assert.equal(epLines.length, 1);
    assert.deepEqual(jobLines[0], epLines[0]);
    // the six A4 keys survive the dual write, byte-identical
    const d = epLines[0]!.data as StageFacts;
    assert.equal(d.shot, "SH03");
    assert.equal(d.stage, "require");
    assert.equal(d.eye, "pictureQc");
    assert.equal(d.verdict, "pass");
    assert.equal(d.proof, "data/jobs/SC-0914-EVNT/stills/SH03.png");
    assert.equal(d.ms, 812);
    assert.ok(fs.existsSync("projects/SC-0914-EVNT/events.jsonl"));
  }));

test("A4: emit before writeJob still lands the job log, no ep line, no crash", async () =>
  scratch(() => {
    emit("SC-0914-NOJOB", { agent: "system", level: "info", message: "開工" });
    assert.equal(readEvents("SC-0914-NOJOB").length, 1);
    assert.deepEqual(readEpEvents("SC-0914-NOJOB"), []);
  }));

test("INSIDE_VISIBLE 卡B 開工掃墓: failedRecent lists corpses, STALE-flags >30min, spares the living", async () =>
  scratch(() => {
    const fresh = job("SC-0921-FA", "failed");
    fresh.error = "seat writer could not parse";
    const old = job("SC-0921-FB", "failed");
    old.updatedAt = new Date(Date.now() - 26 * 3_600_000).toISOString();
    const staleRun = job("SC-0921-FC", "running");
    staleRun.updatedAt = new Date(Date.now() - 45 * 60_000).toISOString();
    writeJob(fresh);
    writeJob(old);
    writeJob(staleRun);
    writeJob(job("SC-0921-FD", "running")); // live and well — never listed
    // writeJob stamps updatedAt=now; real corpses are files nobody touched
    // since — backdate them on disk the way abandonment looks
    const backdate = (id: string, iso: string) => {
      const file = path.join(process.cwd(), "data", "jobs", id, "job.json");
      const rec = JSON.parse(fs.readFileSync(file, "utf8")) as { updatedAt: string };
      rec.updatedAt = iso;
      fs.writeFileSync(file, JSON.stringify(rec, null, 2));
    };
    backdate("SC-0921-FB", new Date(Date.now() - 26 * 3_600_000).toISOString());
    backdate("SC-0921-FC", new Date(Date.now() - 45 * 60_000).toISOString());
    const rows = failedRecent().sort((a, b) => a.job.slate.localeCompare(b.job.slate));
    assert.deepEqual(
      rows.map((r) => [r.job.slate, r.stale]),
      [
        ["SC-0921-FA", false],
        ["SC-0921-FB", true],
        ["SC-0921-FC", true],
      ],
    );
    const lines = failedRecentLines(rows);
    assert.ok(lines.some((l) => l.includes("SC-0921-FB") && l.includes("STALE")), "26h-old corpse is STALE");
    assert.ok(lines.every((l) => l.includes("（未收屍）")), "dig format（未收屍）");
    assert.ok(lines.some((l) => l.includes("seat writer could not parse")), "error head surfaces");
  }));

test("INSIDE_VISIBLE 卡A wiring: the warn event a failed attempt produces lands in events.jsonl", async () =>
  scratch(() => {
    writeJob(job("SC-0921-LAMP", "running"));
    // exactly what pipeline's io.warn → io.speak(warn) emits for a failed attempt
    emit("SC-0921-LAMP", { agent: "writer", level: "warn", message: "阿文／編劇 · writer SC01 attempt 1 ✗ Invalid" });
    const rows = readEvents("SC-0921-LAMP");
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.level, "warn");
    assert.ok(String(rows[0]!.message).includes("attempt 1 ✗"), rows[0]!.message);
  }));

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
