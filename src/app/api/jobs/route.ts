import { NextResponse } from "next/server";
import fs from "node:fs";
import { runPipeline } from "@/lib/studio/pipeline";
import { jobFile } from "@/lib/studio/paths";
import { newSlateId, writeJob, listJobs } from "@/lib/studio/store";
import type { JobRecord, ProduceInput } from "@/lib/studio/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ jobs: listJobs() });
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  let input: ProduceInput;
  let cloneTemp: string | undefined;
  const id = newSlateId();

  if (contentType.includes("multipart/form-data")) {
    const form = await req.formData();
    const file = form.get("clone");
    if (file instanceof File && file.size > 0) {
      const buf = Buffer.from(await file.arrayBuffer());
      cloneTemp = jobFile(id, "audio", "clone-ref.wav");
      fs.writeFileSync(cloneTemp, buf);
    }
    input = {
      brief: String(form.get("brief") ?? ""),
      durationSec: Number(form.get("durationSec") ?? 12) || 12,
      aspect: (String(form.get("aspect") ?? "16:9") as ProduceInput["aspect"]) || "16:9",
      language: (String(form.get("language") ?? "auto") as ProduceInput["language"]) || "auto",
      voiceClonePath: cloneTemp,
    };
  } else {
    const body = (await req.json()) as ProduceInput;
    input = body;
  }

  if (!input.brief?.trim()) {
    return NextResponse.json({ error: "brief required" }, { status: 400 });
  }

  const job: JobRecord = {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    input,
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [] },
  };
  writeJob(job);
  void runPipeline(id, input);
  return NextResponse.json(job);
}
