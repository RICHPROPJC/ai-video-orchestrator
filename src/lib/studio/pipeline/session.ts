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
   *  採納基礎；A3 consumer 對唔到＝stale 具名）。
   *  root R5 修②（0928）：typed observed state 隨 turn 落盤——invalid 同
   *  missing 唔壓埋 null；consumer 對照「當初 state」（當初 invalid 即使後來
   *  修好 valid 都唔默認首創採納）；digestSchema 版本欄（公式唔同比唔到
   *  具名）。legacy turn 缺 state＝unknown 具名，唔猜 missing。 */
  dependsOn?: {
    callsheetDigest?: string | null;
    callsheetState?: "valid" | "missing" | "invalid";
    digestSchema?: string;
    creativeRevision?: number | null;
  };
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
  // root R2 修④：行 mutateJob（檔鎖＋CAS 語義）——route 同 producer 併發改
  // pendingReviseTurns 唔互吞；取代裸 readJob→writeJob 整檔。
  const { mutateJob } = require("../store") as typeof import("../store");
  mutateJob(jobId, (job) => {
    job.pendingReviseTurns = [...new Set([...(job.pendingReviseTurns ?? []), turnId])];
  });
}

/** root R3 修③＋R4 修③（0928）：採納基準 digest 同源 helper（typed 三態）
 *  ——兩側共用「當下磁碟 callsheet.json 全文 sheetDigest」。三態語義（root
 *  R4 裁決）：valid＝正常對比；missing＝真係冇 callsheet（首創採納唯一合法
 *  例外）；invalid＝檔在但 parse 壞——採納基礎不可讀，唔可以同 missing 撈
 *  埋當 null 靜靜首創。job.callsheetDigest 欄（world 段寫）維持 mux 契約
 *  用途，唔係呢條鏈真源。 */
export type CallsheetDigestState = { kind: "valid"; digest: string } | { kind: "missing" } | { kind: "invalid"; detail: string };

export function currentCallsheetDigestState(jobId: string): CallsheetDigestState {
  const file = path.join(jobDir(jobId), "callsheet.json");
  if (!fs.existsSync(file)) return { kind: "missing" };
  try {
    const { loadCallSheet } = require("../writer") as typeof import("../writer");
    const { sheetDigest } = require("../seat-boards") as typeof import("../seat-boards");
    return { kind: "valid", digest: sheetDigest(loadCallSheet(file)) };
  } catch (e) {
    return { kind: "invalid", detail: (e as Error).message.slice(0, 120) };
  }
}

/** digest 計法版本欄（route 落盤／consumer 對照共用；改公式＝新版本號，
 *  舊 turn 值比唔到會具名 stale 唔靜靚食）。 */
export const DIGEST_SCHEMA = "sheetDigest-v1";

