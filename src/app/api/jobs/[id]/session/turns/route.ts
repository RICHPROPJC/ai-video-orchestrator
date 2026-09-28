import { NextResponse } from "next/server";
import { readJob } from "@/lib/studio/store";
import { ownerHeartbeatMs, ownerIsStale } from "@/lib/studio/store";
import { appendTurn, findUserTurnByRequestId, queueReviseTurn, replyToAskTurn } from "@/lib/studio/pipeline/session";
import { loadConfig } from "@/lib/studio/config";
import { jobDir } from "@/lib/studio/paths";

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
    queueReviseTurn(id, turn.turnId); // root 競態修①：owner 都要入 queue——owner 過咗 author 段嘅 turn 由下一 run 撿
    return NextResponse.json({ turnId: turn.turnId, at: turn.at, status: "queued-behind-owner", dependsOn: turn.dependsOn });
  }

  const turn = appendTurn(id, {
    requestId: body.requestId, role: "user", text: body.text,
    status: "recorded",
    dependsOn: { callsheetDigest: (job as { callsheetDigest?: string }).callsheetDigest ?? null },
  });
  // §P33 A3（0928）：revise turn 入 job 佇列——pipeline owner 安全點（author
  // 段）讀佢採納（revise hint 帶 user text→責任席修訂→manifest 新 revision
  // →completeAdoptedTurns 回寫 adopted）；runtime 觸發照舊 produce 邊界。
  if (intent === "revise") queueReviseTurn(id, turn.turnId);
  // §P33 A3 ask reply consumer：ask 唔再淨 recorded——生 assistant 文字回覆
  // （細席 flash 級；fail 落 job-facts fallback，replySource 具名）。config
  // 缺（boards_model_missing 等）唔殺會話：ask turn 已落盤，回覆缺席具名。
  if (intent === "ask") {
    try {
      const cfg = loadConfig();
      const { turn: reply, replySource } = await replyToAskTurn(id, job, turn, {
        model: cfg.crew.boardsModel ?? (() => { throw new Error("boards_model_missing"); })(),
        crew: cfg.crew,
        receiptDir: jobDir(id),
        fallbackModel: cfg.crew.secondFallback,
      });
      return NextResponse.json({ turnId: turn.turnId, at: turn.at, status: "recorded", intent,
        reply: { turnId: reply.turnId, at: reply.at, text: reply.text, replySource } });
    } catch (err) {
      return NextResponse.json({ turnId: turn.turnId, at: turn.at, status: "recorded", intent,
        reply: { error: `ask_reply_unavailable:${(err as Error).message}` } });
    }
  }
  return NextResponse.json({ turnId: turn.turnId, at: turn.at, status: "recorded", intent,
    queued: "已入採納佇列（job.pendingReviseTurns）——pipeline 下一輪 owner 安全點採納；未有 owner 時等 resume/下一 run" });
}
