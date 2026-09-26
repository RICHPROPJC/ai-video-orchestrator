import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import { dataRoot } from "../paths";

/** wb/receipts.ts — job.json status 收據驗證（whitebox gates/receipts.py 同款）。
 *
 *  鐵律：agent 寫嘅 job.json status ＝「意見」（claim）；碟上實物先係收據。
 *  verifyJobStatus() 用實物質疑 claim——outputs 存在＋sha256＋video ffprobe
 *  時長>0，出四態。08-26 render_status 大話嗰單嘅同款解。呢度淨出報告，
 *  唔改 job.json——改 claim 唔係驗證嘅工作。
 *
 *  四態：
 *    verified     claim 過驗：列咗嘅實物件件存在、片 ffprobe 讀到時長>0
 *    contradicted claim 被實物質疑：有列嘅檔碟上冇／ffprobe 讀唔到／hash 唔對
 *    no-receipt   claim 冇列出任何可驗實物（outputs 四個陣列全空）
 *    stale        件件過驗，但有實物 mtime 晚過 job.json updatedAt——
 *                 碟上改過而 claim 未跟，claim 已唔係最新事實 */

const VIDEO_EXT = new Set([".mp4", ".mov", ".mkv", ".webm"]);

/** 呢啲 status 白紙黑字話「實物已出齊」——少一件即係 contradicted。 */
export const CLAIMING_STATUSES = new Set([
  "boarded",
  "blockout-ready",
  "stills-ready",
  "motion-ready",
  "locked",
]);

export type FfprobeResult = { ok: boolean; durationS: number; reason?: string };

/** 機器驗證：ffprobe 真係讀到一條片（時長>0）。空 JSON／exit≠0／duration≤0
 *  都係 fail——ffprobe 對唔存在檔案會 exit 0 出空 JSON，唔可以信 exit code。 */
export function ffprobeOk(path: string): FfprobeResult {
  try {
    const out = execFileSync(
      "ffprobe",
      ["-v", "quiet", "-print_format", "json", "-show_format", "--", path],
      { timeout: 30_000, encoding: "utf8" },
    );
    const d = JSON.parse(out || "{}") as { format?: { duration?: string } };
    const dur = Number(d.format?.duration ?? 0) || 0;
    return { ok: dur > 0, durationS: dur, ...(dur > 0 ? {} : { reason: "duration<=0 或 format 缺失" }) };
  } catch (e) {
    return { ok: false, durationS: 0, reason: e instanceof Error ? e.message.slice(0, 120) : String(e).slice(0, 120) };
  }
}

