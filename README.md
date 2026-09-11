# SlateCrew / 開麥拉組

同一條交片流水線，三個皮：**TUI · CLI · Web GUI**。生圖生片**默許你已經喺跑嘅 ComfyUI**（`http://127.0.0.1:8188`）。

## 點解係 dispatch + 分鏡專職（跟 ViMax，但唔食舊 project）

[HKUDS/ViMax](https://github.com/HKUDS/ViMax) 嘅 Agent 唔係「一個 dispatcher 亂 spawn subagent」。佢係：

1. **Dispatch 去有名有職嘅 specialist**（導演 / 編劇 / **分鏡 ShotPlanning** / 生片 / VLM QC）
2. 用 **`vimax_narrative_planning`** 寫死 DAG：`brief → characters → script → storyboard → shots → camera → frames → clips → cut`
3. Artifact 只可以喺 **`.working_dir/<session>/`**。隔壁 session 當隱形。
4. 長故先用 RAG：retrieve 係為咗 **呢個故事** 嘅 global context，唔係全硬碟舊片。

我哋照呢套，再加一條死閘：**packet / vault / embed / rerank 全部 bind 喺呢份 slate。** 何晴可以 dispatch 去阿圖（分鏡專職），但信封寫住 `slate: SC-…`，阿圖冇權打開隔夜茶餐廳嗰份 vault。

故事、分鏡、剪接用 **同一組 SH id、同一條次序**。阿剪唔可以重排。

```
data/jobs/<SLATE>/
  job.json
  narrative-plan.json     # DAG + nodes
  continuity.json         # story = boards = cut
  vault.json              # text / image / video / audio vectors · 呢份 only
  stills/SH01.png
  motion/SH01.mp4
  delivery/picture-lock.mp4
```

Embed 而家係 local n-gram + file histogram（唔使 GPU）。之後換 CLIP / VLM HTTP 都要帶 `slate`，唔好做 global index。Rerank = cosine + lexical + **同一 SH 加分**。

```bash
npm run slatecrew -- floor
npm run slatecrew -- recall SC-xxxx "手入畫" --modality image
```

## 十二人（名 / 工 / 諗法）

| 人 | 工 | 諗法 |
|---|---|---|
| 何晴 | 製片 | dispatch 專職；信封只裝呢份 slate |
| 阿文 | 編劇 | 故事同對白寫死 |
| 阿圖 | 分鏡 | 專職。narrative plan。cut = boards |
| 阿釉 | 美術 | 唔另開世界 |
| 阿標 | 走位 | IK 只跟分鏡 mark |
| 阿靜 | 生圖 | U1.5；rerank 只問呢份 vault |
| 阿察 | 畫檢 | MARS-8B |
| 阿動 | 生片 | H3 first_frame = 同一 SH still |
| 阿聲 | 聲線 | 只讀 continuity 對白 |
| 阿耳 | 聲檢 | SenseVoice |
| 阿剪 | 剪接 | 照 cut[] |
| 阿鎖 | 交片 | 三閘先 picture lock |

## 跑

```bash
npm install
npm run slatecrew -- doctor
npm run slatecrew -- tui "雨夜茶餐廳重逢。對白：你仲記得個門口個燈？"
npm run slatecrew -- produce "…"
npm run dev                          # http://127.0.0.1:43127
```

## 換模型

```bash
npm run slatecrew -- models set stills.checkpoint SenseNova-U1.5-8B-MoT.safetensors
npm run slatecrew -- models set motion.checkpoint minimax_h3_fl2va_pruned_int8_convrot.safetensors
```

Comfy `File → Export (API)` 覆蓋 `workflows/*.api.json`，保留 `__PROMPT__` `__CKPT__` `__IMAGE__`。Comfy 熄咗用 studio fallback，QC 閘照行。

```bash
COMFY_URL=http://127.0.0.1:8188
SENSEVOICE_ENDPOINT=
MARS_ENDPOINT=
TTS_ENDPOINT=
BLENDER_BIN=blender
```
