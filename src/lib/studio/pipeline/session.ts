import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { chatJsonSeat, type CrewConfig } from "../crew-llm";
import { jobDir } from "../paths";

/** SC-UI-SESSION-0928-P33 A2（§33-5/6）：同項目持久對話身份＋turn 落盤。
 *  一 job 一 session（sessionId 穩定衍生）；turn 逐條 append jsonl（不鎖檔
 *  原子性靠單行 write＋appendFileSync）。舊 job 無聊天記錄＝照開 session＋
 *  missingHistory 具名——原 ID/brief/產物/creative manifest 全保留，唔假稱
 *  已匯入舊 Orca 聊天（§33-5）。歷史 full 保留（模型上下文按資源選取係
 *  consumer 嘅事——A3）。 */

export type SessionTurn = {
  turnId: string;
  sessionId: string;
  jobId: string;
  at: string;
  requestId: string;
  role: "user" | "assistant";
  text: string;
  status: "recorded" | "queued-behind-owner" | "adopted" | "blocked";
  /** turn 觀察到嘅依賴 revision（callsheetDigest／creative manifest 版本——綁
   *  採納基礎；A3 consumer 對唔到＝stale 具名） */
  dependsOn?: { callsheetDigest?: string | null; creativeRevision?: number | null };
  adoption?: { adoptedRef: string; revision: string; affectedScope: string };
  blockedReason?: string;
  /** assistant ask 回覆來源（LLM 席 vs job-facts fallback——誠實分層，UI 唔
   *  將 fallback 當席答） */
  replySource?: "seat" | "job-facts-fallback";
};

export type SlateSession = {
  sessionId: string;
  jobId: string;
  createdAt: string;
  turns: SessionTurn[];
  missingHistory?: "no-prior-chat";
};

const sessionFile = (jobId: string) => path.join(jobDir(jobId), "sessions.jsonl");

export function sessionIdOf(jobId: string): string {
  return `sess-${jobId}`;
}

export function readSession(jobId: string): SlateSession {
  const sessionId = sessionIdOf(jobId);
  const file = sessionFile(jobId);
  const turns: SessionTurn[] = [];
  let createdAt = new Date().toISOString();
  if (fs.existsSync(file)) {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        turns.push(JSON.parse(t) as SessionTurn);
      } catch {
        /* 壞行跳過——jsonl append 單行原子，壞行＝歷史證據問題唔靜靚剷 */
      }
    }
    // root 競態修④（並行寫入）：status 更新以 append 補償行表達（同一
    // turnId 多行＝last-wins）——讀側 dedupe；歷史行原樣保留（證據不覆寫）
    const byId = new Map<string, SessionTurn>();
    for (const t of turns) byId.set(t.turnId, t);
    const dedup = [...byId.values()];
    if (dedup.length) createdAt = dedup.find((t) => t.role === "user")?.at ?? dedup[0]!.at;
    return { sessionId, jobId, createdAt, turns: dedup };
  }
  // 舊 job 無聊天：照開 session（identity 持久）＋missingHistory 具名
  return { sessionId, jobId, createdAt, turns, missingHistory: "no-prior-chat" };
}

/** 冪等：同 requestId 已有 user turn→返佢（唔重複採納/派工——§33-6） */
export function findUserTurnByRequestId(jobId: string, requestId: string): SessionTurn | null {
  if (!requestId) return null;
  return readSession(jobId).turns.find((t) => t.requestId === requestId && t.role === "user") ?? null;
}

export function appendTurn(jobId: string, turn: Omit<SessionTurn, "turnId" | "sessionId" | "jobId" | "at"> & { turnId?: string; at?: string }): SessionTurn {
  const full: SessionTurn = {
    turnId: turn.turnId ?? `t${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`,
    sessionId: sessionIdOf(jobId),
    jobId,
    at: turn.at ?? new Date().toISOString(),
    ...turn,
  };
  fs.mkdirSync(jobDir(jobId), { recursive: true });
  fs.appendFileSync(sessionFile(jobId), JSON.stringify(full) + "\n");
  return full;
}


/** §P33 A3/A4（0928）：revise turn 採納鏈——turn 落盤後入 job pendingReviseTurns
 *  佇列；pipeline 喺 owner 安全點（author 段開頭，owner 已 acquire）讀佇列：
 *  dependsOn.callsheetDigest 對得上 ctx＝採納（revise hint 帶 user text），
 *  唔夾＝stale 具名；修訂完成後 completeAdoptedTurns 回寫 adopted＋adoption。
 *  runtime 觸發照舊 produce 邊界——本鏈淨接線，唔自行開 LLM。 */
export function queueReviseTurn(jobId: string, turnId: string): void {
  const { readJob, writeJob } = require("../store") as typeof import("../store");
  const job = readJob(jobId);
  if (!job) return;
  const next = [...new Set([...(job.pendingReviseTurns ?? []), turnId])];
  writeJob({ ...job, pendingReviseTurns: next });
}

export function reviseTurnTextsOf(jobId: string, callsheetDigest: string | null | undefined): { adopt: { turnId: string; text: string }[]; stale: { turnId: string; reason: string }[] } {
  const session = readSession(jobId);
  const adopt: { turnId: string; text: string }[] = [];
  const stale: { turnId: string; reason: string }[] = [];
  const { readJob } = require("../store") as typeof import("../store");
  const pending = readJob(jobId)?.pendingReviseTurns ?? [];
  for (const turnId of pending) {
    const t = session.turns.find((x) => x.turnId === turnId);
    if (!t) { stale.push({ turnId, reason: "turn 唔喺 sessions.jsonl（數據源斷）" }); continue; }
    if (t.dependsOn?.callsheetDigest && callsheetDigest && t.dependsOn.callsheetDigest !== callsheetDigest) {
      stale.push({ turnId, reason: `stale：turn 綁 digest ${t.dependsOn.callsheetDigest.slice(0, 12)} 對本輪 ${callsheetDigest.slice(0, 12)} 唔夾——重交修訂唔靜靚食` });
      continue;
    }
    adopt.push({ turnId, text: t.text });
  }
  return { adopt, stale };
}

