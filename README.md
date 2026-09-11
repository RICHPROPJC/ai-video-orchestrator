# SlateCrew / 開麥拉組

同一條交片流水線，三個皮：**TUI · CLI · Web GUI**。生圖生片**默許你已經喺跑嘅 ComfyUI**（`http://127.0.0.1:8188`），唔使再砌新 endpoint。

搜完之後係組合現成最好嘅件，唔係重寫一個擴散模型：

| 件 | 來源 | 呢度點用 |
|---|---|---|
| 生圖 / 生片 | 你本機 Comfy + 官方 U1.5 / MiniMax H3 template | `POST /prompt` → `/history` → `/view` |
| 多 agent 檯 | OpenDirector 式導演流水線 | 十一張檯 |
| CLI = UI | Montaj CLIP | 每個 GUI 動作都有 CLI |
| 分段閘口 | MoneyPrinterTurbo 式 checkpoint | SenseVoice + MARS-8B 先 lock |
| 走位手腳 | Blender IK | `blocking.py` |

Comfy 熄咗仍然可以 studio fallback 交一支片（QC 閘照行）。開返 Comfy 就自動切真 U1.5 / H3。

## 跑

```bash
npm install
npm run slatecrew -- doctor          # 探 Comfy :8188 / ffmpeg / 模型
npm run slatecrew -- tui "雨夜茶餐廳重逢。對白：你仲記得個門口個燈？"
npm run slatecrew -- produce "…"     # 行 log
npm run dev                          # Web http://127.0.0.1:43127
```

## 換模型

改 `slatecrew.config.json`，或：

```bash
npm run slatecrew -- models
npm run slatecrew -- models set stills.checkpoint SenseNova-U1.5-8B-MoT.safetensors
npm run slatecrew -- models set motion.checkpoint minimax_h3_fl2va_pruned_int8_convrot.safetensors
```

Web 左側 Rack 都可以改。Workflow 用 Comfy `File → Export (API)` 覆蓋 `workflows/*.api.json`，保留 `__PROMPT__` `__CKPT__` `__IMAGE__` token。說明喺 `workflows/README.md`。

可選 QC / TTS HTTP 仍然得，唔填就用 schema / studio synth：

```bash
# .env.local — Comfy 已係預設，下面可空
COMFY_URL=http://127.0.0.1:8188
SENSEVOICE_ENDPOINT=
MARS_ENDPOINT=
TTS_ENDPOINT=
BLENDER_BIN=blender
```
