"use client";

import { useState } from "react";

/** Chau 0927：「the web … i cant 參與 if i found problems」——UI 報問題渠道。
 *  提交 → POST /api/feedback → job 側 FEEDBACK.jsonl → A 側 monitor 實時收。 */
export function FeedbackForm({ jobId, shotId, preset }: { jobId: string; shotId?: string; preset?: string }) {
  const [text, setText] = useState(preset ?? "");
  const [sent, setSent] = useState<"idle" | "sending" | "done" | "fail">("idle");
  return (
    <form
      className="flex w-full flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!text.trim()) return;
        setSent("sending");
        void fetch("/api/feedback", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jobId, shotId: shotId ?? null, text }),
        })
          .then((r) => (r.ok ? setSent("done") : setSent("fail")))
          .catch(() => setSent("fail"));
      }}
    >
      {shotId ? <p className="text-amber-300">🚩 報問題（{shotId}）</p> : null}
      <textarea
        className="min-h-16 w-full rounded bg-black/60 p-2 text-sm text-white outline-none ring-1 ring-neutral-700 focus:ring-amber-500"
        placeholder={shotId ? `例：${shotId} 手唔似握樽頸／檸檬片太密／面走樣` : "例：SH07 檸檬片太密；SH01 樽變咗杯"}
        value={text}
        onChange={(e) => { setText(e.target.value); setSent("idle"); }}
      />
      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={!text.trim() || sent === "sending"}
          className="rounded bg-amber-600 px-3 py-1.5 text-xs font-medium text-black disabled:opacity-40"
        >
          {sent === "sending" ? "提交中…" : "提交"}
        </button>
        {sent === "done" ? <span className="text-xs text-emerald-400">已收到（FEEDBACK.jsonl）——Claude 實時收</span> : null}
        {sent === "fail" ? <span className="text-xs text-red-400">提交失敗——直接喺 terminal 講都得</span> : null}
      </div>
    </form>
  );
}

/** 全域版：揀鏡號（或唔揀）再報。 */
export function ShotFeedback({ jobId, shots }: { jobId: string; shots: string[] }) {
  const [shot, setShot] = useState("");
  return (
    <div className="flex flex-col gap-2 pt-2">
      <div className="flex items-center gap-2">
        <label className="text-neutral-400" htmlFor="fb-shot">鏡號</label>
        <select
          id="fb-shot"
          className="rounded bg-black/60 p-1 text-sm text-white ring-1 ring-neutral-700"
          value={shot}
          onChange={(e) => setShot(e.target.value)}
        >
          <option value="">（唔指定／整體）</option>
          {shots.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
      <FeedbackForm jobId={jobId} shotId={shot || undefined} />
    </div>
  );
}
