import { NextResponse } from "next/server";
import { readJob } from "@/lib/studio/store";
import { ownerHeartbeatMs, ownerIsStale } from "@/lib/studio/store";
import { appendTurn, findUserTurnByRequestId } from "@/lib/studio/pipeline/session";

export const runtime = "nodejs";

/** SC-UI-SESSION-0928-P33 A2（§33-6/8）：POST turn——requestId 冪等（重送返
 *  原 turn 唔重複採納/派工）；intent=ask→recorded（A3 consumer 答問題）；
 *  intent=revise→活躍 owner 在場＝queued-behind-owner（綁觀察 revision，owner
 *  安全點採納——A4），冇 owner＝recorded 待 A3 revise consumer。
 *  會話與生成能力分開（§33-7）：呢度唔設 fleet 前置。 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) {
    return NextResponse.json({ error: `unknown-slate:${id}`, detail: "呢個 ID 冇 job——唔會 fallback 去新建" }, { status: 404 });
  }
  const body = await req.json().catch(() => null) as { requestId?: string; text?: string; intent?: "ask" | "revise" } | null;
  if (!body?.text?.trim() || !body.requestId) {
    return NextResponse.json({ error: "bad-request", detail: "要 requestId＋text" }, { status: 400 });
  }
  const intent = body.intent === "revise" ? "revise" : "ask";

  // 冪等：同 requestId 已有 user turn→返原結果（零新副作用）
  const existing = findUserTurnByRequestId(id, body.requestId);
  if (existing) {
    return NextResponse.json({ turnId: existing.turnId, at: existing.at, status: existing.status, idempotent: true,
      ...(existing.adoption ? { adoption: existing.adoption } : {}), ...(existing.blockedReason ? { blockedReason: existing.blockedReason } : {}) });
  }

  const ms = ownerHeartbeatMs(id);
  const ownerActive = ms !== null && !ownerIsStale(id);
  if (intent === "revise" && ownerActive) {
    // §33-8：有活躍 owner 時修改 turn 持久排隊，綁觀察到嘅 source revision
    const turn = appendTurn(id, {
      requestId: body.requestId, role: "user", text: body.text,
      status: "queued-behind-owner",
      dependsOn: { callsheetDigest: (job as { callsheetDigest?: string }).callsheetDigest ?? null },
      blockedReason: `活躍執行者（heartbeat ${ms}ms 前）——turn 已持久排隊，owner 安全點採納（A4 consumer 未接：狀態如實，唔顯示執行中）`,
    });
    return NextResponse.json({ turnId: turn.turnId, at: turn.at, status: "queued-behind-owner", dependsOn: turn.dependsOn });
  }

  const turn = appendTurn(id, {
    requestId: body.requestId, role: "user", text: body.text,
    status: "recorded",
    dependsOn: { callsheetDigest: (job as { callsheetDigest?: string }).callsheetDigest ?? null },
    ...(intent === "revise" ? { blockedReason: "revise consumer（A3）未接——如實 recorded，唔顯示執行中" } : {}),
  });
  return NextResponse.json({ turnId: turn.turnId, at: turn.at, status: "recorded", intent,
    ...(intent === "revise" ? { pending: "A3 revise consumer 未接——採納/執行迴路下一批" } : { note: "ask 回覆 consumer（A3）未接——已記錄" }) });
}
