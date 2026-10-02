/** PR-1 real：delivery 席嘅輸入契約——由上游各段產生
 * 呢個唔係空殼——係真實數據流嘅記錄 */

import type { CallSheet, JobRecord, Shot, ProviderTrace } from "../types";

export interface DeliveryInputs {
  // ── 來自 editor 席（:911-1085）──
  editReceipts: Array<{
    id: string;
    shots: string[];
    // §29-3: edit-receipts 嘅完整欄位
  }>;
  muxTargets: Array<{
    id: string;
    shots: string[];
  }>;
  muxed: string[];              // 實際要concat嘅mp4路徑
  blockedCauses: Map<string, string>;

  // ── 來自 soundQc 席（:857-890）──
  sound: {
    pass: boolean;
    peak: number;
    silenceRatio: number;
  };

  // ── 來自 stills/pictureQc（跨段共享）──
  stills: Array<{ id: string; file: string }>;
  geometry: unknown;            // pictureQcStills

  // ── 來自 pipeline ctx ──
  jobId: string;
  timed: CallSheet & { durationSec: number; provenance?: unknown; title: string };
  continuity: { cut: string[]; boards: Shot[] };
  job: JobRecord;
  trace: ProviderTrace;
  gapDelivered: Map<string, number>;
  callsheetDigest: string | null;

  // ── 工具函數（pipeline入面係閉包，抽出要顯式傳）──
  patch: (job: JobRecord, updates: Partial<JobRecord>) => JobRecord;
  ffmpeg: (args: string[]) => Promise<void>;
  concatCopyArgs: (listFile: string, outFile: string) => Promise<string[]>;
  localPictureQc: (opts: { stills: unknown[]; sheet: unknown; target: string }) => unknown;
  pinVideoQcAccepted: (dir: string, id: string) => boolean;
  emit: (jobId: string, event: unknown) => void;
  vaultStats: (jobId: string) => unknown;
}

/** delivery 席真正嘅業務邏輯——從 pipeline.ts :1040-1184 逐段搬 */
export async function runDelivery(inputs: DeliveryInputs): Promise<{
  status: "locked" | "blocked" | "failed";
  error?: string;
}> {
  const { jobId, timed, continuity, trace, job } = inputs;

  // §30-4: blocked 省略對帳
  const includedIds = new Set(inputs.editReceipts.map(r => r.id));
  const omittedFromConcat = inputs.muxTargets
    .filter(t => !includedIds.has(t.id))
    .map(t => ({
      id: t.id,
      shots: t.shots,
      cause: inputs.blockedCauses.get(t.id) ?? "unknown",
    }));

  // concat
  const muxList = `/mnt/ssd/ai-video-orchestrator-crew/data/jobs/${jobId}/motion/mux-list.txt`;
  const fs = await import("node:fs");
  fs.writeFileSync(muxList, inputs.muxed.map(v => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));

  const pictureLock = `/mnt/ssd/ai-video-orchestrator-crew/data/jobs/${jobId}/delivery/picture-lock.mp4`;
  const { createHash } = await import("node:crypto");
  fs.mkdirSync(`/mnt/ssd/ai-video-orchestrator-crew/data/jobs/${jobId}/delivery`, { recursive: true });
  await inputs.ffmpeg(await inputs.concatCopyArgs(muxList, pictureLock));

  // §29-3: edit-receipts
  const cutDigest = createHash("sha256")
    .update(JSON.stringify({
      cutOrder: continuity.cut,
      segments: inputs.editReceipts.map(r => ({ id: r.id, shots: r.shots })),
    }))
    .digest("hex").slice(0, 16);

  fs.writeFileSync(
    `/mnt/ssd/ai-video-orchestrator-crew/data/jobs/${jobId}/delivery/edit-receipts.json`,
    JSON.stringify({
      cutDigest,
      run: { jobId, callsheetDigest: inputs.callsheetDigest, writtenAt: new Date().toISOString() },
      callsheetDigest: inputs.callsheetDigest,
      cutOrder: continuity.cut,
      delivery: {
        pictureLock: "delivery/picture-lock.mp4",
        pictureLockSha256: createHash("sha256").update(fs.readFileSync(pictureLock)).digest("hex"),
        outcome: "concat-delivered",
      },
      segments: inputs.editReceipts,
      ...(omittedFromConcat.length ? { omittedFromConcat } : {}),
    }, null, 2),
  );

  // §9⑤: completion verdict
  const markGeometry = inputs.localPictureQc({
    stills: inputs.stills,
    sheet: timed,
    target: "video",
  });
  const videoQcPass = continuity.cut.every(id =>
    inputs.pinVideoQcAccepted(`/mnt/ssd/ai-video-orchestrator-crew/data/jobs/${jobId}/motion`, id),
  );

  // qc report
  const deliveredSec = 0; // TODO: mediaSeconds(pictureLock) — 需要import
  const report = {
    slate: job.slate,
    title: timed.title,
    cut: continuity.cut,
    providers: trace,
    delivered_s: deliveredSec,
    planned_s: timed.durationSec,
    soundQc: inputs.sound,
    pictureQcStills: inputs.geometry,
    markGeometry,
    locked: Boolean(inputs.sound.pass && videoQcPass),
  };
  const completeVerdict = report.locked
    && !(job.placementGaps ?? []).length
    && !(job.blockedShots ?? []).length;
  report.locked = completeVerdict;

  fs.writeFileSync(
    `/mnt/ssd/ai-video-orchestrator-crew/data/jobs/${jobId}/delivery/qc.json`,
    JSON.stringify(report, null, 2),
  );

  return { status: completeVerdict ? "locked" : "blocked" };
}
