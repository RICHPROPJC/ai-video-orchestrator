import { NextResponse } from "next/server";
import { readJob } from "@/lib/studio/store";
import { readSession } from "@/lib/studio/pipeline/session";

export const runtime = "nodejs";

/** SC-UI-SESSION-0928-P33 A2（B33 shape）：GET history——零副作用（頁面
 *  mount／切項目／poll 唔提交任何嘢——§33-9）。舊 job 無聊天→
 *  missingHistory:"no-prior-chat"（原 ID/brief/產物/manifest 保留，唔假稱
 *  已匯入舊聊天）。 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!readJob(id)) {
    return NextResponse.json({ error: `unknown-slate:${id}`, detail: "呢個 ID 冇 job——唔會 fallback 去新建" }, { status: 404 });
  }
  const session = readSession(id);
  return NextResponse.json({
    sessionId: session.sessionId,
    jobId: session.jobId,
    createdAt: session.createdAt,
    turns: session.turns.map((t) => ({
      turnId: t.turnId, at: t.at, requestId: t.requestId, role: t.role,
      text: t.text, status: t.status,
      ...(t.adoption ? { adoption: t.adoption } : {}),
      ...(t.blockedReason ? { blockedReason: t.blockedReason } : {}),
    })),
    ...(session.missingHistory ? { missingHistory: session.missingHistory } : {}),
  });
}
