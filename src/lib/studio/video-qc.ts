import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { loadConfig } from "./config";
import { extractMotionFrames } from "./motion-frames";
import {
  blindDescribe,
  judge,
  probeVisionEndpoint,
  resolveSecondEye,
  runSecondEye,
  judgeSecondEye,
  sameRequire,
  summarize,
  gramMatch,
  type QcRequire,
  type QcSummary,
  type QcVerdict,
  type SecondEyeOpts,
  type SecondEyeRecord,
} from "./photo-qc";
import { machineGreyFailReason, measureWorkbenchGreyLeak } from "./workbench-grey-leak";
import { judgeWalkCrop, type WalkCropEvidence } from "./walk-crop-qc";
export type VideoFrameQc = {
  frame: number;
  t_s: number;
  file: string;
  sha256: string;
  status: "GREEN" | "FAIL";
  blind: string;
  summary: QcSummary | { parse_error: string; raw: string };
  checks: QcVerdict["checks"];
};

export type VideoQcRecord = {
  tool: "slatecrew.video_qc";
  ts: string;
  video: string;
  sha256: string;
  endpoint: string;
  model: string;
  require: QcRequire;
  status: "GREEN" | "FAIL";
  frames: VideoFrameQc[];
  checks: QcVerdict["checks"];
  second?: SecondEyeRecord & { frame: number };
  memory?: {
    character_drift?: { distance: number; fail: boolean };
    blockout_copy?: { distance: number; fail: boolean };
  };};

function videoDigest(mp4: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(mp4)).digest("hex");
}

