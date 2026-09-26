import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobDir } from "@/lib/studio/paths";
import { readEvents, readJob } from "@/lib/studio/store";
import type { JobRecord } from "@/lib/studio/types";

function liveStoryboard(job: JobRecord): JobRecord {
  if (job.callSheet?.storyboard?.length) return job;
  const seats = path.join(jobDir(job.id), "seats");
  if (!fs.existsSync(seats)) return job;
  const receipts = fs.readdirSync(seats).filter((name) => name.endsWith(".visual.json")).map((name) => path.join(seats, name));
  const newest = receipts.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!newest) return job;
  const visual = JSON.parse(fs.readFileSync(newest, "utf8")) as { attempts?: { cells?: { shotId: string; at: string; file: string; status: string }[] }[] };
  const byKeyframe = new Map<string, { shotId: string; at: string; file: string; status: string }>();
  for (const attempt of visual.attempts ?? []) {
    for (const cell of attempt.cells ?? []) byKeyframe.set(`${cell.shotId}:${cell.at}`, cell);
  }
  const cells = [...byKeyframe.values()];
  if (!cells.length) return job;
  return {
    ...job,
    progress: Math.max(job.progress, 8),
    callSheet: {
      ...(job.callSheet ?? { title: job.input.brief.slice(0, 24), shots: [] }),
      storyboard: cells.map((cell) => ({ shotId: cell.shotId, at: `${cell.at} ${cell.status}`, file: cell.file })),
    } as JobRecord["callSheet"],
  };
}

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  return NextResponse.json({ ...liveStoryboard(job), events: readEvents(id) });
}
