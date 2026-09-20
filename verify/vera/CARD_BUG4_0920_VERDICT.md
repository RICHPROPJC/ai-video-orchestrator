# CARD_BUG4_0920_VERDICT — Vera 獨立核實（2026-09-20）

**結論：MERGE_OK** — 六個驗收點全部過，981f33a 可交 Grok sequential-merge。附一條收據修正（tsc「零新錯」唔準，見 F-1，唔構成 hold）。

標的：commit `981f33a`（lane/front，worktree `/mnt/ssd/crew-wt/front`，5 files +429/−54）。
方法：全部親跑，冇信收據。src read-only，front worktree 零改動（基線對照用 `git archive 981f33a^` 抽去 `/tmp/vera-bug4-base-0920` 獨立跑）。

## 驗收表

| # | 點 | 結果 | 證據 |
|---|---|---|---|
| 1 | 核心改動：runPhotoQc 入 stills 迴圈，逐鏡即判 | PASS | pipeline.ts diff：geometry 預檢（per-shot `localPictureQc({stills:[out], sheet:{...timed, shots:[shot]}})`）＋`runPhotoQc`＋阿圖 location 重寫＋通用 retry＋兩次唔過 blocked（blocked patch 仲加埋 `outputs.stills` 記錄）全部搬入迴圈；`editInputs` Map／`greenAlready` Set 已刪。T44 原封：`pinQcAccepted`（photo-qc.ts:201，唔喺 commit 內）硬性 `status==="GREEN"`＋sha256 hash-match；PASS_UNCONFIRMED 只出現喺 job-index.test.ts（既有 enum 用法），ref 邏輯零命中 |
| 2 | 兩鏡序列 test | PASS | `bun src/lib/studio/pipeline-chain-qc.test.ts` → **2/2**。GREEN 路：SH02 refs 含 `stills/SH01.png`、`image:SH01` 冇 ref_rejected、事件序「SH01 GREEN」<「SH02 /edit 完成」、pin 經真 `pinQcAccepted` sha 驗證、status stills-ready。FAIL 路：edits 只有 SH01（初＋retry 一次）、SH02 冇 /edit 冇 still 檔、冇 still 做過 ref、status blocked＋「連續兩次唔過」。test 用真 `pinQcAccepted`＋真 admit 閘，淨係 mock 四條 HTTP lane |
| 3 | bypass 剷除 | PASS | `grep editInputs\|greenAlready\|本輪 stills 鏈` pipeline.ts → 零命中。admit 閘統一：`c.kind === "image" && !pinQcAccepted(stillDir, c.shotId!)` → ref_rejected（pipeline.ts:634），同 portrait 閘（:631）同一法律 |
| 4 | 既有 test | PASS | 親跑：`bun pipeline.test.ts` **8/8**；`bun keyframe-prompt.test.ts` **23/23**（含新 L1b loadBaseCast test）；`npx tsx --test src/lib/studio/*.test.ts` → **261 pass / 3 fail / 11 skip**（fail＝doctor.test 1＋reflector.test 2）。基線獨立核實：喺 `981f33a^` 快照跑同一兩個檔，**同名 3 個 fail 原樣重現** → 基底本紅，同 bug4 無關 |
| 5 | 冇越界 | PASS | 5 files 全 lane/front 範圍；`git branch --contains 981f33a` 只有 lane/front；remote refs（github/origin）冇一個含 981f33a → 未 push；crew-seats tip `2541b53`（01:46，早過本 commit）＋seats/* dirty 檔同本 commit 零重疊；front worktree 他人 dirty 三檔（`.env.example`、`crew.ts`、`seat-charters.ts`）唔喺 commit 入面、原封；test 全程 mock HTTP，無服務接觸面，零停服證據 |
| 6 | loadBaseCast 幽靈 | PASS | keyframe-prompt.ts 補真身：讀 `projects/<drama>/base/cast.json`，冇檔／壞 JSON／空 roster 一律 undefined＝冇 override；wardrobe override 融入 `keyframeEditPrompt`。tsc 輸出 **TS2305 零命中** |

## 收據修正（唔 hold，但要入帳）

**F-1**：收據話「tsc 18 錯全屬基底、零新錯」——**唔準**。實測基線（`981f33a^` 全樹＋同一 node_modules）**19 錯**，而家 **26 錯**：新 `pipeline-chain-qc.test.ts` 帶嚟 **8 個新 type-only 錯**（2×TS2322 Shot fixture、4×TS18047 `job` possibly-null、1×TS2353 `rank`、1×TS2307 bun:test）。降級理由：(a) 全部困喺新 test 檔，src 本身 16→15 錯（淨係 TS2305 幽靈消失，零新 src 錯）；(b) 零 runtime 影響——bun 實跑 2/2、tsx skip；(c) bun:test TS2307 呢類 baseline 已有（pipeline.test.ts L95）；(d) 本 repo tsc --noEmit 唔係 merge 閘（基線本身紅 19）。另：收據 tsx「3 fail 係 doctor 1＋reflector 2」與實測吻合，該點無問題。

## Handover

- 給 Grok：lane/front `981f33a` 可以 sequential-merge 入 crew-seats。merge 時留意 crew-seats 嗰邊 `seats/*` 同 `.gitignore` 有他人 dirty，照既有 sequential 流程處理，唔關本卡事。
- 給 Ivo（下次收據）：tsc 錯誤數要報基線對照數（19），新 test 檔 8 個 type 錯唔好報「零新錯」；可以跟手執（fixture 補 `Shot` 必填欄、`job` non-null 斷言、`rank` 入型別），唔阻塞。
- 本卡零改動 src；front worktree 淨係多咗 `/mnt/ssd/crew-wt/front/verify/vera/CARD_BUG4_0920_VERDICT.md`（本檔）。基線對照殘留喺 `/tmp/vera-bug4-base-0920/`（tmp，可任刪）。
