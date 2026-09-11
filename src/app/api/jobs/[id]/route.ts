import { NextResponse } from "next/server";
import { readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json(job);
}
