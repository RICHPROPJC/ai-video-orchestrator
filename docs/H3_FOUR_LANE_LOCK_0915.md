# H3 FOUR-LANE LOCK — temporary SSOT（2026-09-15 Chau）

Fable 稍後會同本地對齊；**而家暫時以呢份為定案**。  
對齊來源：Chau clinic 文案 + 本倉 `h3-r2v-graph.ts` variant **A**（v6 parity）。

---

## 一句

**一鏡一 generate。** 0%／100% = 呢鏡 U1.5 still。Generate 食咗舊鏡尾幀 → **只改視覺 wiring，唔郁 TTS。**

---

## 四線 = 一次 H3 submit（唔係四次 ffmpeg）

| # | 線 | 入邊 | 槽 |
|---|---|---|---|
| 1 | layout | 呢鏡 grey blockout → `ref_video_0` / `<Video 1>`（motion only） | video 槽之一 |
| 2 | stills | 呢鏡 U1.5 still → keyframe **0%** 同 **100%**（`H3KeyframeInject` start／end） | photo／kf，唔係 prev last |
| 3 | audio | 呢鏡 wav → `ref_audio_0`；**1 鏡 1 `/tts` take**（可全句）— **唔用 spine** | audio 槽 |
| 4 | motion | **一次** H3 generate＝呢鏡；下一鏡全新 0–100%；之後 `concat -c copy` | — |

槽位能力：最多 3 audio／3 photo／3 video；**唔同 job 唔同用法**。  
Variant **A**（而家工廠預設）：photos 空（身份靠 kfinject）、fl2va loaded、sampler 行 ref2va 鏈。

---

## Full-mode %＝呢次 generate，唔係成條片

| % | 應該攞 | 絕對唔攞 |
|---|---|---|
| **0%** | 呢鏡 U1.5 still（`kf_start` / `start_image`） | 上一鏡 last frame |
| **50%** | 繼續喺呢鏡入面生成 | 上一鏡 last — mid 要用 `H3Keyframes`；**v6 graph 未接**（已知缺口） |
| **100%** | 呢鏡 still／計劃 end still（`kf_end`） | 上一鏡 last frame |

**Previous last frame 政策**
- **Location hop** → **禁止**（身份被食就係呢度）
- **Same world** → 最多 `inspect_only`；**永遠唔做** `kf_start`／`ref_image`
- `H3LastFrame` 節點：**orphan 保留**（v6）；唔當下一鏡 kf_start

---

## Miss 我哋 keyframe 時 — 調校次序（永遠唔先調 TTS）

1. `kf_start`／`kf_end` 撥返呢鏡 still  
2. 所有 photo／video 槽清走 prev last  
3. `Video 1` = 呢鏡 blockout  
4. prose identity pin（同一 SKU，唔好 morph）  
5. kfinject `length` = wav snap 幀數  

**永遠唔：**
- 拆 `/tts` 去救畫面  
- xfade 兩條 H3 clip  
- 將上一鏡 H3 mp4 放入 `ref_video_1`  

收據：`motion/SHxx.h3_plan.json`；若 `kf_start`＝舊場 still → **fail loud**。（雲端 clinic 要求；**本倉尚未全部碼化**——見下。）

---

## 本倉 `crew-seats` 對照（誠實）

| 定案 | 碼現況（`h3-r2v-graph.ts` / `h3-submit.ts` / `h3-slots.ts`） |
|---|---|
| Video 1 = blockout | ✅ variant A `ref_videos.ref_video_0` |
| kf 0%/100% = still | ✅ `H3KeyframeInject` start + optional end |
| 1 鏡 1 wav | ✅ `ref_audios.ref_audio_0` ← 呢鏡 wav |
| H3LastFrame orphan | ✅ 註明 orphan；唔做下一鏡 kf_start |
| 一鏡一 generate + concat | ✅；mux／preview／picture-lock 禁 xfade（`native-cut`） |
| fail-loud 若 kf_start＝舊場 | ✅ `assertH3SubmitWiring`（exact stem，唔用 startsWith） |
| `h3_plan.json` 每鏡 | ✅ `motion/SHxx.h3_plan.json` via `writeH3Plan` |
| `/h3` floor tab clinic | ✅ `/h3` + floor `h3` tab（未接 spatial gate） |
| mid 50% H3Keyframes | ❌ v6 graph 未接 |
| `spatial-lock` / mesh dry-run | ❌ **故意未入** — 無真 job spatial／無 Tripo config |

外倉 `chau-ch/refill` 只係參考；**好料已搬入本倉 `crew-seats`**，唔再餵肥外面。  
`assertNoOuterGap` **未接** pipeline（LD0F `gap_s=0` 但 spine gap 路徑仍保留）。  
prose：`buildProse` 會寫 Hold + not-a-morph；`validateProse` **唔強制**舊 WIST receipt 啲字 —— resume 安全。

---

## 同 3D handoff 點夾

- U1.5 still（2K）＝ H3 0%/100% 嘅**唯一合法 kf 源**（呢鏡）。  
- Blockout／matte＝ Video 1 motion；灰模 look 唔靠 Tripo「升級」。  
- 資產殼（Tripo／Trellis）影響 still／blockout **上游**；唔改變「miss kf → 唔調 TTS」呢條。

---

## 下一步（Fable 對齊前）

1. 本倉已有四線 plan／fail-loud／`/h3` — 用真 job dry-run 驗 `h3_plan.json`。  
2. **唔入** spatial-lock／mesh dry-run，直到 LD0F 有 `spatial` 欄 + Tripo config。  
3. `gapSec` spine：要廢先廢；未廢就唔接 `assertNoOuterGap`。  
4. Mid-% keyframe = 另卡（Mo）。
