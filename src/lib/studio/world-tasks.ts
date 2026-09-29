import type { SlateConfig } from "./config";

/** 刀3（0929 ROOT world-direct）：World Studio task 契約（server 側）——
 *  producer contract 0929（sha 5c9abaf9…）嘅 typed 封裝。World 唔存 jobId，
 *  綁定真源＝Job.worldBinding（types.ts）；idempotencyKey 原鑰重 POST 回同一
 *  task 唔開新 attempt。blocked/render_not_authorized＝開關閉（契約 §5，
 *  唔當 succeeded 亦唔重試到通）；needs_reconcile 行 reconcile 決策唔自動重開。 */

export type WorldTaskView = {
  id: string;
  projectId?: string;
  kind?: string;
  state?: string;
  progress?: number;
  error?: string;
  idempotencyKey?: string;
  artifacts?: { id?: string; kind?: string; logicalPath?: string; sha256?: string; status?: string }[];
  attempts?: Record<string, unknown>[];
};

/** 第一單 render 契約 task：idempotencyKey=jobId:shotId:blockout（crew 語義，
 *  原鑰重 POST 回同筆唔開新 attempt）。body.shotId＝World 側 sht_ id（contract
 *  §1——唔係 crew shot id）。返回 task view；HTTP 唔通/非 2xx 照 throw，
 *  caller named emit 唔殺 job。 */
export async function submitWorldBlockoutTask(
  cfg: SlateConfig,
  binding: { projectId: string },
  jobId: string,
  shotId: string,
  worldShotId: string,
  sceneId?: string,
): Promise<WorldTaskView> {
  const body = {
    kind: "blender.blockout_render",
    idempotencyKey: `${jobId}:${shotId}:blockout`,
    ...(sceneId ? { sceneId } : {}),
    shotId: worldShotId,
  };
  const r = await fetch(`${cfg.world.base}/api/projects/${binding.projectId}/tasks`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-writer-id": `crew:${jobId}` },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`world task POST HTTP ${r.status}`);
  return (await r.json()) as WorldTaskView;
}

/** 查一筆 task（GET /api/tasks/{taskId}）——狀態/artifacts/attempts 真源。 */
export async function readWorldTask(cfg: SlateConfig, taskId: string): Promise<WorldTaskView> {
  const r = await fetch(`${cfg.world.base}/api/tasks/${taskId}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`world task GET HTTP ${r.status}`);
  return (await r.json()) as WorldTaskView;
}

/** 凍結收據（GET /api/tasks/{taskId}/bundle）——frameRange 半開時鐘＋逐檔 sha。 */
export async function readWorldTaskBundle(cfg: SlateConfig, taskId: string): Promise<Record<string, unknown>> {
  const r = await fetch(`${cfg.world.base}/api/tasks/${taskId}/bundle`, { cache: "no-store" });
  if (!r.ok) throw new Error(`world bundle GET HTTP ${r.status}`);
  return (await r.json()) as Record<string, unknown>;
}

/** needs_reconcile/blocked/failed/cancelled 後嘅續筆決策（contract §3.3）。
 *  decision 只收 accept_failed | retry。 */
export async function reconcileWorldTask(
  cfg: SlateConfig,
  taskId: string,
  decision: "accept_failed" | "retry",
): Promise<WorldTaskView> {
  const r = await fetch(`${cfg.world.base}/api/tasks/${taskId}/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-writer-id": taskId },
    body: JSON.stringify({ decision }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`world reconcile POST HTTP ${r.status}`);
  return (await r.json()) as WorldTaskView;
}

/** 刀4收緊（FROM-WORLD 1001a262 實測）：succeeded task 嘅 blockout_frames
 *  接駁——幀名照 bundle artifacts[].files[].logicalPath 真源（World 側
 *  frameFilesNote 明言「唔好猜 frame_0001」——幀號由 frameOrigin 起，實測
 *  tsk_d570150edbb9 首張 frame_0505.png）。files=null＝路徑不在碟、空 array
 *  ＝empty 目錄——兩者都唔係完成（named 回 0）。逐檔 GET files 路由落碟＋
 *  sha256 對賬（對唔到 named，唔照收）。舊 bundle 冇 files 欄＝named 舊格式。 */
export async function pullWorldBlockoutFrames(
  cfg: SlateConfig,
  projectId: string,
  taskId: string,
  outDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ frames: number; framesDir?: string; error?: string; shaMismatch?: string[] }> {
  const bundle = await readWorldTaskBundle(cfg, taskId);
  const artifacts = Array.isArray(bundle["artifacts"])
    ? (bundle["artifacts"] as { kind?: string; logicalPath?: string; files?: { logicalPath?: string; sha256?: string; bytes?: number }[] | null }[])
    : [];
  const framesArt = artifacts.find((a) => a.kind === "blockout_frames");
  if (!framesArt) return { frames: 0, error: "bundle 無 blockout_frames artifact" };
  if (!("files" in framesArt) || framesArt.files === undefined) {
    return { frames: 0, error: `舊格式 bundle（${framesArt.logicalPath ?? "?"} 冇 files 清單欄——World 側新 source 先有，重跑 task 先有清單）` };
  }
  if (framesArt.files === null) return { frames: 0, error: `files=null：路徑 ${framesArt.logicalPath ?? "?"} 不在磁碟（frameFilesNote：唔係完成）` };
  if (framesArt.files.length === 0) return { frames: 0, error: `empty：目錄 ${framesArt.logicalPath ?? "?"} 存在但零檔（frameFilesNote：唔係完成）` };
  const fs = await import("node:fs");
  const { createHash } = await import("node:crypto");
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  const shaMismatch: string[] = [];
  for (const f of framesArt.files) {
    if (!f.logicalPath) continue;
    const r = await fetchImpl(`${cfg.world.base}/api/projects/${projectId}/files/${f.logicalPath}`, { cache: "no-store" });
    if (!r.ok) return { frames: n, error: `GET ${f.logicalPath} HTTP ${r.status}（清單話有但拉唔到——named，唔照收）`, shaMismatch };
    const buf = Buffer.from(await r.arrayBuffer());
    // 本地重編 frame_%04d（1..N 按清單序）——World 幀名由 frameOrigin 起
    // （實測 frame_0505 起），唔保證連續由 1；ffmpeg image2 序列讀本地重編版。
    // sha 對賬照清單做（源真源），本地名純接駁產物零資訊損失。
    const local = `${outDir}/frame_${String(n + 1).padStart(4, "0")}.png`;
    fs.writeFileSync(local, buf);
    if (f.sha256) {
      const got = createHash("sha256").update(buf).digest("hex");
      if (got !== f.sha256) shaMismatch.push(`${f.logicalPath}: 清單 ${f.sha256.slice(0, 8)} vs 實收 ${got.slice(0, 8)}`);
    }
    n++;
  }
  if (shaMismatch.length) {
    // 新統籌 review（0930）：sha 對唔到回 frames>0 會令 world.ts 分流照 ffmpeg
    // 接駁污染幀——「唔照收」貫徹＝frames:0（caller 睇 frames>0 先接駁）。
    return { frames: 0, error: `${shaMismatch.length} 檔 sha256 對唔到（named，唔照收——零幀回）`, shaMismatch };
  }
  return { frames: n, framesDir: outDir };
}
