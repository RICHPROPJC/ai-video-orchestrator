import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { dataRoot } from "../paths";

/** wb/projector.ts — slatecrew 內部白盒：events.jsonl → SQLite 投影。
 *
 *  白盒哲學（/mnt/ssd/whitebox/eventbus/projector.py 同款）：jsonl 係不可改嘅
 *  真相源，SQLite 係查詢投影。行序（line）係唯一可靠鍵——append-only，
 *  唔信任何 event 自己帶嘅 seq/ts 順序。每個 job 嘅 events 一個 source 欄
 *  分別，PK = (source, line)，一條 SQL 揾返任何時刻發生過乜。
 *
 *  同白盒分別：呢度唔係常駐 loop，係 callable——projectEvents() 叫一次
 *  行一次；projectLive() 先係尾隨 loop（唔啱叫唔開）。 */

export const WB_SCHEMA = `
CREATE TABLE IF NOT EXISTS events(
  source TEXT NOT NULL,          -- job id（data/jobs/<id>/events.jsonl 嘅 <id>）
  line INTEGER NOT NULL,         -- jsonl 行序＝真相源位置（append-only，唯一可靠鍵）
  ts TEXT NOT NULL,
  agent TEXT,
  level TEXT,
  message TEXT,
  data TEXT,                     -- event.data JSON 原樣，未經解構
  PRIMARY KEY (source, line)
);
CREATE INDEX IF NOT EXISTS ix_wb_ts ON events(ts);
CREATE INDEX IF NOT EXISTS ix_wb_agent ON events(agent);
CREATE INDEX IF NOT EXISTS ix_wb_level ON events(level);
`;

export function wbDbPath(): string {
  return path.join(process.cwd(), "data", "wb.db");
}

/** 只增唔改：投影永遠 INSERT OR IGNORE——重跑唔會整多行，亦唔會改舊行。
 *  改寫歷史唔係投影嘅工作。 */
export function openWbDb(dbPath: string): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec(WB_SCHEMA);
  return db;
}

export type ProjectResult = {
  /** 新入庫行數 */
  projected: number;
  /** 跳過嘅爛行（唔係 JSON）——真相源唔動，只報數 */
  skipped: number;
  sources: { source: string; file: string; projected: number }[];
};

function projectSource(db: DatabaseSync, source: string, file: string): { projected: number; skipped: number } {
  const maxLine = db
    .prepare("SELECT COALESCE(MAX(line),0) AS m FROM events WHERE source = ?")
    .get(source)!.m as number;
  let projected = 0;
  let skipped = 0;
  // 行序鍵：由 DB 最大行嘅下一行讀起。檔案係 append-only，前段永遠唔使重讀。
  const lines = fs.readFileSync(file, "utf8").split("\n");
  for (let i = maxLine; i < lines.length; i += 1) {
    const line = lines[i]!;
    if (!line.trim()) continue;
    let e: { ts?: unknown; agent?: unknown; level?: unknown; message?: unknown; data?: unknown };
    try {
      e = JSON.parse(line) as typeof e;
    } catch {
      skipped += 1;
      continue;
    }
    db.prepare(
      "INSERT OR IGNORE INTO events(source, line, ts, agent, level, message, data) VALUES (?,?,?,?,?,?,?)",
    ).run(
      source,
      i + 1,
      typeof e.ts === "string" ? e.ts : "",
      typeof e.agent === "string" ? e.agent : null,
      typeof e.level === "string" ? e.level : null,
      typeof e.message === "string" ? e.message : null,
      e.data === undefined ? null : JSON.stringify(e.data),
    );
    projected += 1;
  }
  return { projected, skipped };
}

/** 全廠掃一次：jobsDir 下每個 events.jsonl 增量投影入 db（斷電安全：
 *  重跑由 per-source MAX(line) 之後續讀，INSERT OR IGNORE 冪等）。 */
export function projectEvents(opts?: { dbPath?: string; jobsDir?: string }): ProjectResult {
  const dbPath = opts?.dbPath ?? wbDbPath();
  const jobsDir = opts?.jobsDir ?? dataRoot();
  const db = openWbDb(dbPath);
  try {
    const out: ProjectResult = { projected: 0, skipped: 0, sources: [] };
    if (!fs.existsSync(jobsDir)) return out;
    const jobs = fs
      .readdirSync(jobsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    for (const job of jobs) {
      const file = path.join(jobsDir, job, "events.jsonl");
      if (!fs.existsSync(file)) continue;
      const r = projectSource(db, job, file);
      out.projected += r.projected;
      out.skipped += r.skipped;
      out.sources.push({ source: job, file, projected: r.projected });
    }
    return out;
  } finally {
    db.close();
  }
}

/** 白盒 projector 嘅 live loop 形：尾隨增量直到 signal 燒斷。callable，
 *  唔自動開——開常駐係 caller 嘅決定。 */
export async function projectLive(opts?: {
  dbPath?: string;
  jobsDir?: string;
  intervalMs?: number;
  signal?: AbortSignal;
  onTick?: (r: ProjectResult) => void;
}): Promise<void> {
  const intervalMs = opts?.intervalMs ?? 2000;
  while (!opts?.signal?.aborted) {
    const r = projectEvents(opts);
    if (r.projected || r.skipped) opts?.onTick?.(r);
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}