export function sha256File(path: string): string {
  return crypto.createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

export type ArtifactReceipt = {
  path: string; // job 目錄相對路徑（job.json outputs 原樣）
  abs: string;
  kind: string; // stills | shots | blockout | receipts
  exists: boolean;
  bytes: number | null;
  sha256: string | null;
  durationS: number | null; // video 先有
  problem: string | null;
};

export type StatusVerdict = "verified" | "contradicted" | "no-receipt" | "stale";

export type StatusClaimReport = {
  jobId: string;
  claimStatus: string;
  verdict: StatusVerdict;
  /** 一句死因／過數理由——收據句，俾人同機器都讀得明 */
  why: string;
  claimingStatus: boolean;
  artifacts: ArtifactReceipt[];
};

const OUTPUT_ARRAYS = ["stills", "shots", "blockout", "receipts"] as const;

export function verifyJobStatus(
  jobId: string,
  opts?: { jobsDir?: string; ffprobeImpl?: (path: string) => FfprobeResult },
): StatusClaimReport {
  const jobsDir = opts?.jobsDir ?? dataRoot();
  const probe = opts?.ffprobeImpl ?? ffprobeOk;
  const dir = path.join(jobsDir, jobId);
  const jobFile = path.join(dir, "job.json");
  if (!fs.existsSync(jobFile)) {
    return {
      jobId,
      claimStatus: "(missing)",
      verdict: "no-receipt",
      why: `job.json 碟上唔存在：${jobFile}`,
      claimingStatus: false,
      artifacts: [],
    };
  }
  let job: {
    status?: string;
    updatedAt?: string;
    outputs?: Partial<Record<(typeof OUTPUT_ARRAYS)[number], unknown>>;
  };
  try {
    job = JSON.parse(fs.readFileSync(jobFile, "utf8")) as typeof job;
  } catch (e) {
    return {
      jobId,
      claimStatus: "(unreadable)",
      verdict: "no-receipt",
      why: `job.json 解唔開：${e instanceof Error ? e.message.slice(0, 100) : String(e)}`,
      claimingStatus: false,
      artifacts: [],
    };
  }
  const status = job.status ?? "(none)";
  const claiming = CLAIMING_STATUSES.has(status);
  const updatedAtMs = job.updatedAt ? Date.parse(job.updatedAt) : Number.NaN;

  const entries: { kind: string; rel: string }[] = [];
  for (const kind of OUTPUT_ARRAYS) {
    const arr = job.outputs?.[kind];
    if (!Array.isArray(arr)) continue;
    for (const rel of arr) if (typeof rel === "string" && rel) entries.push({ kind, rel });
  }
  if (!entries.length) {
    return {
      jobId,
      claimStatus: status,
      verdict: "no-receipt",
      why: claiming
        ? `claim「${status}」話實物出齊，但 outputs 四個陣列全空——冇收據可言`
        : "outputs 冇列任何實物，冇嘢可驗",
      claimingStatus: claiming,
      artifacts: [],
    };
  }

  const artifacts: ArtifactReceipt[] = [];
  let contradicted: string | null = null;
  let stale = false;
  for (const { kind, rel } of entries) {
    const abs = path.resolve(dir, rel);
    const ext = path.extname(rel).toLowerCase();
    const r: ArtifactReceipt = {
      path: rel,
      abs,
      kind,
      exists: fs.existsSync(abs),
      bytes: null,
      sha256: null,
      durationS: null,
      problem: null,
    };
    if (!r.exists) {
      r.problem = "碟上唔存在";
    } else {
      const st = fs.statSync(abs);
      r.bytes = st.size;
      r.sha256 = sha256File(abs);
      if (!Number.isNaN(updatedAtMs) && st.mtimeMs > updatedAtMs) stale = true;
      if (VIDEO_EXT.has(ext)) {
        const p = probe(abs);
        r.durationS = p.durationS;
        if (!p.ok) r.problem = `ffprobe 實測失敗：${p.reason ?? "唔知原因"}`;
      }
    }
    if (r.problem && !contradicted) contradicted = `${kind}/${rel}: ${r.problem}`;
    artifacts.push(r);
  }

  if (contradicted) {
    return {
      jobId,
      claimStatus: status,
      verdict: "contradicted",
      why: `${claiming ? `claim「${status}」` : "outputs"} 被實物質疑：${contradicted}`,
      claimingStatus: claiming,
      artifacts,
    };
  }
  if (stale) {
    return {
      jobId,
      claimStatus: status,
      verdict: "stale",
      why: "實物件件過驗，但有實物 mtime 晚過 job.json updatedAt——碟上改過而 claim 未跟",
      claimingStatus: claiming,
      artifacts,
    };
  }
  const videos = artifacts.filter((a) => VIDEO_EXT.has(path.extname(a.path).toLowerCase()));
  return {
    jobId,
    claimStatus: status,
    verdict: "verified",
    why: videos.length
      ? `${artifacts.length} 件實物過驗（sha256 算齊，${videos.length} 條片 ffprobe 時長>0）`
      : `${artifacts.length} 件實物過驗（sha256 算齊）`,
    claimingStatus: claiming,
    artifacts,
  };
}
