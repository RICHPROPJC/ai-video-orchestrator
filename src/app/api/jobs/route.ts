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
  const id = newSlateId();
  let input: ProduceInput;
  let wantsRedirect = false;

  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    wantsRedirect = String(form.get("_redirect") ?? "") === "1";
    const file = form.get("clone");
    let voiceClonePath: string | undefined;
    if (file instanceof File && file.size > 0) {
      const buf = Buffer.from(await file.arrayBuffer());
      voiceClonePath = jobFile(id, "audio", "clone-ref.wav");
      fs.writeFileSync(voiceClonePath, buf);
    }
    input = {
      brief: String(form.get("brief") ?? ""),
      durationSec: Number(form.get("durationSec") ?? 12) || 12,
      aspect: (String(form.get("aspect") ?? "16:9") as ProduceInput["aspect"]) || "16:9",
      language: (String(form.get("language") ?? "auto") as ProduceInput["language"]) || "auto",
      voiceClonePath,
      wavDir: String(form.get("wavDir") ?? ""),
    };
  } else {
    input = (await req.json()) as ProduceInput;
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
    outputs: { stills: [], shots: [], blockout: [], receipts: [] },
  };
  writeJob(job);
  void runPipeline(id, input);

  if (wantsRedirect) {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "127.0.0.1:43127";
    const proto = req.headers.get("x-forwarded-proto") || "http";
    return NextResponse.redirect(`${proto}://${host}/?slate=${id}`, 303);
  }
  return NextResponse.json(job);
}
