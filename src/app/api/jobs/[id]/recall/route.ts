import { NextResponse } from "next/server";
import { recall, type Modality } from "@/lib/studio/vault";
import { readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  if (!readJob(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const url = new URL(req.url);
  const q = url.searchParams.get("q") ?? "";
  const modality = (url.searchParams.get("modality") ?? undefined) as Modality | undefined;
  if (!q.trim()) return NextResponse.json({ error: "q required", slate: id }, { status: 400 });
  try {
    const hits = recall(id, q, { modality: modality || undefined, k: 8 });
    return NextResponse.json({ slate: id, isolated: true, q, hits });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
