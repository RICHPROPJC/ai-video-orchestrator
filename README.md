# SlateCrew / 開麥拉組

交付級開源影片 **agent team**：同一條流水線有 **CLI** 同 **Web GUI**。預設對齊你而家跑緊嘅模型，未接 GPU / API 都可以用 studio fallback 交一支有聲有畫有 QC 報告嘅短片。

## 搵齊之後揀呢套

| 你要嘅能力 | 開源落點 | 呢個 app 點用 |
|---|---|---|
| 生圖 U1.5 | [SenseNova U1.5-8B-MoT](https://huggingface.co/sensenova/SenseNova-U1.5-8B-MoT) · [OpenSenseNova/SenseNova-U1](https://github.com/OpenSenseNova/SenseNova-U1) | Stills agent · `U15_ENDPOINT` |
| 生片 H3 | [MiniMax H3](https://huggingface.co/MiniMaxAI/MiniMax-H3) · ComfyUI FL2VA / Ref2VA | Motion agent · `H3_ENDPOINT` · U1.5 still 做 first-frame / semantic bridge |
| 畫檢 MARS 8B | [SenseNova-MARS-8B](https://huggingface.co/sensenova/SenseNova-MARS-8B) | Picture QC：身份、構圖、手、腳、artifact |
| 聲檢 SenseVoice | [FunAudioLLM/SenseVoice](https://github.com/FunAudioLLM/SenseVoice) | Sound QC：ASR、情緒、事件、WER、clipping |
| TTS + clone | [Fun-CosyVoice 3](https://github.com/FunAudioLLM/CosyVoice) / F5-TTS | Voice agent · `TTS_ENDPOINT` 或上載 WAV 跟 F0 |
| 場地 / 角色移動 / 手手腳腳 | Blender 4 + IK empties（腳落地、手入畫） | Layout agent 出 `blocking.py` + 俯視 mark |

其他開源片場（參考，但對唔齊你條 stack）：

- [OpenDirector](https://github.com/seme-org/open-director) — 9 agent 導演，缺 QC 閘同 Blender IK
- [MoneyPrinterTurbo](https://github.com/harry0703/MoneyPrinterTurbo) — 短視頻控制面，預設 stock footage
- [Montaj](https://github.com/jazzerkay/montaj) — CLI + GUI 剪片 CLIP，唔係生片交片
- [UniVA](https://github.com/univa-agent/univa/) — 通用 video agent，唔綁 U1.5 / H3 / MARS / SenseVoice

## 十一張檯

製片 → 編劇 → 美術 → **走位（Blender IK）** → **U1.5 生圖** → **MARS-8B 畫檢** → **H3 生片** → **TTS clone** → **SenseVoice 聲檢** → 剪接 → **Picture lock 交片**

QC 唔過會 retry；全過先 stamp `PICTURE LOCK`。交片包包括 MP4、QC JSON、call sheet、Blender script。

## 本機跑

需要 Node 22+ 同 `ffmpeg`。

```bash
npm install
npm run dev          # Web GUI http://127.0.0.1:43127
npm run slatecrew -- produce "雨夜茶餐廳，阿月同阿衡重逢。對白：你仲記得個門口個燈？"
npm run slatecrew -- floor
npm run slatecrew -- status
```

Studio 模式唔使 API key：會用 cinematic painter + 手腳 IK 動畫 + clone synth 出片。接上真實模型之後，agent 同 QC schema 唔使改。

```bash
# .env.local
U15_ENDPOINT=http://127.0.0.1:8101/v1/images
H3_ENDPOINT=http://127.0.0.1:8102/v1/video
MARS_ENDPOINT=http://127.0.0.1:8103/v1/qc
SENSEVOICE_ENDPOINT=http://127.0.0.1:8104/v1/asr
TTS_ENDPOINT=http://127.0.0.1:8105/v1/tts
STUDIO_API_KEY=
BLENDER_BIN=blender
```

HTTP 契約好薄：JSON in、圖/片/音 bytes 或 `{image_base64,url}` / `{text,emotion,event,language}` / `{text,score}` 出。你而家嘅 ComfyUI / FunASR / vLLM 前面加一層 wrapper 就得。

本機有 Blender 會 headless 跑 `blocking.py`；冇就照交 Python 腳本。腳本會起地面、camera、humanoid armature、手/腳 IK empty、按 gait（plant / walk / reach / turn）keyframe。

## 特殊功能

- **Picture-lock 閘**：聲檢 + 畫檢（stills + video）全過先 lock
- **U1.5 → H3 semantic bridge**：still 做 first frame，motion prompt 帶同一 style bible
- **手手腳腳**：2D IK preview + Blender IK；MARS QC 專門打分 hands / feet
- **Sound clone**：有 reference WAV 就估 F0 再合成；有 CosyVoice endpoint 就走真 clone
- **CLI 同 GUI 共一條 pipeline**，job 寫喺 `data/jobs/<slate>/`
