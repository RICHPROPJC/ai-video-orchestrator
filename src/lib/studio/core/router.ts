/** PR-3 §1：Capability Router——四級路由
 * 資產級、世界級、鏡頭級、Reference Packet級。
 * 先 observe（記錄決定）唔 enforce（唔阻止舊路徑）。 */

import type { CapabilityRequest, ProviderMode } from "../shared/provider-protocol";
import type { RouteDecision } from "./router-types";
import type { DirectionLanguage } from "../shared/director-intent";
import type { ReceiptRef } from "../shared/receipt";

// Provider 註冊表（observe 階段：記錄唔阻止）
export const PROVIDER_REGISTRY: Map<string, { mode: ProviderMode; capabilities: string[] }> = new Map([
  ["procedural_threejs_v1", { mode: "observe", capabilities: ["character_reference", "object_reference", "world_reference", "procedural_asset", "rig_retarget", "browser_render", "motion_proof", "u15_round_trip"] }],
  ["legacy_sf3d", { mode: "fallback", capabilities: ["mesh_generation", "object_mesh"] }],
  ["legacy_skin_tokens", { mode: "fallback", capabilities: ["rig_generation", "skin_weights"] }],
  ["h3_ref2va", { mode: "default", capabilities: ["video_generation_multimodal"] }],
  ["h3_fl2va", { mode: "default", capabilities: ["video_generation_image_to_video"] }],
  ["u15_edit", { mode: "default", capabilities: ["image_edit", "reference_completion", "appearance_enhancement"] }],
]);

export function routeAsset(req: CapabilityRequest): RouteDecision {
  const rejected: Array<{ provider: string; reason: string }> = [];
  let selected = "";

  for (const [id, p] of PROVIDER_REGISTRY) {
    if (p.mode === "disabled" || p.mode === "retired") continue;
    const canHandle = req.requiredOutputs.every(out => p.capabilities.includes(out));
    if (!canHandle) {
      rejected.push({ provider: id, reason: `missing capability: ${req.requiredOutputs.filter(o => !p.capabilities.includes(o)).join(",")}` });
      continue;
    }
    if (p.mode === "default" || (p.mode === "observe" && !selected)) {
      selected = id;
    }
  }

  // observe 模式：記錄決定，唔阻止舊路徑
  return {
    selectedProvider: selected || "legacy_sf3d",
    rejectedProviders: rejected,
    receiptId: "", // PR-4 填
  };
}

export function routeWorld(req: CapabilityRequest): RouteDecision {
  return routeAsset({ ...req, subject: "world" });
}

export function routeShot(req: CapabilityRequest): RouteDecision {
  const intent = req.intent as DirectionLanguage | undefined;
  let h3Route: "ref2va" | "fl2va" | "hybrid" = "ref2va";

  if (intent?.contact?.required || intent?.motionIntent?.action?.contactTarget) {
    // 需要接觸/手部動作 → ref2va（有多模態ref槽）
    h3Route = "ref2va";
  } else if (!intent?.motionIntent?.action?.path) {
    // 冇明確動作路徑 → fl2va（首尾圖+文字）
    h3Route = "fl2va";
  } else {
    h3Route = "hybrid";
  }

  const decision = routeAsset(req);
  return { ...decision, selectedH3Route: h3Route };
}

export function routeReferencePacket(req: CapabilityRequest): RouteDecision {
  const shotDecision = routeShot(req);
  const motionSource =
    shotDecision.selectedH3Route === "ref2va" ? "multimodal_reference"
    : shotDecision.selectedH3Route === "fl2va" ? "text_driven"
    : "rigged_motion";

  return { ...shotDecision, motionSource };
}

export function getProviderMode(id: string): ProviderMode {
  return PROVIDER_REGISTRY.get(id)?.mode ?? "disabled";
}

export function setProviderMode(id: string, mode: ProviderMode): void {
  const p = PROVIDER_REGISTRY.get(id);
  if (p) p.mode = mode;
}
