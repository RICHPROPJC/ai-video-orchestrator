# CLOUD PROGRESS SNAPSHOT — 2026-09-15 ~16:35 HKT

**誠實結論：內部未「全部調整好」。**  
Config／艦隊大部份對得上；**3D 新方針只喺 docs + 本機實驗**，未入 pipeline／Astra／fleet。出片卡喺 LD0F photo-qc。

給雲端：同 `docs/CLOUD_3D_STRATEGY_HANDOFF_0915.md` 一齊讀。呢張係**進度**，嗰張係**方針**。

---

## 1. Repo / branch

| 項 | 現實 |
|---|---|
| Primary | `/mnt/ssd/ai-video-orchestrator-crew` |
| Branch | `crew-seats` @ **`adb984f`**（追 `github` + `origin`） |
| Public | https://github.com/RICHPROPJC/ai-video-orchestrator/tree/crew-seats |
| Dirty | 根目錄 `nex-*.ts` smoke 未 commit；`projects/SC-0915-LD0F/` 本地 events／memory 未入 git（sqlite ignore） |
| TEAM_BOARD tip | 仍寫 `4c2f0a2` — **過期**，唔好信板頭 commit |

近期已上雲：fleet／scene-hop／scp／memory（`29f9502`）+ 3D handoff doc（`adb984f`）。

---

## 2. `slatecrew.config.json` 腦位（已寫死）

| 席／層 | Config | LiteLLM／活服務對唔對 |
|---|---|---|
| writer／boards | `glm-5.3-flash` @ `:4000` | ✅ litellm 有 id |
| blender | `nex-n2.5` · fallback `glm-5.3-flash` | ✅ |
| reflector | `qwen38` | ✅ |
| pictureQc | `qwen38` @ `:8015` | ✅ UP |
| nex | `nex-n2.5` @ `:8017` | ✅ UP（optional；DOWN 唔擋 READY） |
| stills U1.5 | `http://100.76.131.19:8097` · **2048×1152** · SenseNova-U1.5-8B-MoT | ✅ node0 UP；localhost ❌（正常） |
| motion H3 | `http://100.127.176.64:8188` · steps 4 · turbo pin | ✅ node1 UP；localhost ❌ |
| tts | AuK `:9882` `auk-flash-1.5B` | ✅ |
| embed | WeMM `:8016` `wemm-2b` | ✅ |
| soundQc | SenseVoice `:9881` | ⚠ `/` 404（舊行為）；**未用今次探針確認 `/v1/...` 活** |
| SSH | `hojaiv3v` · stillsRefs `/home/hojaiv3v/SenseNova-U1/refs` · 直接 sshpass | ✅ 今日 U1.5 scp 通 |

**鎖（板）：** boards **留 flash**，唔升 27B 搶 `:8015`。

---

## 3. GPU 現實（c-desktop 探針）

| GPU | 約用 | 角色（現行） |
|---|---|---|
| 0–1 | ~24.8 / 32 GB | Nex TP2 `:8017` |
| 2 | ~23.7 / 32 GB | 有負載；Tripo 測過 4G reserve（**未入 fleet 面板**） |
| 3 | ~28.2 / 32 GB | qwen38／pictureQc 線 |

U1.5／H3 唔喺呢四卡（GB10 node0／node1）。

---

## 4. 劇集進度 SC-0915-LD0F《重生執政官》

| 項 | 狀態 |
|---|---|
| Drama | `guojia-lingdaoren` · EP01…10 goal |
| Boards | 7 場／47 鏡／~307.6s |
| wav-plug | 有（聲軌鐘） |
| SC01 blockout | SH01–SH05 `blockout/*.mp4` + `f0.png` 有 |
| Portraits | A／E GREEN（有 png + photo_qc）；B 等未齊 |
| Stills | SH01–SH05.png + u15_edit 收據有 |
| **Job** | **`status: blocked` · progress 45** |
| **擋** | pictureQc：**SH01 連續兩次 FAIL** — `location: write-up misses tokens from "總統府地下審判室"` |
| H3 | **未燒**（板 HOLD；foundation／QC 未清） |

→ 雲端執底層時：**唔好當「可以亂 produce 出片」**；出片仍卡阿察。

---

## 5. 已入 app vs 未入 app

### 已喺 `crew-seats` 碼（大致）
- Fleet panel／`fleet.ts`（crew、stills、pictureQc、nex、motion、tts…）
- Memory sqlite + embed 鉤
- Scene-hop／`qcSheet` geometry、scp 直連（secrets.env）
- U1.5 正式 `buildEditPayload`：**8 / cfg1 / img_cfg1 / 2K**
- Nex = blender 腦；OCR／深讀 = qwen38 分工（碼＋板）

### **未**入 pipeline（只有實驗／doc）
- TripoSR／Trellis **provider**
- `object.import_mesh` + **Z-up 強制對齊**
- U1.5↔Tripo 角色閉環、multi-pass edit 事件模型
- Bust／半身板閘
- 3D handoff checklist 其餘項

→ 「3D 策略轉咗」＝**人知＋doc**；**產品路徑仍係舊：灰模 blockout → U1.5 →（卡 QC）→ H3**。

---

## 6. 雲端改嘢時請當「真」嘅約束

1. 唔改 U1.5 解像度離開 **2048×1152**；唔發明降解像度結論。  
2. 唔改 boards→27B 搶 `:8015`。  
3. 唔擅自停 GPU 服務。  
4. 3D：跟 `CLOUD_3D_STRATEGY_HANDOFF_0915.md`，先 asset／import／閘，唔先出片。  
5. LD0F：photo-qc SH01 係現障；改 QC／prompt 路徑要同 Kit／阿察契約對齊，唔好跳閘假綠。  
6. `TEAM_BOARD.md` tip／HOLD 可能滯後——以 **job.json + 呢張 snapshot + live probe** 為準。

---

## 7. 一句畀 Chau／雲端

**模型選擇同遠端 endpoint 大部份已對上活服務；出片同 3D 資產鏈未收口。**  
進度 = config／fleet 綠＋LD0F 卡 pictureQc＋3D 方針已寫未碼化。唔好報「內部全部調好」。
