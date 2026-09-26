import fs from "node:fs";
import path from "node:path";
import { projectsDir } from "../paths";

/** wb/needs-human.ts — needs_human 出口（唔係 throw 完死）。
 *
 *  LM1L 死法：decider parse 兩次唔齊 → throw → job failed，冇人知要人手。
 *  同款死法：seat fallback 三連敗（outline.fallback / SC01.fallback after
 *  3 attempts）→ throw 完死。
 *
 *  出口（同 decider conf<0.7 同款形狀）：唔只 throw——發一條 `needs_human`
 *  事件入 events.jsonl（job log＋ep log，A4 一稿兩寫），帶 reason＋死因
 *  收據，人／機器都揾得到。job.json 唔掂（改 claim 唔係出口嘅工作）。
 *
 *  呢度淨係做「認得死法＋發事件」；pipeline 接線（call site 改 throw 為
 *  emitNeedsHuman）係另一張卡——wb/ 唔改現場 code。 */

export type NeedsHumanReason = "seat_fallback_exhausted" | "decider_parse_incomplete";

export class NeedsHumanError extends Error {
  readonly reason: NeedsHumanReason;
  readonly original: string;
  constructor(reason: NeedsHumanReason, original: string) {
    super(`needs_human: ${reason} — ${original}`);
    this.name = "NeedsHumanError";
    this.reason = reason;
    this.original = original;
  }
}

const SEAT_FALLBACK_DEATH = /could not produce valid \S+\.fallback after \d+ attempts/;
const DECIDER_PARSE_DEATH = /decider parse incomplete after \d+ calls/;

/** 認得兩種死法：seat fallback 三連敗／decider parse 兩次唔齊。
 *  認唔出返 null——唔好乜嘢都當 needs_human。 */
export function toNeedsHuman(err: unknown): NeedsHumanError | null {
  const msg = err instanceof Error ? err.message : String(err);
  if (SEAT_FALLBACK_DEATH.test(msg)) {
    return new NeedsHumanError("seat_fallback_exhausted", msg);
  }
  if (DECIDER_PARSE_DEATH.test(msg)) {
    return new NeedsHumanError("decider_parse_incomplete", msg);
  }
  return null;
}

export type NeedsHumanEvent = {
  ts: string;
  agent: "system";
  level: "warn";
  message: string;
  data: { needs_human: true; reason: NeedsHumanReason; receipts: string[] };
};

/** 發 needs_human 事件：job events.jsonl＋ep events.jsonl（A4 同一行兩處，
 *  store.emit 同款形狀），唔掂 job.json。返發出嘅事件。 */
export function emitNeedsHuman(
  jobId: string,
  opts: { reason: NeedsHumanReason; receipts?: string[]; slate?: string; jobsDir?: string; projectsRoot?: string; ts?: string },
): NeedsHumanEvent {
  const jobsDir = opts.jobsDir ?? path.join(process.cwd(), "data", "jobs");
  const dir = path.join(jobsDir, jobId);
  if (!fs.existsSync(dir)) {
    throw new Error(`emitNeedsHuman: job dir 唔存在：${dir}`);
  }
  let slate = opts.slate;
  if (!slate) {
    const jobFile = path.join(dir, "job.json");
    if (fs.existsSync(jobFile)) {
      try {
        slate = (JSON.parse(fs.readFileSync(jobFile, "utf8")) as { slate?: string }).slate;
      } catch {
        // job.json 爛：照發 job log，ep log 略過
      }
    }
  }
  const event: NeedsHumanEvent = {
    ts: opts.ts ?? new Date().toISOString(),
    agent: "system",
    level: "warn",
    message: `needs_human: ${opts.reason}`,
    data: { needs_human: true, reason: opts.reason, receipts: opts.receipts ?? [] },
  };
  const line = `${JSON.stringify(event)}\n`;
  fs.appendFileSync(path.join(dir, "events.jsonl"), line);
  if (slate) {
    const epFile = path.join(opts.projectsRoot ?? projectsDir(), slate, "events.jsonl");
    fs.mkdirSync(path.dirname(epFile), { recursive: true });
    fs.appendFileSync(epFile, line);
  }
  return event;
}

/** 一站出口：認死法，認得出就發事件再重 throw（NeedsHumanError，reason 喺
 *  上面）；認唔出原樣重 throw。caller 只需 `catch (e) { rethrowNeedsHuman(jobId, e) }`。 */
export function rethrowNeedsHuman(
  jobId: string,
  err: unknown,
  opts?: { slate?: string; jobsDir?: string; projectsRoot?: string },
): never {
  const nh = toNeedsHuman(err);
  if (nh) {
    emitNeedsHuman(jobId, { reason: nh.reason, receipts: [nh.original.slice(0, 300)], ...opts });
    throw nh;
  }
  throw err instanceof Error ? err : new Error(String(err));
}
