# SlateCrew 重構 Spec v3（照 Raccoon review 修訂）
## APPROVE WITH CHANGES · SlateLead · 2026-10-02

---

## 核心改動（vs v2）

| v2 錯 | v3 改 |
|---|---|
| 12席=12個code目錄 | **三層架構：Seat → Capability → Provider** |
| Router 只管每鏡 | **routeAsset/routeWorld/routeShot 三級路由** |
| SeatResult={ok,artifacts[]} | **強類型 ArtifactRef＋lineage＋receipt＋狀態機** |
| Gap修復=返writer重跑 | **Repair Planner 按 provenance 搵最近可修生產者** |
| World Studio 塞入 layout | **跨席位 Capability Provider** |
| 冇U1.5回饋 | **U1.5 round trip 寫入合同** |
| 3Pi並行5-8小時 | **PR-0~PR-6 分階段，先凍結契約再搬** |

## 三層架構

```
Orchestrator
  └─ Seat（職責、審批、業務語義）
       └─ Capability（可執行能力）
            └─ Provider（具體工具/路線）

例：Art Seat
  Capabilities: character_reference | object_reference | procedural_asset
  Providers: u15_edit | img2threejs | legacy_sf3d(fallback) | legacy_skin_tokens(fallback)
```

## 強類型合同

```typescript
type SeatStatus =
  | "passed" | "partial" | "blocked"
  | "failed_retryable" | "failed_terminal" | "skipped";

interface ArtifactRef {
  artifactId: string;
  kind: ArtifactKind;
  path: string;
  sha256: string;
  schemaVersion: number;
  producer: { seat: SeatId; capability: string; provider: string };
  lineage: { jobId: string; attemptId: string; buildBase: string; inputs: string[] };
}

interface SeatResult {
  status: SeatStatus;
  artifacts: ArtifactRef[];
  violations: ViolationRow[];
  gaps: CapabilityGap[];
  receipts: ReceiptRef[];
  checkpoint?: CheckpointRef;
  retry?: { allowed: boolean; reason: string; budgetCost: number };
}
```

## 持久化狀態機

```
PENDING → READY → RUNNING → PASSED / PARTIAL / BLOCKED / FAILED_RETRYABLE / FAILED_TERMINAL / SKIPPED
                                                        ↓
                                                   SUPERSEDED（新 attempt 取代）
```

規則：
- attempt 不可變：產物/receipt 永不覆寫
- crash 後 owner lease 過期 → 新 owner 從最後 checkpoint 恢復
- 同席位重入冪等（idempotency key = attemptId + seatId + checkpoint）

## Repair Planner

```
violation → 搵 artifact provenance → 最近可修生產者 → 新 attempt 修嗰一節
```

| Gap | 返邊個 |
|---|---|
| 劇情意圖不完整 | writer |
| 分鏡不可讀 | boards |
| 人物身份板缺失 | art |
| 無手骨/無socket | procedural asset capability |
| 世界錨點缺失 | World Studio |
| H3參數不兼容 | packet compiler |
| 音頻cue不一致 | voice/sound |

## World Studio = 跨席位 Provider

```
World Studio Service
├─ asset registry
├─ procedural scene graph
├─ rig / motion / retarget
├─ layout / blockout
├─ reference render（瀏覽器）
├─ motion proof
└─ U1.5 round trip
```

Art / Boards / Layout / Motion / PictureQC 都可以調用佢。

## U1.5 Round Trip

```typescript
interface ReferenceRoundTrip {
  roundTripId: string;
  inputArtifactId: string;
  provider: "u15_edit";
  purpose: "turnaround" | "appearance_enhancement" | "material_reference" | "view_completion";
  outputArtifactId: string;
  accepted: boolean;
  acceptedFor: string[];
}
```

注意：U1.5 美化圖唔自動反證 3D 結構正確。

## Procedural Asset Contract

```typescript
interface ProceduralAssetManifest {
  schemaVersion: 1;
  assetId: string;
  class: "character" | "object" | "world-module";
  factory: ArtifactRef;
  semanticNodes: string[];
  pivots: PivotSpec[];
  sockets: SocketSpec[];
  colliders: ColliderSpec[];
  rig?: {
    semanticNaming: boolean;
    joints: JointSpec[];
    retargetable: boolean;
    hands?: { wrists: boolean; palms: boolean; fingerSegmentsPerFinger: number };
  };
  renders: ArtifactRef[];
  motionProof?: ArtifactRef;
  gates: GateResult[];
}
```

## SF3D / Skin Tokens 退役（註冊為 legacy provider）

```yaml
providers:
  procedural_threejs_v1: { state: observe }
  legacy_sf3d: { state: fallback }
  legacy_skin_tokens: { state: fallback }
```

路由日誌：
```yaml
routeDecision:
  selectedProvider: procedural_threejs_v1
  rejectedProviders:
    - { provider: legacy_sf3d, reason: no_semantic_rig }
    - { provider: legacy_skin_tokens, reason: no_contact_socket }
```

## 分階段執行計劃

| PR | 內容 | 誰做 | 驗收 |
|---|---|---|---|
| **PR-0** | baseline 凍結＋characterization tests＋事件 snapshot＋席邊界圖 | 單人 | 測試全綠 |
| **PR-1** | 執行內核：orchestrator+state-machine+repair-planner+seat-contract+artifact-ref | 單人 | delivery 席做模板 |
| **PR-2** | 葉席位遷移：delivery/editor/soundQc/voice | 按模板並行 | 舊新雙跑同產物同事件 |
| **PR-3** | Reference架構：router+packet-compiler+director-intent+procedural-asset-manifest | 可並行 | observe only，唔enforce |
| **PR-4** | World Studio Provider：procedural character/object/world+rig+render+U1.5 round trip | 可並行 | 能被多席調用 |
| **PR-5** | 複雜席位遷移：motion/pictureQc/stills/layout/art/boards/writer | 逐席 | 舊新雙跑 |
| **PR-6** | Provider對照＋退役：shadow run→按類別切默認→SF3D降fallback | 單人 | 舊job不受影響 |

**PR-0 + PR-1 必須串行單人做**（建立穩定契約）。之後先可以按模板並行。

## 唔做嘅嘢

- 本次唔刪 SF3D/SkinTokens（只註冊為 fallback）
- 新能力先 observe 唔 enforce
- 唔3Pi同時拆三個區域
- 唔一天完成

## 開工前件

1. ✅ SeatResult 升級成強類型合同
2. ✅ 持久化狀態機＋attempt不可變
3. ✅ World Studio 定義為跨席位 Provider
4. ✅ procedural Three.js + U1.5 round trip 寫入 Router