export function reviseTurnTextsOf(jobId: string, digestState: CallsheetDigestState): { adopt: { turnId: string; text: string }[]; stale: { turnId: string; reason: string }[] } {
  const session = readSession(jobId);
  const adopt: { turnId: string; text: string }[] = [];
  const stale: { turnId: string; reason: string }[] = [];
  const { readJob } = require("../store") as typeof import("../store");
  const pending = readJob(jobId)?.pendingReviseTurns ?? [];
  for (const turnId of pending) {
    const t = session.turns.find((x) => x.turnId === turnId);
    if (!t) { stale.push({ turnId, reason: "turn 唔喺 sessions.jsonl（數據源斷）" }); continue; }
    // root R4 修③：legacy turn 冇 dependsOn 資訊＝採納基礎未知——具名唔靜默 adopt
    if (!t.dependsOn) { stale.push({ turnId, reason: "legacy turn 無 dependsOn 資訊（採納基礎未知）——重交對話修訂" }); continue; }
    const dep = t.dependsOn;
    // root R5 修②：schema 版本唔同＝比唔到，具名（唔靜靚食）
    if (dep.digestSchema !== undefined && dep.digestSchema !== DIGEST_SCHEMA) {
      stale.push({ turnId, reason: `stale：turn digest schema（${dep.digestSchema}）對唔上現行（${DIGEST_SCHEMA}）——比唔到，重交` });
      continue;
    }
    // 當下 invalid＝基礎而家不可讀，全部唔採納
    if (digestState.kind === "invalid") {
      stale.push({ turnId, reason: `stale：磁碟 callsheet 壞（${digestState.detail}）——採納基礎不可讀，重交` });
      continue;
    }
    if (dep.callsheetState === "invalid") {
      // root R5 修②：當初 invalid＝基礎當初不可讀——唔採納（即使後來修好
      // valid 都唔默認首創）；要用戶修好後重交先採納
      stale.push({ turnId, reason: "stale：turn 觀察時 callsheet invalid（採納基礎當初不可讀）——修好後重交先採納" });
      continue;
    }
    if (dep.callsheetState === "missing") {
      // 當初真 missing＝首創語義：而家 valid→採納落現行；而家 missing→兩邊未有同樣合法
      adopt.push({ turnId, text: t.text });
      continue;
    }
    // R4 期 turn：dependsOn 有 callsheetDigest 但冇 callsheetState——真值（route
    // 只在 valid 時寫真值）照比；null＝missing/invalid 當初壓埋＝unknown 具名
    // （root R5：唔猜 missing，唔靜靜首創）
    if (dep.callsheetState === undefined && dep.callsheetDigest == null) {
      stale.push({ turnId, reason: "stale：turn 觀察 state 缺席（null 壓埋，unknown——唔猜 missing）——重交" });
      continue;
    }
    if (dep.callsheetState === "valid" && dep.callsheetDigest == null) {
      stale.push({ turnId, reason: "stale：turn 標 valid 但冇 digest（數據矛盾）——重交" });
      continue;
    }
    const turnDigest = dep.callsheetDigest ?? null;
    if (turnDigest === null) {
      stale.push({ turnId, reason: "stale：turn 冇有效 digest（unknown）——重交" });
      continue;
    }
    if (digestState.kind === "missing") {
      stale.push({ turnId, reason: `stale：turn 綁 digest ${turnDigest.slice(0, 12)} 但磁碟 callsheet 唔在——採納基礎消失，重交` });
      continue;
    }
    if (turnDigest !== digestState.digest) {
      stale.push({ turnId, reason: `stale：turn 綁 digest ${turnDigest.slice(0, 12)} 對本輪 ${digestState.digest.slice(0, 12)} 唔夾——重交修訂唔靜靚食` });
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
  // root R2 修④：清 queue 行 mutateJob（檔鎖）——同 route 側 queueReviseTurn
  // 併發唔互吞（producer complete 同時 route 新 turn 入隊）。
  const { mutateJob } = require("../store") as typeof import("../store");
  const processed = [...adopted.map((a) => a.turnId), ...staleOut.map((a) => a.turnId)];
  mutateJob(jobId, (job) => {
    job.pendingReviseTurns = (job.pendingReviseTurns ?? []).filter((id) => !processed.includes(id));
  });
}

/** §P33 A3 ask reply consumer（0928）：ask turn 唔再淨 recorded——生文字回覆
 *  （assistant turn）。誠實邊界：回覆只講 job facts＋session 近況，唔扮執行
 *  （想改嘢＝intent=revise 條路）。LLM 席 fail 唔殺會話——fallback 用 job
 *  facts 組裝（replySource 具名，UI 唔當席答）。細席模型（flash 級，同
 *  world-sizes 一族）過 crew deny 閘。 */
const ASK_REPLY_CHARTER = `你係製作台（SlateCrew）嘅會話回覆席。用戶喺同一條片（job）嘅持久 session 問問題，你負責文字回覆。
規則：
1. 只根據提供嘅 job facts 同 session 近況作答；facts 冇嘅嘢就話「我呢度冇資料」，唔好作。
2. 唔好扮任何嘢已經執行：你唔會改 plan、唔會觸發 produce、唔會開 generation。用戶想改嘢→叫佢清楚講出要改咩，用「要求修改」重交（嗰條路先入採納佇列）；唔好向用戶露出內部參數／實作字眼。
3. 語言跟用戶問題嘅語言（用戶中文你中文，英文你英文）。
4. 一至三句答完，直接有用，唔兜圈。`;

const askReplySchema = z.object({ reply: z.string().min(4) });

/** root R11-4（0928）：ask 雲端硬預算常數——超即唔再 call（誠實 fallback）。
 *  calls 閘任何情況有效；token 閘淨 provider usage 有回填先計（tokenCounted）。 */
export const ASK_BUDGET = { maxCalls: 16, maxTokens: 40_000 } as const;

/** 讀 receipts 檔 usage 加總（chatJsonSeat 回傳檔 paths；usage 缺失回 null） */
function sumReceiptUsage(receiptFiles: string[]): { tokens: number; anyUsage: boolean } {
  let tokens = 0; let anyUsage = false;
  for (const f of receiptFiles) {
    try {
      const r = JSON.parse(fs.readFileSync(f, "utf8")) as { usage?: { total_tokens?: number } };
      if (r.usage?.total_tokens !== undefined) { tokens += r.usage.total_tokens; anyUsage = true; }
    } catch { /* 壞檔＝唔計（calls 閘兜底） */ }
  }
  return { tokens, anyUsage };
}

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
  // R11-4 前置硬閘：跨 asks 累計（job.askUsage）超 calls/token 即唔 call
  const { mutateJob } = require("../store") as typeof import("../store");
  try {
    const used = readJobBudget(jobId);
    if (used.calls >= ASK_BUDGET.maxCalls || (used.tokenCounted && used.tokens >= ASK_BUDGET.maxTokens)) {
      text = `（ask 雲端預算用盡——唔再 call 模型；如實現況）job ${facts.status}${facts.currentAgent ? `，當前席位 ${facts.currentAgent}` : ""}。你嘅問題已記錄（turn ${userTurn.turnId}）；預算：${used.calls}/${ASK_BUDGET.maxCalls} calls${used.tokenCounted ? `、${used.tokens}/${ASK_BUDGET.maxTokens} tokens` : "（token 無回填——淨 call 閘生效）"}。`;
      const turn0 = appendTurn(jobId, {
        requestId: `${userTurn.requestId}:reply`, role: "assistant", text, status: "recorded",
        ...(userTurn.dependsOn ? { dependsOn: userTurn.dependsOn } : {}),
        replySource: "job-facts-fallback",
      });
      return { turn: turn0, replySource: "job-facts-fallback" };
    }
  } catch { /* 讀 budget 失敗＝保守照 call（calls 閘喺後置對賬補） */ }
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
    // R11-4 後置對賬：receipts usage 加總落 job（跨 asks 累計）
    try {
      const summed = sumReceiptUsage(pass.receipts.map((f) => path.join(io.receiptDir, f)));
      const prev = readJobBudget(jobId);
      mutateJob(jobId, (j) => {
        j.askUsage = {
          calls: prev.calls + pass.receipts.length,
          tokens: prev.tokens + summed.tokens,
          tokenCounted: prev.tokenCounted || summed.anyUsage,
        };
      });
    } catch { /* 對賬失敗＝calls 閘下次前置照讀舊值（保守） */ }
  } catch {
    // LLM 唔係 ask 回覆嘅硬依賴——fail 落誠實現況組裝（唔扮答到）
    text = `（回覆席暫時唔在場——如實現況）job ${facts.status}${facts.currentAgent ? `，當前席位 ${facts.currentAgent}` : ""}${typeof facts.progress === "number" ? `，進度 ${facts.progress}%` : ""}${facts.error ? `；最後錯誤：${facts.error}` : ""}。你嘅問題已記錄（turn ${userTurn.turnId}）；要改嘢請清楚講出修改要求，用「要求修改」重交。`;
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

/** R11-4：讀 job.askUsage（缺欄＝零用過） */
function readJobBudget(jobId: string): { calls: number; tokens: number; tokenCounted: boolean } {
  const { readJob } = require("../store") as typeof import("../store");
  const j = readJob(jobId);
  return j?.askUsage ?? { calls: 0, tokens: 0, tokenCounted: false };
}
