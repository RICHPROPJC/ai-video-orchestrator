"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/** B33 shape（A→Album 契約）嘅 turn/history 型別。 */
type Turn = {
  turnId: string;
  at: string;
  requestId: string;
  role: "user" | "assistant";
  text: string;
  status: string;
  /** R2：assistant turn 嘅回覆來源——job-facts-fallback＝自動回覆（LLM fail 誠實降級），seat＝席答。 */
  replySource?: string;
  adoptedRef?: string;
  blockedReason?: string;
};
type SessionState = {
  sessionId: string;
  jobId: string;
  createdAt: string;
  turns: Turn[];
  missingHistory?: string;
} | null;

/** P33 §9 狀態詞——均以 consumer 回執為準，UI 淨係翻譯，唔自行推斷。 */
const STATUS_NOTE: Record<string, string> = {
  recorded: "已記錄——等採納",
  pending: "待處理",
  "queued-behind-owner": "排隊中——活躍 owner 喺安全點採納",
  adopted: "已採納——新 revision",
  executing: "執行中",
  blocked: "被阻塞",
  delivered: "已交付",
};

/** 同項目持久對話面板（B33：GET /session 讀 history＋POST /session/turns
 *  ask／revise，requestId 冪等重送；missingHistory=no-prior-chat 照實講，
 *  唔假稱匯入舊聊天）。API 未接通／失敗一律具名，唔 fake 採納。 */
export function SessionPanel({ jobId }: { jobId: string }) {
  const [st, setSt] = useState<SessionState>(null);
  const [err, setErr] = useState("");
  const [text, setText] = useState("");
  const [intent, setIntent] = useState<"ask" | "revise">("ask");
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState("");
  const [failedReq, setFailedReq] = useState("");
  const lastReq = useRef("");

  const reload = useCallback(() => {
    void fetch(`/api/jobs/${jobId}/session`, { cache: "no-store" })
      .then(async (r) => ({ ok: r.ok, body: r.ok ? ((await r.json()) as SessionState) : null }))
      .then((x) => {
        if (x.ok && x.body) {
          setSt(x.body);
          setErr("");
        } else {
          setSt(null);
          setErr("尚未接通：session API（A 側 A2 sessions 持久）");
        }
      })
      .catch(() => setErr("session API 讀取失敗"));
  }, [jobId]);

  useEffect(() => {
    reload();
  }, [reload]);

  /** 送 turn：requestId 冪等——重送同一 requestId 返原 turn，唔重複採納。 */
  const send = (requestId?: string) => {
    if (!text.trim() || sending) return;
    setSending(true);
    setNote("");
    const rid = requestId ?? crypto.randomUUID();
    lastReq.current = rid;
    setFailedReq("");
    void fetch(`/api/jobs/${jobId}/session/turns`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ requestId: rid, text, intent }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as {
          turnId: string;
          status: string;
          queued?: string;
          reply?: { turnId: string; at: string; text: string; replySource: string } | { error: string };
          blockedReason?: string;
          adoption?: { adoptedRef: string; revision: string; affectedScope: string };
        };
      })
      .then((res) => {
        setText("");
        setFailedReq("");
        const replyNote = !res.reply
          ? " —— 未有回覆文字（等 consumer）"
          : "error" in res.reply
            ? ` —— ask 回覆未有：${res.reply.error}`
            : "";
        const replyText = res.reply && !("error" in res.reply) ? res.reply.text : "";
        setNote(
          `${STATUS_NOTE[res.status] ?? res.status}` +
            (res.queued ? ` · ${res.queued}` : "") +
            (res.adoption ? ` · 採納 ${res.adoption.adoptedRef}@r${res.adoption.revision}（${res.adoption.affectedScope}）` : "") +
            (res.blockedReason ? ` · ${res.blockedReason}` : "") +
            replyNote +
            (replyText ? `｜答：${replyText}${res.reply && !("error" in res.reply) && res.reply.replySource === "job-facts-fallback" ? "（自動回覆）" : ""}` : ""),
        );
        reload();
      })
      .catch((e: unknown) => {
        setFailedReq(rid);
        setNote(`送出失敗（${e instanceof Error ? e.message : "error"}）——可重送同一 requestId，唔會重複採納`);
      })
      .finally(() => setSending(false));
  };

  return (
    <div className="rounded-lg border border-border p-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">💬 同呢個項目對話</span>
        <span className="truncate text-[10px] text-muted-foreground">
          {st ? `session ${st.sessionId.slice(0, 18)} · ${st.turns.length} turns` : err || "讀緊…"}
        </span>
      </div>
      {st?.missingHistory === "no-prior-chat" ? (
        <p className="mt-1 rounded border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground">
          舊項目冇聊天記錄——用原 ID／brief 開同項目對話；唔會假稱已匯入舊聊天。
        </p>
      ) : null}
      {st?.turns.length ? (
        <div className="mt-1 max-h-40 space-y-1 overflow-y-auto">
          {st.turns.map((t) => (
            <p key={t.turnId} className={t.role === "user" ? "text-foreground" : "text-muted-foreground"}>
              <span className="font-mono text-[10px] opacity-70">
                {t.at ? `${t.at.slice(11, 16)} ` : ""}
                {t.role === "user" ? "你" : `答${t.replySource === "job-facts-fallback" ? "（自動回覆）" : t.replySource === "seat" ? "（席）" : ""}`} · {STATUS_NOTE[t.status] ?? t.status}
                {t.adoptedRef ? ` · ${t.adoptedRef}` : ""}
                {t.blockedReason ? ` · ${t.blockedReason}` : ""}
              </span>
              <br />
              {t.text}
            </p>
          ))}
        </div>
      ) : null}
      <div className="mt-2 flex gap-1">
        <select
          value={intent}
          onChange={(e) => setIntent(e.target.value === "revise" ? "revise" : "ask")}
          className="rounded border border-border bg-background px-1 py-1 text-[11px]"
          aria-label="意圖"
        >
          <option value="ask">問（淨答）</option>
          <option value="revise">改（入修訂流程）</option>
        </select>
        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="同一 session 續傾——問嘢或者要求修改"
          className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1"
          onKeyDown={(e) => {
            if (e.key === "Enter") send();
          }}
        />
        <button
          type="button"
          onClick={() => send()}
          disabled={!text.trim() || sending}
          className="shrink-0 rounded border border-primary px-2 py-1 text-primary disabled:opacity-40"
        >
          {sending ? "送緊…" : "送出"}
        </button>
        {failedReq ? (
          <button
            type="button"
            onClick={() => send(failedReq)}
            disabled={sending}
            className="shrink-0 rounded border border-border px-2 py-1 disabled:opacity-40"
          >
            重送
          </button>
        ) : null}
      </div>
      {note ? <p className="mt-1 text-[10px] text-muted-foreground">{note}</p> : null}
    </div>
  );
}