export function completeAdoptedTurns(jobId: string, adopted: { turnId: string; adoptedRef: string; revision: string; affectedScope: string }[], staleOut: { turnId: string; reason: string }[]): void {
  // root 競態修③④：①status 更新＝append 補償行（readSession last-wins），
  // 唔重寫全檔——同時併行 append 嘅新 turn 唔會被吞，歷史行原樣保留；
  // ②清 queue 淨清本輪處理嘅 turnId——採納快照之後先入隊嘅後到 turn
  // 保留落下一輪（凍結批次），唔 blanket 清空。
  const session = readSession(jobId);
  const comp: string[] = [];
  for (const t of session.turns) {
    const hit = adopted.find((a) => a.turnId === t.turnId);
    if (hit) comp.push(JSON.stringify({ ...t, status: "adopted" as const, adoption: { adoptedRef: hit.adoptedRef, revision: hit.revision, affectedScope: hit.affectedScope } }));
    const st = staleOut.find((a) => a.turnId === t.turnId);
    if (st) comp.push(JSON.stringify({ ...t, status: "blocked" as const, blockedReason: st.reason }));
  }
  if (comp.length) fs.appendFileSync(sessionFile(jobId), comp.join("\n") + "\n");
  const { readJob, writeJob } = require("../store") as typeof import("../store");
  const job = readJob(jobId);
  const processed = [...adopted.map((a) => a.turnId), ...staleOut.map((a) => a.turnId)];
  if (job) writeJob({ ...job, pendingReviseTurns: (job.pendingReviseTurns ?? []).filter((id) => !processed.includes(id)) });
}

/** §P33 A3 ask reply consumer（0928）：ask turn 唔再淨 recorded——生文字回覆
 *  （assistant turn）。誠實邊界：回覆只講 job facts＋session 近況，唔扮執行
 *  （想改嘢＝intent=revise 條路）。LLM 席 fail 唔殺會話——fallback 用 job
 *  facts 組裝（replySource 具名，UI 唔當席答）。細席模型（flash 級，同
 *  world-sizes 一族）過 crew deny 閘。 */
const ASK_REPLY_CHARTER = `你係製作台（SlateCrew）嘅會話回覆席。用戶喺同一條片（job）嘅持久 session 問問題，你負責文字回覆。
規則：
1. 只根據提供嘅 job facts 同 session 近況作答；facts 冇嘅嘢就話「我呢度冇資料」，唔好作。
2. 唔好扮任何嘢已經執行：你唔會改 plan、唔會觸發 produce、唔會開 generation。用戶想改嘢→叫佢交 intent=revise（嗰條路先入採納佇列）。
3. 語言跟用戶問題嘅語言（用戶中文你中文，英文你英文）。
4. 一至三句答完，直接有用，唔兜圈。`;

const askReplySchema = z.object({ reply: z.string().min(4) });

export async function replyToAskTurn(
  jobId: string,
  job: { status?: string; progress?: number; currentAgent?: string; error?: string | null; callsheetDigest?: string; outputs?: Record<string, unknown> },
  userTurn: SessionTurn,
  io: { model: string; crew: CrewConfig; receiptDir: string; fallbackModel?: string },
): Promise<{ turn: SessionTurn; replySource: "seat" | "job-facts-fallback" }> {
  const facts = {
    jobId,
    status: job.status ?? "unknown",
    ...(typeof job.progress === "number" ? { progress: job.progress } : {}),
    ...(job.currentAgent ? { currentAgent: job.currentAgent } : {}),
    ...(job.error ? { error: String(job.error).slice(0, 200) } : {}),
    ...(job.callsheetDigest ? { callsheetDigest: job.callsheetDigest } : {}),
    outputKeys: Object.keys(job.outputs ?? {}),
  };
  const recent = readSession(jobId).turns.slice(-6).map((t) => ({ role: t.role, text: t.text.slice(0, 300) }));
  let text: string;
  let replySource: "seat" | "job-facts-fallback" = "job-facts-fallback";
  try {
    const pass = await chatJsonSeat({
      seat: "producer",
      unit: "session-ask-reply",
      model: io.model,
      crew: io.crew,
      receiptDir: io.receiptDir,
      ...(io.fallbackModel ? { fallbackModel: io.fallbackModel } : {}),
      system: ASK_REPLY_CHARTER,
      user: JSON.stringify({ job: facts, session_recent: recent, user_question: userTurn.text }),
      schema: askReplySchema,
    });
    text = pass.value.reply;
    replySource = "seat";
  } catch {
    // LLM 唔係 ask 回覆嘅硬依賴——fail 落誠實現況組裝（唔扮答到）
    text = `（回覆席暫時唔在場——如實現況）job ${facts.status}${facts.currentAgent ? `，當前席位 ${facts.currentAgent}` : ""}${typeof facts.progress === "number" ? `，進度 ${facts.progress}%` : ""}${facts.error ? `；最後錯誤：${facts.error}` : ""}。你嘅問題已記錄（turn ${userTurn.turnId}）；要改嘢請用 intent=revise 重交。`;
  }
  const turn = appendTurn(jobId, {
    requestId: `${userTurn.requestId}:reply`,
    role: "assistant",
    text,
    status: "recorded",
    ...(userTurn.dependsOn ? { dependsOn: userTurn.dependsOn } : {}),
    replySource,
  });
  return { turn, replySource };
}