function frameDigest(file: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

/** CFORM7B: the clip action is a timeline sentence (企定→出拳→轉身踢→收勢) — no
 *  single frame shows every beat, so per-frame judging with the whole sentence
 *  kills every frame (run7 SH01 f48/f96, SH02 f0-f96 all miss one beat). The
 *  action gate moves to clip level: pool the take's write-ups, threshold
 *  unchanged — every beat token must surface somewhere in the take or the clip
 *  dies. location/size/people/tool stay per-frame gates. */
export function frameRequireWithoutAction(require: QcRequire): QcRequire {
  const rest = { ...require };
  delete rest.action;
  return rest;
}

function frameEvidenceBlob(f: {
  blind: string;
  summary: QcSummary | { parse_error: string; raw: string };
}): string {
  const s = f.summary as Partial<QcSummary> | undefined;
  return [f.blind, s?.location_notes, s?.action_notes, s?.pose_notes]
    .filter((x): x is string => typeof x === "string")
    .join("\n");
}

/** Clip-level action verdict — undefined when the require carries no action. */
export function clipActionCheck(
  frames: Array<{ blind: string; summary: QcSummary | { parse_error: string; raw: string } }>,
  require: QcRequire,
): { ok: boolean; reason?: string } | undefined {
  const action = require.action?.trim();
  if (!action) return undefined;
  const { hits, total, need } = gramMatch(action, frames.map(frameEvidenceBlob).join("\n"));
  if (total < 2) return { ok: false, reason: "action: require unparseable — no judgeable bigrams" };
  if (hits < need) {
    return { ok: false, reason: `action(clip): hits ${hits}/${need} — misses ${JSON.stringify(action)}` };
  }
  return { ok: true };
}

/** Aggregate per-frame MARS verdicts — any FAIL fails the clip. The action
 *  sentence judges once at clip level, not per frame. */
export function judgeVideoFrames(
  frames: Array<{ frame: number; t_s: number; file: string; blind: string; summary: QcSummary }>,
  require: QcRequire,
): Pick<VideoQcRecord, "status" | "frames" | "checks"> {
  const judged: VideoFrameQc[] = frames.map((f) => {
    const verdict = judge(f.blind, f.summary, frameRequireWithoutAction(require));
    return {
      frame: f.frame,
      t_s: f.t_s,
      file: f.file,
      sha256: fs.existsSync(f.file) ? frameDigest(f.file) : "",
      status: verdict.status,
      blind: f.blind,
      summary: f.summary,
      checks: verdict.checks,
    };
  });
  const failReasons = judged.flatMap((f) =>
    (f.checks.fail_reasons ?? []).map((r) => `f${f.frame}: ${r}`),
  );
  const clipAction = clipActionCheck(frames, require);
  if (clipAction && !clipAction.ok) failReasons.push(clipAction.reason!);
  if (Object.keys(require).length === 0) failReasons.push("no require: cannot accept");
  const status: "GREEN" | "FAIL" =
    judged.length > 0 && failReasons.length === 0 ? "GREEN" : "FAIL";
  return {
    status,
    frames: judged,
    checks: {
      ...(clipAction ? { action: clipAction.ok } : {}),
      status,
      fail_reasons: failReasons,
    },
  };
}

/** Geometry gate: cropped head / sliding root / camera order. Missing evidence ≠ PASS. */
export function gateVideoWithWalkCrop(
  judged: Pick<VideoQcRecord, "status" | "frames" | "checks">,
  evidence: WalkCropEvidence,
): Pick<VideoQcRecord, "status" | "frames" | "checks"> {
  const extra = judgeWalkCrop(evidence);
  if (extra.status === "GREEN") return judged;
  const fail_reasons = [...(judged.checks.fail_reasons ?? []), ...extra.fail_reasons];
  return {
    ...judged,
    status: "FAIL",
    checks: { ...judged.checks, status: "FAIL", fail_reasons, walk_crop_rule: extra.rule },
  };
}

async function qcOneFrame(
  url: string,
  model: string,
  file: string,
  require: QcRequire,
  frame: number,
  t_s: number,
): Promise<VideoFrameQc> {
  const desc = await blindDescribe(url, model, file);
  try {
    const summary = await summarize(url, model, desc);
    const verdict = judge(desc, summary, require);
    const checks = { ...verdict.checks };
    let status = verdict.status;
    if (require.grey_blocks === false) {
      const leak = await measureWorkbenchGreyLeak(file);
      checks.machine_grey = !leak.hit;
      if (leak.hit) {
        status = "FAIL";
        checks.status = "FAIL";
        checks.fail_reasons = [...(checks.fail_reasons ?? []), machineGreyFailReason(leak)];
      }
    }
    return {
      frame,
      t_s,
      file,
      sha256: frameDigest(file),
      status,
      blind: desc,
      summary,
      checks,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      frame,
      t_s,
      file,
      sha256: frameDigest(file),
      status: "FAIL",
      blind: desc,
      summary: { parse_error: message, raw: desc.slice(0, 2000) },
      checks: { status: "FAIL", fail_reasons: [`summary parse: ${message}`] },
    };
  }
}

/** MARS on extracted motion frames vs the shot still require — writes motion/SHxx.video_qc.json.
 *  The glm second eye (when armed) sees ONE mid frame, sequentially after the frame loop. */
export async function runVideoQc(opts: {
  mp4: string;
  outJson: string;
  require: QcRequire;
  shotId: string;
  framesDir?: string;
} & SecondEyeOpts): Promise<VideoQcRecord> {
  const digest = videoDigest(opts.mp4);
  const secondCfg = resolveSecondEye(opts);
  if (fs.existsSync(opts.outJson)) {
    try {
      const existing = JSON.parse(fs.readFileSync(opts.outJson, "utf8")) as VideoQcRecord;
      if (
        existing.tool === "slatecrew.video_qc" &&
        existing.status === "GREEN" &&
        existing.sha256 === digest &&
        sameRequire(existing.require, opts.require) &&
        (!secondCfg || existing.second?.model === secondCfg.model)
      ) {
        return existing;
      }
    } catch {
      /* re-run */
    }
  }
  const framesDir = opts.framesDir ?? path.join(path.dirname(opts.mp4), `${opts.shotId}.frames`);
  const extracted = await extractMotionFrames(opts.mp4, framesDir, opts.shotId);
  const cfg = loadConfig();
  const url = cfg.pictureQc.endpoint;
  const model = await probeVisionEndpoint(url, cfg.pictureQc.model);
  const frameResults: VideoFrameQc[] = [];
  const frameRequire = frameRequireWithoutAction(opts.require);
  for (const { frame, t_s, file } of extracted) {
    frameResults.push(await qcOneFrame(url, model, file, frameRequire, frame, t_s));
  }
  const failReasons = frameResults.flatMap((f) =>
    (f.checks.fail_reasons ?? []).map((r) => `f${f.frame}: ${r}`),
  );
  const clipAction = clipActionCheck(frameResults, opts.require);
  if (clipAction && !clipAction.ok) failReasons.push(clipAction.reason!);
  let second: (SecondEyeRecord & { frame: number }) | undefined;
  if (secondCfg && frameResults.length > 0) {
    const mid = frameResults[Math.floor(frameResults.length / 2)]!; // one mid frame — no fan-out
    const eye = await runSecondEye(secondCfg.endpoint, secondCfg.model, mid.file);
    second = { ...eye, frame: mid.frame };
    const se = judgeSecondEye(opts.require, eye);
    if (!se.ok && se.reason) failReasons.push(`f${mid.frame}: ${se.reason}`);
  }
  if (Object.keys(opts.require).length === 0) failReasons.push("no require: cannot accept");
  const status: "GREEN" | "FAIL" =
    frameResults.length > 0 && failReasons.length === 0 ? "GREEN" : "FAIL";
  const record: VideoQcRecord = {
    tool: "slatecrew.video_qc",
    ts: new Date().toISOString(),
    video: opts.mp4,
    sha256: digest,
    endpoint: url,
    model,
    require: opts.require,
    status,
    frames: frameResults,
    checks: {
      ...(clipAction ? { action: clipAction.ok } : {}),
      status,
      fail_reasons: failReasons,
    },
    ...(second ? { second } : {}),
  };
  fs.mkdirSync(path.dirname(opts.outJson), { recursive: true });
  fs.writeFileSync(opts.outJson, JSON.stringify(record, null, 2));
  return record;
}

/** Write a video QC receipt from recorded MARS write-ups (tests / offline replay). */
export function writeVideoQcFromRecordings(opts: {
  mp4: string;
  outJson: string;
  require: QcRequire;
  frames: Array<{ frame: number; t_s: number; file: string; blind: string; summary: QcSummary }>;
}): VideoQcRecord {
  const judged = judgeVideoFrames(opts.frames, opts.require);
  const record: VideoQcRecord = {
    tool: "slatecrew.video_qc",
    ts: new Date().toISOString(),
    video: opts.mp4,
    sha256: fs.existsSync(opts.mp4) ? videoDigest(opts.mp4) : "",
    endpoint: "fixture",
    model: "fixture",
    require: opts.require,
    ...judged,
  };
  fs.mkdirSync(path.dirname(opts.outJson), { recursive: true });
  fs.writeFileSync(opts.outJson, JSON.stringify(record, null, 2));
  return record;
}

/** `--until motion` may stamp motion-ready only when every listed shot is GREEN on disk. */
export function motionReadyAllowed(motionDir: string, shotIds: string[]): boolean {
  return shotIds.length > 0 && shotIds.every((id) => pinVideoQcAccepted(motionDir, id));
}

/** Resume may keep an mp4 only when video_qc is GREEN and hash-matches the file on disk. */
export function pinVideoQcAccepted(motionDir: string, shotId: string): boolean {
  const qcFile = path.join(motionDir, `${shotId}.video_qc.json`);
  const mp4 = path.join(motionDir, `${shotId}.mp4`);
  if (!fs.existsSync(qcFile) || !fs.existsSync(mp4)) return false;
  let data: VideoQcRecord;
  try {
    data = JSON.parse(fs.readFileSync(qcFile, "utf8")) as VideoQcRecord;
  } catch {
    return false;
  }
  if (data.tool !== "slatecrew.video_qc" || data.status !== "GREEN") return false;
  const require = data.require;
  if (typeof require !== "object" || require === null || Object.keys(require).length === 0) return false;
  return data.sha256 === videoDigest(mp4);
}
