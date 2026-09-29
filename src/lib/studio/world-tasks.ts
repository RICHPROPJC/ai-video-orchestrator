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

/** 刀4：succeeded task 嘅 blockout_frames 接駁——拉 World 側逐 frame 檔落
 *  本地目錄（contract §4/§6：frames 係目錄，files 路由只回檔——逐檔拉）。
 *  bundle 逐檔清單欄名 named unknown（未見真 task 數據）→probe 版：
 *  ①bundle.artifacts 內 kind=blockout_frames 嘅 logicalPath 當目錄根，
 *  frame_%04d.png 序列逐個 GET files 路由，404 即停（frameCount 上限自
 *  bundle.frameRange.frameCount，冇就 9999 防走火）；②連第一幀都 404＝
 *  回 0（caller named blocked）。真 task 到場後按實際清單欄收緊。 */
export async function pullWorldBlockoutFrames(
  cfg: SlateConfig,
  projectId: string,
  taskId: string,
  outDir: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ frames: number; framesDir?: string; error?: string }> {
  const bundle = await readWorldTaskBundle(cfg, taskId);
  const artifacts = Array.isArray(bundle["artifacts"]) ? (bundle["artifacts"] as { kind?: string; logicalPath?: string }[]) : [];
  const framesArt = artifacts.find((a) => a.kind === "blockout_frames" && a.logicalPath);
  if (!framesArt?.logicalPath) return { frames: 0, error: "bundle 無 blockout_frames artifact（named unknown——真 task 數據到場收緊）" };
  const range = (bundle["frameRange"] ?? {}) as { frameCount?: number };
  const cap = typeof range.frameCount === "number" && range.frameCount > 0 ? range.frameCount : 9999;
  const fs = await import("node:fs");
  fs.mkdirSync(outDir, { recursive: true });
  let n = 0;
  for (let i = 1; i <= cap; i++) {
    const name = `frame_${String(i).padStart(4, "0")}.png`;
    const r = await fetchImpl(
      `${cfg.world.base}/api/projects/${projectId}/files/${framesArt.logicalPath}/${name}`,
      { cache: "no-store" },
    );
    if (!r.ok) break;
    const buf = Buffer.from(await r.arrayBuffer());
    fs.writeFileSync(`${outDir}/${name}`, buf);
    n++;
  }
  return n > 0 ? { frames: n, framesDir: outDir } : { frames: 0, error: `files 路由喺 ${framesArt.logicalPath} 下零 frame（404？）` };
}
