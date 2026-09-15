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

| 定案 | 碼現況（`h3-r2v-graph.ts` / `h3-submit.ts`） |
|---|---|
| Video 1 = blockout | ✅ variant A `ref_videos.ref_video_0` |
| kf 0%/100% = still | ✅ `H3KeyframeInject` start + optional end |
| 1 鏡 1 wav | ✅ `ref_audios.ref_audio_0` ← 呢鏡 wav |
| H3LastFrame orphan | ✅ 註明 v6 orphan |
| 一鏡一 generate + concat | ✅ 設計如此；mux 另層 |
| fail-loud 若 kf_start＝舊場 | ❌ **未做** |
| `h3_plan.json` 每鏡 | ❌ **未做**（或未齊） |
| `/h3` floor tab clinic | ❌ 雲端 328 檔 session 有；**未入呢個 remote** |
| mid 50% H3Keyframes | ❌ v6 graph 未接 |
| `h3-slots.ts` 槽位診所 | ❌ 未在 `crew-seats`／`main` |

雲端 Cursor session（`cursor/h3-four-lane-plan-*`、328 files）＝**另一個工程副本**，未 merge 入 `RICHPROPJC/ai-video-orchestrator`。  
`github/main` 已 merge 舊 `crew-seats` PR#1；**四線 lock 碼化仍欠**。

---

## 同 3D handoff 點夾

- U1.5 still（2K）＝ H3 0%/100% 嘅**唯一合法 kf 源**（呢鏡）。  
- Blockout／matte＝ Video 1 motion；灰模 look 唔靠 Tripo「升級」。  
- 資產殼（Tripo／Trellis）影響 still／blockout **上游**；唔改變「miss kf → 唔調 TTS」呢條。

---

## 下一步（Fable 對齊前）

1. 認呢份為 **H3 臨時定案**。  
2. 碼化欠項：`h3_plan.json` + kf_start≠prev still fail-loud +（可選）slots clinic／`/h3` tab。  
3. 雲端 328 檔若要入：cherry-pick **H3 四線相關**，唔好整 repo 蓋過 `crew-seats`。  
4. Mid-% keyframe = 另卡（Mo），唔當而家 variant A 已有。
