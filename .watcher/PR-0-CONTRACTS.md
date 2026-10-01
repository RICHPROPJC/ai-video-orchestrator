# PR-0：契約凍結與基線
## SlateCrew Refactor · 2026-10-02 · APPROVED

零行為改動。只產出文檔、類型、測試基線。

---

## 1. 狀態轉移表

```typescript
// shared/state-machine.ts — 唯一合法寫入口
export type SeatStatus =
  | "PENDING" | "READY" | "RUNNING"
  | "PASSED" | "PARTIAL" | "BLOCKED"
  | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "SKIPPED" | "SUPERSEDED";

export interface StateTransition {
  from: SeatStatus;
  event: string;
  to: SeatStatus;
  sameAttempt: boolean;
}

export const TRANSITIONS: StateTransition[] = [
  { from: "PENDING",          event: "dependencies_ready",   to: "READY",            sameAttempt: true },
  { from: "READY",            event: "lease_acquired",       to: "RUNNING",          sameAttempt: true },
  { from: "RUNNING",          event: "checkpoint_saved",     to: "RUNNING",          sameAttempt: true },
  { from: "RUNNING",          event: "completed",            to: "PASSED",           sameAttempt: true },
  { from: "RUNNING",          event: "completed_partial",    to: "PARTIAL",          sameAttempt: true },
  { from: "RUNNING",          event: "blocked",              to: "BLOCKED",          sameAttempt: true },
  { from: "RUNNING",          event: "failed_retryable",     to: "FAILED_RETRYABLE", sameAttempt: true },
  { from: "RUNNING",          event: "failed_terminal",      to: "FAILED_TERMINAL",  sameAttempt: true },
  { from: "RUNNING",          event: "lease_expired",        to: "READY",            sameAttempt: true }, // 未提交產物可續
  { from: "RUNNING",          event: "skipped",              to: "SKIPPED",          sameAttempt: true },
  { from: "BLOCKED",          event: "dependency_resolved",  to: "READY",            sameAttempt: true },
  { from: "BLOCKED",          event: "unblocked_new_attempt",to: "SUPERSEDED",       sameAttempt: false },
  { from: "FAILED_RETRYABLE", event: "retry_authorized",     to: "READY",            sameAttempt: true },
  { from: "FAILED_RETRYABLE", event: "replacement_authorized",to: "SUPERSEDED",      sameAttempt: false },
  { from: "PASSED",           event: "repair_requested",     to: "SUPERSEDED",       sameAttempt: false },
  { from: "PARTIAL",          event: "repair_requested",     to: "SUPERSEDED",       sameAttempt: false },
  { from: "PARTIAL",          event: "accepted_partial",     to: "PASSED",           sameAttempt: true },
  { from: "FAILED_TERMINAL",  event: "replacement_authorized",to: "SUPERSEDED",      sameAttempt: false },
  { from: "SKIPPED",          event: "reactivated",          to: "PENDING",          sameAttempt: true },
];

// 唯一合法狀態寫入——所有席位必須經過呢個函數
export function transition(
  current: SeatStatus,
  event: string,
): { next: SeatStatus; sameAttempt: boolean } {
  const t = TRANSITIONS.find(x => x.from === current && x.event === event);
  if (!t) throw new Error(`state_transition_invalid: ${current} + ${event}`);
  return { next: t.to, sameAttempt: t.sameAttempt };
}
```

## 2. Attempt 三層結構

```
attempt/
├── runtime/          # CAS 可更新：lease、heartbeat、checkpoint pointer、progress events
├── staging/          # 臨時產物，未進入 lineage，crash 後可安全刪除
└── committed/        # append-only / immutable：finalized artifact、SHA-256、receipt、terminal result
```

規則：
- 只有 `committed/` 內嘅產物可以成為 `ArtifactRef`
- `staging/` → `committed/` 係原子操作（rename 或 copy + verify SHA）
- `committed/` 內容永不修改、永不刪除
- `runtime/` 任何時候可被接管（新 owner 覆寫 lease）

## 3. ArtifactRef

