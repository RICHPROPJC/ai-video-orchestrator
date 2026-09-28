import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
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
    if (turns.length) createdAt = turns[0]!.at;
    return { sessionId, jobId, createdAt, turns };
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
