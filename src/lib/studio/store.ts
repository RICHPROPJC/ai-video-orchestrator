import fs from "node:fs";
import path from "node:path";
import type { JobEvent, JobRecord } from "./types";
import { dataRoot, ensureDir, epEventsFile, jobDir, jobFile, projectsDir } from "./paths";

const listeners = new Map<string, Set<(e: JobEvent) => void>>();

export function readJob(id: string): JobRecord | null {
  const file = path.join(jobDir(id), "job.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
}

export function writeJob(job: JobRecord) {
  ensureDir(jobDir(job.id));
  job.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(jobDir(job.id), "job.json"), JSON.stringify(job, null, 2));
}

export function listJobs(): JobRecord[] {
  if (!fs.existsSync(dataRoot())) return [];
  return fs
    .readdirSync(dataRoot())
    .map((id) => readJob(id))
    .filter((j): j is JobRecord => Boolean(j))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Serial floor: one slate runs at a time. Returns the running job that blocks
 *  a new produce, or null. Resuming that same job is allowed; queued, failed
 *  and boarded history never blocks. */
export function runningBlocker(resumeSlate?: string): JobRecord | null {
  for (const j of listJobs()) {
    if (j.status !== "running") continue;
    if (resumeSlate && (j.id === resumeSlate || j.slate === resumeSlate)) continue;
    return j;
  }
  return null;
}

/** INSIDE_VISIBLE 卡B 開工掃墓: corpses a fresh produce/status must trip over —
 *  failed jobs never swept, plus running jobs gone quiet past half an hour
 *  (STALE). Same listJobs sweep as runningBlocker; surfaced, never blocking. */
export type FailedRecentRow = { job: JobRecord; quietMin: number; stale: boolean };

export function failedRecent(nowMs = Date.now()): FailedRecentRow[] {
  const out: FailedRecentRow[] = [];
  for (const j of listJobs()) {
    const updated = Date.parse(j.updatedAt || j.createdAt);
    if (Number.isNaN(updated)) continue;
    const quietMin = Math.round((nowMs - updated) / 60_000);
    if (j.status === "failed") out.push({ job: j, quietMin, stale: quietMin > 30 });
    else if (j.status === "running" && quietMin > 30) out.push({ job: j, quietMin, stale: true });
  }
  return out;
}

/** One ⚠ line per corpse (dig format): slate · status · quiet time · error head. */
export function failedRecentLines(rows: FailedRecentRow[]): string[] {
  return rows.map((r) => `${r.stale ? "⚠ STALE " : "⚠ "}${r.job.slate} ${r.job.status} ${r.quietMin} 分鐘前：${(r.job.error ?? "").slice(0, 60)}（未收屍）`);
}


export function subscribe(id: string, fn: (e: JobEvent) => void) {
  const set = listeners.get(id) ?? new Set();
  set.add(fn);
  listeners.set(id, set);
  return () => {
    set.delete(fn);
  };
}

export function emit(id: string, event: Omit<JobEvent, "ts"> & { ts?: string }) {
  const full: JobEvent = { ...event, ts: event.ts ?? new Date().toISOString() };
  const line = `${JSON.stringify(full)}\n`;
  fs.appendFileSync(jobFile(id, "events.jsonl"), line);
  // A4: the same line, byte for byte, lands in the ep's own events file —
  // one log written twice, never a second format to reconcile
  const job = readJob(id);
  if (job?.slate) fs.appendFileSync(epEventsFile(job.slate), line);
  if (job) {
    writeJob(job);
  }
  for (const fn of listeners.get(id) ?? []) fn(full);
  return full;
}

export function readEvents(id: string): JobEvent[] {
  const file = path.join(jobDir(id), "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JobEvent);
}

/** The ep view `slatecrew events [slate]` prints and --follows. */
export function readEpEvents(slate: string): JobEvent[] {
  const file = path.join(projectsDir(), slate, "events.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JobEvent);
}

export function newSlateId() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SC-${mm}${dd}-${rand}`;
}
