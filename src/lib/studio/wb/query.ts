import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataRoot } from "../paths";
import { FLOOR } from "../crew";
import { wbDbPath } from "./projector";

/** wb/query.ts — 「查詢命令係唯一唔會腐嘅事實」嘅查詢層。
 *
 *  白盒同款立場：唔靠記憶、唔靠散文，一條 SQL／一個 helper 即揾即到。
 *  查詢永遠 readonly 開 db——查詢層冇筆。 */

/** readonly 開：查詢層冇筆；db 唔存在就大聲死，唔靜靜開空檔扮查到。 */
export function openWbQuery(dbPath: string): DatabaseSync {
  if (!fs.existsSync(dbPath)) {
    throw new Error(`wb query: db missing: ${dbPath} — 先行 projectEvents() / wb project`);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

const READ_ONLY_RE = /^\s*(select|with)\b/i;

/** 俾 SQL 即揾即到。只放 SELECT/WITH 過——查詢層一個寫位都唔留。 */
export function wbQuery(
  dbPath: string,
  sql: string,
): { columns: string[]; rows: Record<string, unknown>[] } {
  if (!READ_ONLY_RE.test(sql)) {
    throw new Error(`wb query: 只放 SELECT/WITH（查詢層冇筆）：${sql.slice(0, 80)}`);
  }
  const db = openWbQuery(dbPath);
  try {
    const st = db.prepare(sql);
    const rows = st.all() as Record<string, unknown>[];
    const columns = rows.length
      ? Object.keys(rows[0]!)
      : (st as unknown as { columns?: () => { name: string }[] }).columns?.().map((c) => c.name) ?? [];
    return { columns, rows };
  } finally {
    db.close();
  }
}

/** 查一個 job 最新 k 件事件（行序倒數——真相源位置最近嘅喺頭）。 */
export function latestEvents(
  dbPath: string,
  source: string,
  k = 5,
): Record<string, unknown>[] {
  const db = openWbQuery(dbPath);
  try {
    return db
      .prepare(
        "SELECT line, ts, agent, level, message FROM events WHERE source = ? ORDER BY line DESC LIMIT ?",
      )
      .all(source, k) as Record<string, unknown>[];
  } finally {
    db.close();
  }
}

export type SeatPacket = { agent: string; events: Record<string, unknown>[] };

/** 一個 job 入面，每個席只收回自己嘅事件。system 行另袋，唔併入席。 */
export function dispatchBySeat(dbPath: string, source: string): SeatPacket[] {
  const db = openWbQuery(dbPath);
  try {
    const st = db.prepare(
      "SELECT line, ts, agent, level, message FROM events WHERE source = ? AND agent = ? ORDER BY line",
    );
    const packets: SeatPacket[] = FLOOR.map((agent) => ({
      agent,
      events: st.all(source, agent) as Record<string, unknown>[],
    }));
    packets.push({
      agent: "system",
      events: st.all(source, "system") as Record<string, unknown>[],
    });
    return packets;
  } finally {
    db.close();
  }
}

export type DeathRow = { job: string; status: string; cause: string; lastEvent: string };

/** 全廠 failed job，死因一句：job.json error 嘅第一句（diagnosis 係
 *  job.json 嘅 claim；碟上事件可質疑——用 wb 最新一條 error/fail 事件對照）。
 *  一個 job 一行，唔展開。 */
export function failedDeathCauses(opts?: { jobsDir?: string; dbPath?: string }): DeathRow[] {
  const jobsDir = opts?.jobsDir ?? dataRoot();
  const dbPath = opts?.dbPath ?? wbDbPath();
  const out: DeathRow[] = [];
  if (!fs.existsSync(jobsDir)) return out;
  const db = fs.existsSync(dbPath) ? openWbQuery(dbPath) : null;
  const lastStmt = db?.prepare(
    "SELECT message FROM events WHERE source = ? AND (level = 'error' OR level = 'fail') ORDER BY line DESC LIMIT 1",
  );
  const lastEventOf = (source: string) =>
    (lastStmt?.get(source) as { message?: string } | undefined)?.message ?? "";
  try {
  for (const d of fs.readdirSync(jobsDir, { withFileTypes: true }).filter((e) => e.isDirectory())) {
    const file = path.join(jobsDir, d.name, "job.json");
    if (!fs.existsSync(file)) continue;
    let job: { status?: string; error?: string };
    try {
      job = JSON.parse(fs.readFileSync(file, "utf8")) as typeof job;
    } catch {
      continue;
    }
    if (job.status !== "failed") continue;
    // 死因一句：第一句（。！？\n 切），駁 job.json 嘅 claim 同事件尾對齊
    const cause = (job.error ?? "(job.json 冇寫死因)").split(/[。！？\n]/)[0]!.trim();
    out.push({ job: d.name, status: "failed", cause, lastEvent: lastEventOf(d.name) });
  }
  return out;
  } finally {
    db?.close();
  }
}