```typescript
export type ArtifactKind =
  | "callsheet" | "continuity" | "board" | "portrait" | "mesh"
  | "rig" | "world_plan" | "blockout_video" | "keyframe_image"
  | "motion_clip" | "h3_video" | "audio_wav" | "timing_ledger"
  | "cut_plan" | "qc_report" | "delivery_package" | "reference_packet"
  | "procedural_asset" | "render_frame" | "motion_proof" | "manifest";

export type ArtifactAvailability = "staging" | "committed" | "missing";

export interface ArtifactRef {
  artifactId: string;          // art_<ulid>
  kind: ArtifactKind;
  uri: string;                 // artifact://jobId/attemptId/kind/filename
  mediaType: string;           // image/png, video/mp4, application/json...
  sizeBytes: number;
  sha256: string;
  schemaVersion: number;
  createdAt: string;           // ISO 8601
  availability: ArtifactAvailability;
  producer: {
    seat: string;              // AgentId
    capability: string;        // e.g. "character_reference"
    provider: string;          // e.g. "u15_edit", "img2threejs", "h3_ref2va"
  };
  lineage: {
    jobId: string;
    attemptId: string;
    buildBase: string;         // commit SHA
    inputArtifactIds: string[];
  };
}
```

## 4. Receipt Schema

```typescript
export type ReceiptKind =
  | "provider_execution"     // 工具執行收據（LLM call、Blender render、H3 submit）
  | "artifact_commit"        // staging→committed 原子提交
  | "artifact_consumption"   // 下游實際讀取上游產物
  | "gate_evaluation"        // QC gate 判定
  | "route_decision";        // Capability Router 路由決定

export interface ReceiptRef {
  receiptId: string;          // rcp_<ulid>
  kind: ReceiptKind;
  schemaVersion: number;
  artifactId?: string;        // 關聯 artifact（execution 唯未必有）
  producerAttemptId: string;
  consumerAttemptId?: string; // consumption receipt 必有
  sha256: string;             // receipt 內容 SHA
  createdAt: string;
  payload: Record<string, unknown>; // kind-specific
}
```

**關鍵**：冇 consumption receipt = 唔可以證明 H3/U1.5/World Studio 實際用過輸入。

## 5. Idempotency

```typescript
// 冪等鍵——防同一 logical operation 重複執行
// 唔含 checkpoint（每個 checkpoint 會產生新 key）
export function idempotencyKey(
  jobId: string,
  attemptId: string,
  seatId: string,
  capability: string,
  inputManifestSha: string,
): string {
  return `${jobId}:${attemptId}:${seatId}:${capability}:${inputManifestSha}`;
}

// Resume token——指示從哪裡繼續（唔係冪等鍵）
export interface ResumeToken {
  checkpointId: string;
  checkpointSha: string;
}
```

## 6. Provider 七態

```typescript
export type ProviderMode =
  | "disabled"   // 不可用
  | "shadow"     // 執行但不影響用戶產物
  | "observe"    // 可被顯式調用，不自動選中
  | "candidate"  // 參與 Router 排序
  | "default"    // 默認生產 Provider
  | "fallback"   // default 失敗或不滿足能力時使用
  | "retired";   // 只准讀舊 artifact，不准建新任務
```

## 7. Router 四級

```typescript
// 四級路由——資產、世界、鏡頭、reference packet
export interface CapabilityRequest {
  subject: "character" | "object" | "world" | "shot" | "reference_packet";
  intent?: DirectorIntent;
  requiredOutputs: ArtifactKind[];
  constraints: {
    exactFrame?: boolean;
    retargetable?: boolean;
    contactRequired?: boolean;
    identityCritical?: boolean;
    editableSceneGraph?: boolean;
  };
}

export function routeAsset(req: CapabilityRequest): RouteDecision;
export function routeWorld(req: CapabilityRequest): RouteDecision;
export function routeShot(req: CapabilityRequest): RouteDecision;
export function routeReferencePacket(req: CapabilityRequest): RouteDecision;

export interface RouteDecision {
  selectedProvider: string;
  selectedH3Route?: "ref2va" | "fl2va" | "hybrid";
  motionSource?: "rigged_motion" | "multimodal_reference" | "text_driven";
  rejectedProviders: Array<{ provider: string; reason: string }>;
  receiptId: string;  // route_decision receipt
}
```

## 8. U1.5 Round Trip

