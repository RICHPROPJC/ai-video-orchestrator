import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobDir } from "@/lib/studio/paths";
import { readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

function exists(file: string): boolean {
  return fs.existsSync(file);
}

function revision(): string {
  try {
    const head = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
    const dirty = execFileSync("git", ["status", "--porcelain", "--", "src"], { encoding: "utf8" }).trim();
    return dirty ? `${head}-dirty` : head;
  } catch {
    return "uncommitted";
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string; shot: string }> },
) {
  const { id, shot } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dir = jobDir(id);
  const call = job.callSheet?.shots.find((s) => s.id === shot) ?? null;
  const worldFile = path.join(dir, "world", "assemble.json");
  const world = exists(worldFile)
    ? JSON.parse(fs.readFileSync(worldFile, "utf8")) as { pieces?: { id: string; role: string; meters: number; evidence: string }[] }
    : null;
  const submitFile = path.join(dir, "motion", `${shot}.h3_submit.json`);
  const submit = exists(submitFile) ? JSON.parse(fs.readFileSync(submitFile, "utf8")) as {
    motion_form?: string;
    keyframe_positions?: string;
    prompt_id?: string | null;
    sources?: { role: string; path: string; sha256: string }[];
    uploads?: { blockout?: string | null; kf_start?: string | null; kf_end?: string | null; ref_images?: string[] };
    output?: { filename?: string; sha256?: string };
  } : null;
  const qcFile = path.join(dir, "motion", `${shot}.video_qc.json`);
  const qc = exists(qcFile) ? JSON.parse(fs.readFileSync(qcFile, "utf8")) as {
    status?: string;
    sha256?: string;
    frames?: { frame: number; t_s: number; status: string; checks?: { fail_reasons?: string[] } }[];
  } : null;
  return NextResponse.json({
    slate: id,
    shot,
    revision: revision(),
    jobStatus: job.status,
    pictureLock: job.outputs.pictureLock ?? null,
    whyUnlocked: job.outputs.pictureLock ? null : job.error ?? "冇 pictureLock",
    call,
    world: world?.pieces ?? [],
    files: {
      still: exists(path.join(dir, "stills", `${shot}.png`)),
      blockout: exists(path.join(dir, "blockout", `${shot}.mp4`)),
      characterRig: exists(path.join(dir, "cast", "A", "mesh_front_rigged.glb")),
      bottleRig: exists(path.join(dir, "cast", "玻璃樽檸檬汽水", "mesh_front_rigged.glb")),
    },
    h3: submit ? {
      motionForm: submit.motion_form ?? null,
      promptId: submit.prompt_id ?? null,
      keyframePositions: submit.keyframe_positions ?? "",
      blockout: submit.uploads?.blockout ?? null,
      kfStart: submit.uploads?.kf_start ?? null,
      kfEnd: submit.uploads?.kf_end ?? null,
      refImages: submit.uploads?.ref_images ?? [],
      sources: submit.sources ?? [],
      outputSha: submit.output?.sha256 ?? null,
      sameRunKeyframeAndVideo: Boolean(submit.uploads?.blockout && submit.uploads?.kf_start && submit.sources?.length),
    } : null,
    qc: qc ? {
      status: qc.status ?? null,
      sha256: qc.sha256 ?? null,
      frames: (qc.frames ?? []).map((frame) => ({
        frame: frame.frame,
        t_s: frame.t_s,
        status: frame.status,
        reasons: frame.checks?.fail_reasons ?? [],
      })),
    } : null,
  });
}
