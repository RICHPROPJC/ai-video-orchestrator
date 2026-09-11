import fs from "node:fs";
import path from "node:path";
import type { JobEvent, JobRecord } from "./types";
import { dataRoot, ensureDir, jobDir, jobFile } from "./paths";

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
  const file = jobFile(id, "events.jsonl");
  fs.appendFileSync(file, `${JSON.stringify(full)}\n`);
  const job = readJob(id);
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

export function newSlateId() {
  const d = new Date();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `SC-${mm}${dd}-${rand}`;
}
