import { NextResponse } from "next/server";
import { loadConfig } from "@/lib/studio/config";
import { blockersForGate, formatFleet, gateReady, probeFleet } from "@/lib/studio/fleet";
import { runPipeline } from "@/lib/studio/pipeline";
import { fleetGateOf, resumeSlate, type ResumePatch } from "@/lib/studio/open-produce";
import { ownerHeartbeatMs, ownerIsStale, readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

/** SC-UI-SESSION-0928-P33 A1（§33-3/4）：明確「續做」入口——帶既有 jobId＋
 *  explicit resume 意圖，唔重填 brief、唔複製新 ID。
 *  - 同 ID 有活躍 owner → `attached`（返既有 run 狀態；唔改 queued、唔起第
 *    二執行——owner 互斥前置，唔靠 runPipeline acquire 先擋）
 *  - 無效 ID / 來源缺失 → 具名報錯，絕不 fallback new
 *  - GET 零副作用（UI poll attached 狀態用）；POST 先真正 resume。 */
function ownerActive(id: string): { active: boolean; heartbeatMsAgo: number | null } {
  const ms = ownerHeartbeatMs(id);
  if (ms === null) return { active: false, heartbeatMsAgo: null };
  return { active: !ownerIsStale(id), heartbeatMsAgo: ms };
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: `unknown-slate:${id}`, detail: "呢個 ID 冇 job——唔會 fallback 去新建" }, { status: 404 });
  const owner = ownerActive(id);
  return NextResponse.json({
    jobId: id,
    status: owner.active ? "attached" : (job.status === "failed" ? "failed" : job.status),
    owner: owner.active ? { active: true, heartbeatMsAgo: owner.heartbeatMsAgo } : undefined,
    progress: job.progress ?? null,
    lastError: job.error ?? null,
  });
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const body = await req.json().catch(() => ({})) as (ResumePatch & { requestId?: string }) | Record<string, never>;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: `unknown-slate:${id}`, detail: "呢個 ID 冇 job——resume 絕不 fallback 去新建" }, { status: 404 });
  const owner = ownerActive(id);
  if (owner.active) {
    // §33-4：活躍執行者同 job→返/附着既有 run——零狀態改動、零第二執行。
    return NextResponse.json({
      jobId: id,
      status: "attached",
      owner: { active: true, heartbeatMsAgo: owner.heartbeatMsAgo },
      progress: job.progress ?? null,
      lastError: job.error ?? null,
      note: "活躍執行者仲行緊——attached 既有 run；requestId 唔會重複派工（冪等由 attached 語義保證：本請求零副作用）",
    });
  }
  const patch: ResumePatch = "until" in body ? body : {};
  const fleet = await probeFleet(loadConfig());
  const gate = fleetGateOf(patch.until);
  if (!gateReady(fleet, gate)) {
    const blockers = blockersForGate(fleet.rows, gate);
    return NextResponse.json(
      { jobId: id, status: "blocked", error: "fleet not ready", gate, fleet: { ...fleet, ready: false, blockers }, detail: formatFleet({ ...fleet, ready: false, blockers }) },
      { status: 503 },
    );
  }
  const opened = resumeSlate(id, patch);
  if ("error" in opened) {
    return NextResponse.json({ jobId: id, status: "blocked", error: opened.error }, { status: 400 });
  }
  void runPipeline(opened.id, opened.input);
  return NextResponse.json({ jobId: id, status: "resumed", note: "resume 原有 repair budget／產物／歷史（resumeSlate 保留 job.id/outputs/progress/brief）" });
}
