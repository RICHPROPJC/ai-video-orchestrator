import { NextResponse } from "next/server";
import { readJob } from "@/lib/studio/store";
import { loadConfig } from "@/lib/studio/config";

/** 刀3（0929 ROOT world-direct）：job↔World project 綁定讀口——Album per-鏡
 *  AxisRow 真源。回 worldBinding（凍結版）＋最新 editSeq 對比＝stale 判源：
 *  latest > editSeqAtAdoption＝World 側已前行（採納版過時，消費前要對帳）；
 *  GET 唔通＝unreachable（World serve 離線，唔係 stale）。零 binding＝
 *  unbound（job 未揀定 project，cfg.world.projectId 空或未行 worldStage）。 */
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const binding = job.worldBinding;
  if (!binding) return NextResponse.json({ state: "unbound" });
  const cfg = loadConfig();
  const base = cfg.world?.base ?? "http://127.0.0.1:8791";
  try {
    const r = await fetch(`${base}/api/projects/${binding.projectId}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const d = (await r.json()) as { editSeq?: number; contentFingerprint?: string };
    const latest = typeof d.editSeq === "number" ? d.editSeq : undefined;
    const stale =
      latest !== undefined && binding.editSeqAtAdoption !== undefined && latest > binding.editSeqAtAdoption;
    return NextResponse.json({
      state: stale ? "stale" : "current",
      binding,
      latest: { editSeq: latest, contentFingerprint: d.contentFingerprint },
    });
  } catch (e) {
    return NextResponse.json({ state: "unreachable", binding, error: String(e) });
  }
}
