/** PR-0 §10：CapabilityProvider 異步接口——World Studio 等服務嘅正式合同 */

export type ProviderMode =
  | "disabled" | "shadow" | "observe" | "candidate" | "default" | "fallback" | "retired";

export interface ProviderDescriptor {
  providerId: string;
  capabilities: string[];
  mode: ProviderMode;
  version: string;
}

export interface CapabilityRequest {
  subject: "character" | "object" | "world" | "shot" | "reference_packet";
  intent?: unknown; // DirectionLanguage from director-intent.ts
  requiredOutputs: string[];
  constraints: {
    exactFrame?: boolean;
    retargetable?: boolean;
    contactRequired?: boolean;
    identityCritical?: boolean;
    editableSceneGraph?: boolean;
  };
}

export interface ProviderJobRef {
  providerId: string;
  jobId: string;
  idempotencyKey: string;
}

export interface ProviderJobStatus {
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress?: number;
  checkpointId?: string;
}

export interface ProviderResult {
  artifacts: unknown[];
  receipts: unknown[];
  violations?: unknown[];
}

export interface CapabilityProvider {
  describe(): ProviderDescriptor;
  submit(request: CapabilityRequest): Promise<ProviderJobRef>;
  inspect(job: ProviderJobRef): Promise<ProviderJobStatus>;
  collect(job: ProviderJobRef): Promise<ProviderResult>;
  cancel?(job: ProviderJobRef): Promise<void>;
}

// DirectorIntent 佔位（PR-0 §5 定義完整版）
export interface DirectorIntent {
  version: number;
  attention?: unknown;
  motionIntent?: unknown;
  contact?: unknown;
  deformation?: unknown;
  cameraIntent?: unknown;
  lightingIntent?: unknown;
  audioCues?: unknown[];
}
