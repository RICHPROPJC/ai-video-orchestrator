import { NextResponse } from "next/server";
import path from "node:path";
import { dataRoot } from "@/lib/studio/paths";
import { extractMotionFrames } from "@/lib/studio/motion-frames";

export const runtime = "nodejs";

/** Same call as `slatecrew frames <job> <shot>`. */
export async function POST(req: Request) {
  const body = (await req.json()) as { job?: string; shot?: string };
  if (!body.job || !body.shot) {
    return NextResponse.json({ error: "frames <job> <shot>" }, { status: 400 });
  }
  const mp4 = path.join(dataRoot(), body.job, "motion", `${body.shot}.mp4`);
  const outDir = path.join(dataRoot(), body.job, "motion", `${body.shot}.frames`);
  try {
    const frames = await extractMotionFrames(mp4, outDir, body.shot);
    return NextResponse.json({ job: body.job, shot: body.shot, mp4, outDir, frames });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : String(err) }, { status: 400 });
  }
}
