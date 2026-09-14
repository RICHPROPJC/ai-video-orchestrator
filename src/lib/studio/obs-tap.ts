import fs from "node:fs";
import path from "node:path";
import type { JobEvent } from "./types";

/** obs-tap — 把 slate 嘅 events.jsonl 鏡像去一條 append-only 觀測 bus。
 *
 * Bus row 契約（對齊 fleet 投影器讀法）：一行一 JSON；line 鍵＝檔案行號，
 * 投影器 INSERT OR REPLACE 冪等，所以 tap 只負責 append。
 * 欄位：seq, ts, epoch_ms, kind, name, phase, trace_id, span_id,
 * parent_span_id, status, actor, attrs。
 *
 * kind 只用執行層現有詞彙——level pass/fail → qc_verdict、
 * data.thinking → agent_turn、其餘 stage_progress——下游面板自動歸箱，
 * 唔新增詞表。trace_id＝slate id，span_id＝slate#事件序號。
 *
 * 冪等：cursor 記每個 events.jsonl 已轉發行數，重跑只送新行
 * （append 成功先寫 cursor：crash 喺中間最多重複一行，投影器照食）。
 *
 * 只加檔案、唔改 produce：tap 係獨立 runner（src/run-tap.ts）。
 * 預設 bus 落 repo 內 data/obs/；要接去邊條真 bus，用 --bus／OBS_TAP_BUS
 * 指定，路徑係 ops 層決定，唔入 src。
 */

export type TapRow = {
  seq: number;
  ts: string;
  epoch_ms: number | null;
  kind: "stage_progress" | "agent_turn" | "qc_verdict";
  name: string;
  phase: "execution";
  trace_id: string;
  span_id: string;
  parent_span_id: string;
  status: "ok" | "fail";
  actor: string;
  attrs: Record<string, unknown>;
};

export function tapKind(e: JobEvent): TapRow["kind"] {
  if (e.level === "pass" || e.level === "fail") return "qc_verdict";
  if (e.data && typeof e.data === "object" && "thinking" in e.data) return "agent_turn";
  return "stage_progress";
}

export function tapStatus(e: JobEvent): TapRow["status"] {
  return e.level === "fail" || e.level === "error" ? "fail" : "ok";
}

export function tapRow(e: JobEvent, slate: string, spanSeq: number): TapRow {
  const epoch = Date.parse(e.ts);
  return {
    seq: spanSeq,
    ts: e.ts,
    epoch_ms: Number.isNaN(epoch) ? null : epoch,
    kind: tapKind(e),
    name: String(e.agent),
    phase: "execution",
    trace_id: slate,
    span_id: `${slate}#${spanSeq}`,
    parent_span_id: "",
    status: tapStatus(e),
    actor: `slatecrew:${e.agent}`,
    attrs: {
      level: e.level,
      message: e.message,
      ...(e.step_id ? { step_id: e.step_id } : {}),
      ...(e.seat ? { seat: e.seat } : {}),
      ...(e.data ?? {}),
    },
  };
}

function cursorPath(busPath: string): string {
  return `${busPath}.tap-cursors.json`;
}

function readCursors(busPath: string): Record<string, number> {
  const file = cursorPath(busPath);
  if (!fs.existsSync(file)) return {};
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as Record<string, number>;
  } catch {
    return {}; // 爛 cursor 當冇——append 端 at-least-once，投影器冪等
  }
}

export type TapResult = { slate: string; sent: number; total: number };

/** 一個 slate：events.jsonl 有幾多行就轉發幾多行（cursor 之後嘅新行）。 */
export function tapJob(jobsDir: string, slate: string, busPath: string): TapResult {
  const eventsFile = path.join(jobsDir, slate, "events.jsonl");
  if (!fs.existsSync(eventsFile)) return { slate, sent: 0, total: 0 };
  const lines = fs.readFileSync(eventsFile, "utf-8").split("\n").filter(Boolean);
  const cursors = readCursors(busPath);
  const already = cursors[eventsFile] ?? 0;
  const fresh = lines.slice(already);
  if (fresh.length > 0) {
    const rows = fresh.map((ln, i) => {
      const e = JSON.parse(ln) as JobEvent;
      return tapRow(e, slate, already + i + 1);
    });
    fs.mkdirSync(path.dirname(busPath), { recursive: true });
    const blob = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
    try {
      fs.appendFileSync(busPath, blob, "utf-8");
    } catch (err) {
      throw new Error(`obs-tap: bus 寫唔到 ${busPath} — ${String(err)}`);
    }
    cursors[eventsFile] = lines.length;
    fs.writeFileSync(cursorPath(busPath), JSON.stringify(cursors), "utf-8");
  }
  return { slate, sent: fresh.length, total: lines.length };
}

/** 全部 slates（有 events.jsonl 先算），回每個嘅轉發數。 */
export function tapAll(jobsDir: string, busPath: string, only?: string): TapResult[] {
  if (!fs.existsSync(jobsDir)) throw new Error(`obs-tap: jobs dir 唔存在 ${jobsDir}`);
  return fs
    .readdirSync(jobsDir)
    .filter((d) => (only ? d === only : true))
    .filter((d) => fs.existsSync(path.join(jobsDir, d, "events.jsonl")))
    .sort()
    .map((slate) => tapJob(jobsDir, slate, busPath));
}
