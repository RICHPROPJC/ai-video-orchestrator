export interface RouteDecision {
  selectedProvider: string;
  selectedH3Route?: "ref2va" | "fl2va" | "hybrid";
  motionSource?: "rigged_motion" | "multimodal_reference" | "text_driven";
  rejectedProviders: Array<{ provider: string; reason: string }>;
  receiptId: string;
}
