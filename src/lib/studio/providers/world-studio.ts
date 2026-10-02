/** PR-4：World Studio Capability Provider
 * 跨席位服務：asset registry / procedural scene graph / rig / render / U1.5 round trip
 * 被 Art / Boards / Layout / Motion / PictureQC 多席位調用 */

import type {
  CapabilityProvider, ProviderDescriptor, ProviderJobRef,
  ProviderJobStatus, ProviderResult, CapabilityRequest,
} from "../shared/provider-protocol";
import type { ArtifactRef } from "../shared/artifact-ref";
import type { ReceiptRef } from "../shared/receipt";

export const WORLD_STUDIO_ENDPOINT = process.env.WORLD_STUDIO_URL ?? "http://127.0.0.1:8791";

const descriptor: ProviderDescriptor = {
  providerId: "world_studio",
  capabilities: [
    "procedural_character", "procedural_object", "procedural_world",
    "rig_retarget", "browser_render", "motion_proof", "u15_round_trip",
    "asset_registry", "scene_graph",
  ],
  mode: "observe",
  version: "1.0.0",
};

export const worldStudioProvider: CapabilityProvider = {
  describe(): ProviderDescriptor { return descriptor; },

  async submit(request: CapabilityRequest): Promise<ProviderJobRef> {
    const res = await fetch(`${WORLD_STUDIO_ENDPOINT}/api/tasks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: request.subject,
        request: request.requiredOutputs,
        constraints: request.constraints,
      }),
    });
    if (!res.ok) throw new Error(`world_studio_submit_fail: ${res.status}`);
    const data = await res.json();
    return {
      providerId: "world_studio",
      jobId: data.task_id,
      idempotencyKey: `${request.subject}:${Date.now()}`,
    };
  },

  async inspect(job: ProviderJobRef): Promise<ProviderJobStatus> {
    const res = await fetch(`${WORLD_STUDIO_ENDPOINT}/api/tasks/${job.jobId}`);
    if (!res.ok) throw new Error(`world_studio_inspect_fail: ${res.status}`);
    const data = await res.json();
    const stateMap: Record<string, ProviderJobStatus["state"]> = {
      pending: "queued", running: "running", done: "completed",
      error: "failed", cancelled: "cancelled",
    };
    return {
      state: stateMap[data.state] ?? "failed",
      progress: data.progress,
      checkpointId: data.checkpoint_id,
    };
  },

  async collect(job: ProviderJobRef): Promise<ProviderResult> {
    const res = await fetch(`${WORLD_STUDIO_ENDPOINT}/api/tasks/${job.jobId}/bundle`);
    if (!res.ok) throw new Error(`world_studio_collect_fail: ${res.status}`);
    const data = await res.json();
    return {
      artifacts: data.artifacts ?? [],
      receipts: data.receipts ?? [],
      violations: data.violations,
    };
  },

  async cancel(job: ProviderJobRef): Promise<void> {
    await fetch(`${WORLD_STUDIO_ENDPOINT}/api/tasks/${job.jobId}/cancel`, { method: "POST" });
  },
};
