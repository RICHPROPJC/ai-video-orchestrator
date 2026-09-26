import { NextResponse } from "next/server";
import fs from "node:fs";
import { loadConfig } from "@/lib/studio/config";
import { blockersForGate, formatFleet, gateReady, probeFleet } from "@/lib/studio/fleet";
import { jobFile } from "@/lib/studio/paths";
import { runPipeline } from "@/lib/studio/pipeline";
import { createSlate, fleetGateOf, resumeSlate, type ResumePatch } from "@/lib/studio/open-produce";
import { listJobs, readJob, writeJob } from "@/lib/studio/store";
import type { ProduceInput } from "@/lib/studio/types";

export const runtime = "nodejs";

export async function GET() {
  return NextResponse.json({ jobs: listJobs() });
}

function opt(form: FormData, key: string): string | undefined {
  const v = String(form.get(key) ?? "").trim();
  return v || undefined;
}

function flag(form: FormData, key: string): boolean {
  const v = String(form.get(key) ?? "");
  return v === "1" || v === "on" || v === "true";
}

async function saveClone(id: string, file: FormDataEntryValue | null): Promise<string | undefined> {
  if (!(file instanceof File) || file.size === 0) return undefined;
  const dest = jobFile(id, "audio", "clone-ref.wav");
  fs.writeFileSync(dest, Buffer.from(await file.arrayBuffer()));
  return dest;
}

export async function POST(req: Request) {
  const contentType = req.headers.get("content-type") ?? "";
  let wantsRedirect = false;
  let resumeId: string | undefined;
  let input: ProduceInput;
  let patch: ResumePatch = {};
  let cloneFile: FormDataEntryValue | null = null;

  if (contentType.includes("multipart/form-data") || contentType.includes("application/x-www-form-urlencoded")) {
    const form = await req.formData();
    wantsRedirect = String(form.get("_redirect") ?? "") === "1";
    resumeId = opt(form, "resume");
    cloneFile = form.get("clone");
    input = {
      brief: String(form.get("brief") ?? ""),
      durationSec: Number(form.get("durationSec") ?? 12) || 12,
      aspect: (opt(form, "aspect") as ProduceInput["aspect"]) || "16:9",
      language: (opt(form, "language") as ProduceInput["language"]) || "auto",
      wavDir: opt(form, "wavDir") ?? "",
      portraitsDir: opt(form, "portraitsDir"),
      blockoutDir: opt(form, "blockoutDir"),
      gapSec: opt(form, "gapSec") ? Number(form.get("gapSec")) : 0,
      noMotionSelect: flag(form, "noMotionSelect"),
      dryRun: flag(form, "dryRun"),
      until: opt(form, "until") as ProduceInput["until"],
      scene: opt(form, "scene"),
      shot: opt(form, "shot"),
      callSheetPath: opt(form, "callSheetPath"),
      castRosterPath: opt(form, "castRosterPath"),
      graphVariant: (opt(form, "graphVariant") as ProduceInput["graphVariant"]) || "a",
      steps: opt(form, "steps") ? Number(form.get("steps")) : undefined,
      drama: opt(form, "drama"),
      episode: opt(form, "episode"),
    };
    patch = {
      wavDir: opt(form, "wavDir"),
      portraitsDir: opt(form, "portraitsDir"),
      blockoutDir: opt(form, "blockoutDir"),
      gapSec: opt(form, "gapSec") ? Number(form.get("gapSec")) : undefined,
      noMotionSelect: flag(form, "noMotionSelect"),
      dryRun: flag(form, "dryRun"),
      until: opt(form, "until") as ProduceInput["until"],
      scene: opt(form, "scene"),
      shot: opt(form, "shot"),
      graphVariant: opt(form, "graphVariant") as ProduceInput["graphVariant"],
      steps: opt(form, "steps") ? Number(form.get("steps")) : undefined,
    };
  } else {
    const body = (await req.json()) as ProduceInput & { resumeSlate?: string };
    resumeId = body.resumeSlate;
    input = body;
    patch = {
      wavDir: body.wavDir,
      portraitsDir: body.portraitsDir,
      blockoutDir: body.blockoutDir,
      gapSec: body.gapSec,
      noMotionSelect: body.noMotionSelect,
      dryRun: body.dryRun,
      until: body.until,
      scene: body.scene,
      shot: body.shot,
      graphVariant: body.graphVariant,
      steps: body.steps,
      voiceClonePath: body.voiceClonePath,
    };
  }

  const fleet = await probeFleet(loadConfig());
  const gate = fleetGateOf(resumeId ? patch.until : input.until);
  if (!gateReady(fleet, gate)) {
    const blockers = blockersForGate(fleet.rows, gate);
    return NextResponse.json(
      { error: "fleet not ready", gate, fleet: { ...fleet, ready: false, blockers }, detail: formatFleet({ ...fleet, ready: false, blockers }) },
      { status: 503 },
    );
  }

  const opened = resumeId ? resumeSlate(resumeId, patch) : createSlate(input);
  if ("error" in opened) {
    return NextResponse.json({ error: opened.error }, { status: 400 });
  }

  const voiceClonePath = await saveClone(opened.id, cloneFile);
  let live = opened.input;
  if (voiceClonePath) {
    live = { ...opened.input, voiceClonePath };
    const job = readJob(opened.id);
    if (job) writeJob({ ...job, input: live });
  }

  void runPipeline(opened.id, live);

  if (wantsRedirect) {
    const host = req.headers.get("x-forwarded-host") || req.headers.get("host") || "127.0.0.1:43127";
    const proto = req.headers.get("x-forwarded-proto") || "http";
    return NextResponse.redirect(`${proto}://${host}/?slate=${opened.id}`, 303);
  }
  return NextResponse.json(readJob(opened.id));
}
