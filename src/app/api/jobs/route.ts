import { NextResponse } from "next/server";
import fs from "node:fs";
import { loadConfig } from "@/lib/studio/config";
import { blockersForGate, formatFleet, gateReady, probeFleet, type FleetGate } from "@/lib/studio/fleet";
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
      drama: String(form.get("drama") ?? "") || undefined,
      episode: String(form.get("episode") ?? "") || undefined,
      scene: String(form.get("scene") ?? "") || undefined,
      until: (String(form.get("until") ?? "") as ProduceInput["until"]) || undefined,
    };
  } else {
    input = (await req.json()) as ProduceInput;
  }

  if (!input.brief?.trim()) {
    return NextResponse.json({ error: "brief required" }, { status: 400 });
  }
  if (input.drama && input.until === "stills") {
    return NextResponse.json({ error: "stills-ready skip forbidden for drama runs" }, { status: 400 });
  }
  if (input.drama === "guojia-lingdaoren" && !input.until && !input.scene && !input.dryRun) {
    return NextResponse.json(
      { error: "guojia-lingdaoren requires --scene SCxx (one hop at a time)" },
      { status: 400 },
    );
  }

  const fleet = await probeFleet(loadConfig());
  const gate: FleetGate =
    input.until === "boards" || input.until === "blockout"
      ? "boards"
      : input.until === "stills"
        ? "stills"
        : input.until === "motion"
          ? "motion"
          : "full";
  if (!gateReady(fleet, gate)) {
    const blockers = blockersForGate(fleet.rows, gate);
    return NextResponse.json(
      { error: "fleet not ready", gate, fleet: { ...fleet, ready: false, blockers }, detail: formatFleet({ ...fleet, ready: false, blockers }) },
      { status: 503 },
    );
  }

  const job: JobRecord = {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    input,
    ...(input.drama ? { drama: input.drama } : {}),
    ...(input.episode ? { episode: input.episode } : {}),
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
