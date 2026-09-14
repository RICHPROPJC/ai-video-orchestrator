import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import * as nodeTest from "node:test";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const FACTORY = path.resolve(__dirname, "../../..");
const TSX = path.join(FACTORY, "node_modules", ".bin", "tsx");
const CLI = path.join(FACTORY, "src", "cli.ts");

function waitFor(stdout: string[], needle: string, everyMs = 50) {
  return new Promise<void>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (stdout.some((l) => l.includes(needle))) return resolve();
      if (Date.now() - started > 20_000) return reject(new Error(`timeout waiting for "${needle}"; got: ${stdout.join(" | ").slice(0, 400)}`));
      setTimeout(tick, everyMs);
    };
    tick();
  });
}

/** A2: `events --follow` prints history, live-appends, and the test itself
 *  always terminates — kill + await, never an orphan. */
test("events --follow prints seeded history then streams an appended line", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "events-follow-"));
  const slate = "SC-0914-FLLW";
  const file = path.join(tmp, "projects", slate, "events.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const seeded = { ts: "2026-09-14T10:00:00.000Z", agent: "stills", level: "info", message: "SH01 keyframe 完成", data: { shot: "SH01", stage: "keyframe", eye: "stills", verdict: "pass", proof: `data/jobs/${slate}/stills/SH01.png`, ms: 2400 } };
  fs.writeFileSync(file, `${JSON.stringify(seeded)}\n`);
  const stdout: string[] = [];
  // detached + process group: SIGKILL reaps tsx AND any grandchild it spawned,
  // so a killed follow never leaves an open pipe holding the runner alive
  const child = spawn(TSX, [CLI, "events", "--follow", slate], { cwd: tmp, detached: true, stdio: ["ignore", "pipe", "pipe"] });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.stdout.on("data", (b) => stdout.push(...b.toString().split("\n")));
  try {
    await waitFor(stdout, "SH01 keyframe 完成");
    await waitFor(stdout, "-- follow", 200); // past history, into the poll loop
    const appended = { ts: "2026-09-14T10:00:05.000Z", agent: "pictureQc", level: "pass", message: "SH01 GREEN", data: { shot: "SH01", stage: "require", eye: "pictureQc", verdict: "pass", ms: 900 } };
    fs.appendFileSync(file, `${JSON.stringify(appended)}\n`);
    await waitFor(stdout, "SH01 GREEN");
    assert.ok(stdout.some((l) => l.includes("proof=data")), `stage keys printed: ${stdout.join(" | ")}`);
  } finally {
    try {
      process.kill(-child.pid!, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
    child.stdout.destroy();
    child.stderr.destroy();
    await exited;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
