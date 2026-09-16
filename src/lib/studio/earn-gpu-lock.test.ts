import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { earnLockPath, shouldWaitEarnLock, waitEarnGpuLock } from "./earn-gpu-lock";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom)
 *  Tests inject lockPath explicitly — no process.env mutation, so concurrent
 *  test files can never stomp each other's lock. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function tempLock(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "earn-lock-"));
  return path.join(dir, ".lock");
}

test("A1: a present lock parks the wait and speaks exactly once until earn lifts it", async () => {
  const lock = tempLock();
  fs.writeFileSync(lock, "earn 123 2026-09-16T21:00:00+08:00\n");
  let spoken = 0;
  const polls: number[] = [];
  // the fake clock: earn removes the lock during the second poll (rm is
  // earn's move, simulated here on a temp path — the waiter itself never rm's)
  const sleep = async (ms: number) => {
    polls.push(ms);
    if (polls.length === 2) fs.rmSync(lock);
  };
  await waitEarnGpuLock({ lockPath: lock, speak: () => { spoken += 1; }, sleep, pollMs: 5000 });
  assert.equal(spoken, 1, "speak fires once, not per poll");
  assert.deepEqual(polls, [5000, 5000], "polls at ≤5s until the lock lifts");
  assert.ok(!fs.existsSync(lock), "the waiter never recreates the lock");
  fs.rmSync(path.dirname(lock), { recursive: true, force: true });
});

test("A2: no lock passes straight through — no speak, no poll", async () => {
  const lock = tempLock();
  assert.ok(!fs.existsSync(lock));
  let spoken = 0;
  const polls: number[] = [];
  await waitEarnGpuLock({ lockPath: lock, speak: () => { spoken += 1; }, sleep: async (ms) => { polls.push(ms); } });
  assert.equal(spoken, 0);
  assert.equal(polls.length, 0);
  fs.rmSync(path.dirname(lock), { recursive: true, force: true });
});

test("A3: dry-run and boards/blockout runs never wait on the earn lock", () => {
  assert.equal(shouldWaitEarnLock({}), true, "a plain produce waits");
  assert.equal(shouldWaitEarnLock({ until: "stills" }), true, "--until stills still burns U1.5");
  assert.equal(shouldWaitEarnLock({ until: "motion" }), true, "--until motion still burns H3");
  assert.equal(shouldWaitEarnLock({ dryRun: true }), false, "dry-run never POSTs the pair");
  assert.equal(shouldWaitEarnLock({ until: "boards" }), false, "boards stops before the pair");
  assert.equal(shouldWaitEarnLock({ until: "blockout" }), false, "blockout stops before the pair");
  assert.equal(shouldWaitEarnLock({ dryRun: true, until: "motion" }), false, "dry-run wins either way");
});

test("SLATECREW_EARN_LOCK overrides the default earn path", () => {
  const had = process.env.SLATECREW_EARN_LOCK;
  try {
    process.env.SLATECREW_EARN_LOCK = "/tmp/t39-env.lock";
    assert.equal(earnLockPath(), "/tmp/t39-env.lock");
    assert.equal(earnLockPath("/tmp/t39-explicit.lock"), "/tmp/t39-explicit.lock", "explicit wins over env");
  } finally {
    if (had === undefined) delete process.env.SLATECREW_EARN_LOCK;
    else process.env.SLATECREW_EARN_LOCK = had;
  }
  assert.match(earnLockPath(), /earn\/\.lock$/, "no override falls back to earn's lock");
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
