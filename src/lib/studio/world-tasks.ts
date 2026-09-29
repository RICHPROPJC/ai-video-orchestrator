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
