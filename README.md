# SlateCrew / 開麥拉組

**分鏡原子＋3D 灰模運動＋雙閘 QC＋雙機 U1.5/H3**——唔係任何流水線嘅薄殼。同一條交片流水線，三個皮：**TUI · CLI · Web GUI**；生圖行 **U1.5 `/edit` node0 `:8097`**、生片行 **H3 R2V node1 `:8188`**。

故事、分鏡、剪接用**同一組 SH id、同一條次序**（阿剪唔可以重排）；packet / vault / embed / rerank 全部 bind 喺呢份 slate——何晴可以 dispatch 去阿圖，但信封寫住 `slate: SC-…`，阿圖冇權打開隔夜嗰份 vault。

## 四線 ＝ 一次 H3 submit（0921 現實；SSOT：`docs/H3_FOUR_LANE_LOCK_0915.md` ＋ 碼）

**一鏡一 generate。** 唔係四次 ffmpeg。

| # | 線 | 入邊 | 槽 |
|---|---|---|---|
| 1 | layout | 呢鏡 grey blockout → `ref_video_0` / `<Video 1>`（motion only） | video 槽之一 |
| 2 | stills | 呢鏡 U1.5 still → keyframe **0%** 同 **100%**（A 形，用喺**冇** Video1 嘅 shot） | photo／kf，唔係 prev last |
| 3 | audio | 呢鏡 wav → `ref_audio_0`（一鏡一 take；**唔用 spine**） | audio 槽 |
| 4 | motion | **一次** H3 generate＝呢鏡；之後 `concat -c copy` | — |

### 0921 新法

- **C 形（動作 shot 帶 Video1 嘅正路）**：零 keyframes＋`ref_image_0` 身份 ref（45° 角度版）＋Video1 motion-only＋**turbo 8-step v1.0 @ steps 8、無 FBC／SolAttn**（8-step LoRA 行 FBC 爆 tensor，結構性）。**Video1 × H3Keyframes 並存＝必疊影**（五路實證：4/8/20 步、LoRA、FBC 全救唔到）——H3Keyframes lane 留畀冇 Video1 嘅 shot。
- **跨 shot 接駁（同場連續）＝`H3MultishotSampler` 原生鏈成梳延續**：上一梳輸出直接餵下一梳（frame-0 keyframe latent＋anchor_frames／memory_frames＋chain_gain），同時自己嗰梳 reference_images 照擺（混合制）；角度肖像每 shot 帶入、seed_per_shot 鎖面。**「真 endframe 做 start_image」只係兩段分開燒（HardMode 兩段式／KFE 手動鏈）嘅入口接駁媒介，唔係同場連續本身**。過渡形態全部 hard cut。

### 條界（唔係「續接弱」，係「換場唔食舊尾」）

- **換場（location hop）→ 禁食舊鏡尾幀**（身份被食就係呢度；0915 四線原則不變）
- **同場連續 → chain 得**（`H3MultishotSampler` 原生鏈成梳延續——上一梳 latent 直落下一梳，唔係靠食 endframe）

同一 take 續 45–120s 嗰套（靠上一窗 latent／尾幀）係另一條題，我哋明文禁止。

## 現況（0921）

- **剪接**：`native-cut` 純 copy concat，禁 xfade；`motion/SHxx.h3_plan.json` 每鏡收據，kf_start 撞舊場 fail-loud。
- **still 質閘（T44）**：任何 `/edit` ref（肖像／上一鏡定格／memory 命中）都要自己 photo_qc GREEN，唔 GREEN 即 `ref_rejected` 事件＋肖像補位；resume 只 skip GREEN。
- **入面可見（INSIDE_VISIBLE，即將 merge）**：seat 每次 attempt 失敗即發 warn event（A4 events.jsonl）；produce preflight／`status` 開場掃墓——未收屍 failed job 同靜咗 >30min 嘅 running 必現形。
- **motion 選座（MOTSEL）**：CMU 座席步（index parse＋combat sweep ranking＋六族 caps shortlist）＋一 call decider（conf≥0.7 自動收，分唔出 needs_human），selection.json 帶 bvh 相對路徑。
- **`--scene` hop＋`--resume`**：hop 只跑嗰幕嘅 stills／QC／motion；resume 靠 GREEN pin 續鏈。

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
TTS_ENDPOINT=
BLENDER_BIN=blender
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
| 阿察 | 畫檢 | Nex 五路盲描述＋qwen38 判官（公版 QC） |
| 阿動 | 生片 | C 形（Video1）／A 形 keyframes（0%/100%＝呢鏡 still） |
| 阿聲 | 聲線 | 只讀 continuity 對白 |
| 阿耳 | 聲檢 | SenseVoice |
| 阿剪 | 剪接 | 照 cut[]，純 copy |
| 阿鎖 | 交片 | 三閘先 picture lock |
