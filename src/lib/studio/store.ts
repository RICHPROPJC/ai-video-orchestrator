import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { JobEvent, JobRecord } from "./types";
import { dataRoot, ensureDir, epEventsFile, jobDir, jobFile, projectsDir } from "./paths";

const listeners = new Map<string, Set<(e: JobEvent) => void>>();

export function readJob(id: string): JobRecord | null {
  const file = path.join(jobDir(id), "job.json");
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as JobRecord;
}

// ── V2a（PLAN-v2 0928）：job 唯一執行者 ────────────────────────────────────
// owner.json＝原子互斥（wx/O_EXCL：兩個 process 同搶，一個成功）；epoch 單調
// 遞增——接管後舊 token 永久失效。heartbeat＝emit 順手 touch mtime；靜過
// 30 分鐘先准接管（同 failedRecent STALE 同一條線）。

export type JobOwner = {
  ownerToken: string;
  epoch: number;
  acquiredAt: string;
  pid?: number;
  /** 接管尾巴：邊個 epoch 被 superseded、點解 */
  superseded?: { byEpoch: number; reason: string; at: string }[];
  releasedAt?: string;
};

const ownerFile = (id: string) => path.join(jobDir(id), "owner.json");
const STALE_MS = 30 * 60_000;

export function readOwner(id: string): JobOwner | null {
  try {
    return JSON.parse(fs.readFileSync(ownerFile(id), "utf8")) as JobOwner;
  } catch {
    return null;
  }
}

/** 原子取權：撞活鎖返 holder（caller 決定 refuse 定接管）；撞已 release／
 *  STALE holder＝直接接管（rename 原子替換，舊 token 失效）。 */
export function acquireJob(id: string, pid: number = process.pid): { ok: true; owner: JobOwner } | { ok: false; holder: JobOwner | null } {
  ensureDir(jobDir(id));
  const owner: JobOwner = {
    ownerToken: randomUUID(),
    epoch: (readOwner(id)?.epoch ?? 0) + 1,
    acquiredAt: new Date().toISOString(),
    pid,
  };
  try {
    fs.writeFileSync(ownerFile(id), JSON.stringify(owner, null, 2), { flag: "wx" });
    return { ok: true, owner };
  } catch {
    const holder = readOwner(id);
    if (holder?.releasedAt || ownerIsStale(id)) {
      return { ok: true, owner: takeoverJob(id, holder?.releasedAt ? "前一 owner 已 release" : "STALE 超過 30 分鐘無心跳") };
    }
    return { ok: false, holder };
  }
}

/** 接管（rename 原子替換）：舊 token 由呢一刻起全部失效。 */
export function takeoverJob(id: string, reason: string, pid: number = process.pid): JobOwner {
  const prev = readOwner(id);
  const next: JobOwner = {
    ownerToken: randomUUID(),
    epoch: (prev?.epoch ?? 0) + 1,
    acquiredAt: new Date().toISOString(),
    pid,
    ...(prev ? { superseded: [...(prev.superseded ?? []), { byEpoch: (prev.epoch ?? 0) + 1, reason, at: new Date().toISOString() }].slice(-8) } : {}),
  };
  const tmp = ownerFile(id) + ".takeover";
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, ownerFile(id));
  return next;
}

export function ownerHeartbeatMs(id: string, nowMs = Date.now()): number | null {
  try {
    return nowMs - fs.statSync(ownerFile(id)).mtimeMs;
  } catch {
    return null;
  }
}

export function ownerIsStale(id: string): boolean {
  const ms = ownerHeartbeatMs(id);
  return ms === null || ms > STALE_MS;
}

export function touchOwner(id: string): void {
  try {
    fs.utimesSync(ownerFile(id), new Date(), new Date());
  } catch {
    /* 冇 owner 檔＝冇嘢好 touch */
  }
}

export function releaseJob(id: string): void {
  const owner = readOwner(id);
  if (!owner || owner.releasedAt) return;
  fs.writeFileSync(ownerFile(id), JSON.stringify({ ...owner, releasedAt: new Date().toISOString() }, null, 2));
}

/** owner guard 唔夾＝舊 owner 唔准再寫（fail-loud，帶邊個係現行 owner）。 */
export class OwnerLostError extends Error {
  constructor(id: string, current: JobOwner | null, mine: JobOwner) {
    super(
      `owner_lost: ${id} 執行權已經唔係你（epoch ${mine.epoch}）——` +
        (current ? `現行 owner epoch ${current.epoch}（pid ${current.pid ?? "?"}，${current.acquiredAt} 取得）` : "owner.json 已被移除"),
    );
    this.name = "OwnerLostError";
  }
}

/** 帶 guard 嘅寫：唔傳 owner＝照舊寫（入口側回填等向後兼容位）。 */
export function writeJob(job: JobRecord, owner?: JobOwner) {
  if (owner) {
    const cur = readOwner(job.id);
    if (!cur || cur.ownerToken !== owner.ownerToken || (cur.epoch ?? 0) > owner.epoch) {
      throw new OwnerLostError(job.id, cur, owner);
    }
    job = { ...job, ownerEpoch: owner.epoch };
  }
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
    // V3（PLAN-v2 0928）§9.1：blocked 彙總——data.blocked upsert、同 shot
    // pass verdict 清返（per-shot blocked 唔再只係一閃即過嘅 event，job.json
    // 有可恢復狀態俾 UI／resume 查）。
    const d = (event.data ?? null) as { blocked?: unknown; shot?: unknown; verdict?: unknown; stage?: unknown } | null;
    if (d && typeof d.shot === "string") {
      if (typeof d.blocked === "string") {
        const stage = typeof d.stage === "string" ? d.stage : undefined;
        const row = { shot: d.shot, stage, reason: d.blocked, ts: full.ts };
        // §10.2：upsert 身份＝shot+stage——同鏡另一 stage 嘅未解原因唔被抹。
        const rest = (job.blockedShots ?? []).filter((b) => !(b.shot === row.shot && b.stage === stage));
        job.blockedShots = [...rest, row];
      } else if (d.verdict === "pass") {
        // §9②：同 stage pass 先清同 stage block——placement-gap（audio-placement）
        // 唔會被 stills pass 意外清走；跨 stage 解鎖由 gap 自身重算清。
        job.blockedShots = (job.blockedShots ?? []).filter(
          (b) => !(b.shot === d.shot && typeof d.stage === "string" && b.stage === d.stage),
        );
      }
    }
    writeJob(job);
  }
  touchOwner(id); // V2a heartbeat：有 event 流＝owner 仲生猛
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
