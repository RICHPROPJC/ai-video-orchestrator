import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { listJobs, newSlateId, readJob, runningBlocker, writeJob } from "./store";
import type { JobRecord } from "./types";

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
