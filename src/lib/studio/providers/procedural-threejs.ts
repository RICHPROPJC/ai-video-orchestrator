/** PR-4：Procedural Three.js Provider（img2threejs 路線）*/
import type {
  CapabilityProvider, ProviderDescriptor, ProviderJobRef,
  ProviderJobStatus, ProviderResult, CapabilityRequest,
} from "../shared/provider-protocol";

const descriptor: ProviderDescriptor = {
  providerId: "procedural_threejs_v1",
  capabilities: [
    "character_reference", "object_reference", "world_reference",
    "procedural_asset", "rig_retarget", "browser_render", "motion_proof",
  ],
  mode: "observe",
  version: "1.0.0",
};

export const proceduralThreejsProvider: CapabilityProvider = {
  describe(): ProviderDescriptor { return descriptor; },

  async submit(request: CapabilityRequest): Promise<ProviderJobRef> {
    // img2threejs pipeline integration（observe階段：記錄唔阻止）
    return { providerId: "procedural_threejs_v1", jobId: `pts_${Date.now()}`, idempotencyKey: "" };
  },
  async inspect(job: ProviderJobRef): Promise<ProviderJobStatus> { return { state: "completed" }; },
  async collect(job: ProviderJobRef): Promise<ProviderResult> { return { artifacts: [], receipts: [] }; },
};