```typescript
export interface ReferenceRoundTrip {
  roundTripId: string;
  inputArtifactId: string;
  provider: "u15_edit";
  purpose: "turnaround" | "appearance_enhancement" | "material_reference" | "view_completion";
  outputArtifactId: string;
  requestReceipt: ReceiptRef;
  providerVersion: string;
  promptArtifactId: string;
  parametersArtifactId: string;
  outputSha256: string;
  reviewedBy: string;          // SeatId
  accepted: boolean;
  acceptedFor: string[];       // artifact kinds accepted as reference for
  acceptedAt?: string;
  rejectionReasons?: ViolationRow[];
  structuralAuthority: false;  // 機器可讀：美化圖不反證3D結構正確
}
```

## 9. Procedural Asset Contract（含 Object/World）

```typescript
export interface ProceduralAssetManifest {
  schemaVersion: 1;
  assetId: string;
  class: "character" | "object" | "world-module";
  factory: ArtifactRef;
  semanticNodes: string[];
  pivots: PivotSpec[];
  sockets: SocketSpec[];
  colliders: ColliderSpec[];

  rig?: RigSpec;
  interaction?: InteractionSpec;   // Object 專用
  world?: WorldModuleSpec;         // World 專用

  renders: ArtifactRef[];
  motionProof?: ArtifactRef;
  gates: GateResult[];
}

export interface RigSpec {
  semanticNaming: boolean;
  joints: JointSpec[];
  retargetable: boolean;
  hands?: { wrists: boolean; palms: boolean; fingerSegmentsPerFinger: number };
}

export interface InteractionSpec {
  states: string[];              // e.g. ["closed", "open"]
  constraints: ConstraintSpec[]; // e.g. cap rotation limits
  affordances: AffordanceSpec[]; // e.g. "pull", "twist", "press"
  detachableParts: string[];     // e.g. ["cap"]
}

export interface WorldModuleSpec {
  zones: ZoneSpec[];
  anchors: AnchorSpec[];
  navigation: NavigationSpec;
  collisionLayers: string[];
  occlusionLayers: string[];
  cameraAnchors: CameraAnchorSpec[];
  lightAnchors: LightAnchorSpec[];
}
```

## 10. World Studio Provider Protocol

```typescript
export interface CapabilityProvider {
  describe(): ProviderDescriptor;
  submit(request: CapabilityRequest): Promise<ProviderJobRef>;
  inspect(job: ProviderJobRef): Promise<ProviderJobStatus>;
  collect(job: ProviderJobRef): Promise<ProviderResult>;
  cancel?(job: ProviderJobRef): Promise<void>;
}

export interface ProviderDescriptor {
  providerId: string;
  capabilities: string[];
  mode: ProviderMode;
  version: string;
}

export interface ProviderJobStatus {
  state: "queued" | "running" | "completed" | "failed" | "cancelled";
  progress?: number;
  checkpointId?: string;
}

export interface ProviderResult {
  artifacts: ArtifactRef[];
  receipts: ReceiptRef[];
  violations?: ViolationRow[];
}
```

## 11. Characterization Tests 清單

| Test | 驗證 |
|---|---|
| `baseline-events.test.ts` | 事件順序 snapshot（成功 job 全事件序列） |
| `baseline-job.test.ts` | job.json before/after 結構 |
| `baseline-artifacts.test.ts` | 產物清單＋SHA |
| `baseline-until.test.ts` | --until boards/blockout/stills 停止位 |
| `baseline-fail.test.ts` | 失敗＋重試事件序列 |
| `baseline-takeover.test.ts` | owner lease 過期＋接管 |
| `baseline-legacy.test.ts` | 舊 job resume |
| `baseline-perf.test.ts` | 各 stage 耗時基線 |

## 12. PR-0 交付物清單

1. `shared/state-machine.ts` — 狀態轉移表 + `transition()` 唯一寫入口
2. `shared/artifact-ref.ts` — ArtifactRef + ArtifactKind + availability
3. `shared/receipt.ts` — ReceiptRef + 5 kind schema
4. `shared/provider-protocol.ts` — CapabilityProvider 接口 + 7態枚舉
5. `shared/director-intent.ts` — DirectorIntent 類型定義
6. `shared/procedural-asset.ts` — ProceduralAssetManifest + Rig/Interaction/World
7. `shared/idempotency.ts` — idempotency key + resume token
8. `core/router-types.ts` — CapabilityRequest + RouteDecision（四級接口定義，不實現）
9. Baseline characterization tests（§11 全部）
10. Seat/Capability/Provider 依賴圖（文檔）
11. Baseline commit + buildBase 記錄

**PR-0 不改任何生產行為。**
