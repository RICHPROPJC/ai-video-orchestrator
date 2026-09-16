# CLOUD HANDOFF — 3D 策略轉向（2026-09-15）

給雲端改 `crew-seats` 底層用。來源：今日 c-desktop 實證 + 舊檔（Trellis／ViMax map／FABLE APP CONTRACT）。  
Repo：`RICHPROPJC/ai-video-orchestrator` · branch **`crew-seats`**（已 public）。  
本機實驗收據：`/mnt/ssd/tripo_assets/photo_film_test/`（唔入 git）。

---

## 0. 一句話

**舊路：** Blender 灰模／Astra skill → 直接當「空間真相」→ U1.5 跟住升 look → H3。  
**新路：** 灰模只係 layout 鎖；**資產外殼**靠「真相片／U1.5 角色板 → Tripo（或 Trellis）→ import Blender 成場」；U1.5 `/edit` 跟 **空間＋明示 prompt**；可 **多刀 edit**；可 **U1.5↔Tripo 互餵**。

底層差就出垃圾——但「差」而家包括：**錯入料、錯軸、bust 當全身、單刀期望物理常識、亂改 U1.5 參數／解像度**。

---

## 1. 舊檔對照（你叫「Travel + 呢份舊檔」）

| 舊源 | 係咩 | 而家點睇 |
|---|---|---|
| **Trellis**（常誤聽成 Travel）`/mnt/ssd/trellis_work`、`trellis_assets/` | 單圖→3D（V100 GPU3）、多視角 beauty／normal／depth | **仍然有效**嘅 image-to-3D 路徑；同 TripoSR **並列**，唔互廢。角色／高質殼可優先 Trellis；快速殼／GPU2 4G 預留用 Tripo。 |
| **ViMax PIPELINE_MAP** `hookaudit/PIPELINE_MAP_vimax_0911.md` | 生圖→生片斷點、ad-hoc driver、U1.5／H3 拓撲 | 產品已轉 **SlateCrew**；斷點教訓仍要：閘要 fail-loud、唔繞 pipeline。 |
| **FABLE_LAW_APP_CONTRACT** `hookaudit/FABLE_LAW_APP_CONTRACT_0914.md` | A1–A7：fleet／memory／events／Astra typed tools；灰模 blockout→U1.5→H3 | **App contract 仍立**。要補：**資產供應鏈**（ref 板→Tripo/Trellis→scene）寫入 A7／identity 層，唔好當「場外手做」。 |
| **README／Astra skills** | blockout + skill catalog；model 唔寫 bpy | 仍立。**新增：** `object.import_mesh`（或同等）要成為正式 tool；import 後 **強制 Z-up 對齊**。 |

---

## 2. 今日實證：做啱 vs 做錯

### 2.1 入料合約（最重要）

| ❌ 錯 | ✅ 啱 |
|---|---|
| Blockout／方塊人 render → Tripo「升級 look」 | Tripo／Trellis 要 **成件入畫** 嘅相／概念圖（三四分、灰底／rembg） |
| 正面近拍車頭 → 怪「估唔到 size」 | 單圖可以；但要 **見到成部車／全身** |
| Bust 肖像 → Tripo → 當站立角色 | 全身站立板；否則 U1.5 跟空間會「出土半身」 |
| 以為「物理優化」= 模型自己發明枱 | U1.5 **跟表達**：講咗「桌子／台面」先有枱；冇講就落地 |

### 2.2 正確合體順序

```
A) 資產殼（可循環）
   U1.5 /generate 全身（portrait lane: 1024² · 50 · think）
   → /edit 多角度 正/三四/側/背（仍s lane: 2048×1152 · steps8 · img_cfg1 · cfg1 · use_edit_pe）
   → 揀最佳全身三四分 → TripoSR（或 Trellis）→ GLB/OBJ

B) 場景鎖
   import mesh 入 Blender（Astra tools）+ 灰模／道具／燈／機
   → 缺真實世界承托就 **喺灰模補**（枱、地、全身）
   → render 成場 ref（Workbench OK；EEVEE headless 呢部機會全黑）

C) 生圖
   scp → node0 refs → U1.5 /edit
   Image-1 = 成場灰模／beauty；Image-2+ = 有 ref 嘅肖像／道具（可混「有 ref／冇 ref」）
   → 可連續 2–3 刀（layout → 物理／家具 → 左右微調）

D) 生片
   H3 照舊：still + blockout/matte + wav（唔改呢份 handoff 核心）
```

### 2.3 U1.5 硬規（WIST 44/44 成功單一致）

- **解像度：`2048×1152`（2K）** — `slatecrew.config.json` stills。禁止降 1024「避開偶發 500」當結論。
- **參數：`num_steps=8` · `cfg_scale=1.0` · `img_cfg_scale=1.0` · `use_edit_pe=true`**  
  → 只用 `buildEditPayload`／正式 lane，**唔好亂塞、亦唔好「唔填」**。
- Prompt：Image-N 要點名（img_cfg 1.0 靠 token）；灰模人偶要寫「角色佔位，唔係石頭」。
- Portrait `/generate`：1024² · 50 · `think_mode`（同肖像 lane）；角度轉板用 `/edit` 2K。

### 2.4 Tripo／軸向

- GPU2：`run_gpu2_capped.py` 模式（`CUDA_VISIBLE_DEVICES=2`，≥4GiB reserve）。AuK／WeMM／OCR 唔好搶。
- Blender 3.0 系統 glTF 可能缺 numpy → OBJ 路徑；**OBJ import 會將身長軸掟去 Y** → preview「瞓低」= **軸向 bug，唔係姿勢**。Import 後必須 rotate 對齊 **Z-up 企立**。
- Trellis：舊 path 要 `CUDA_VISIBLE_DEVICES=3`；多視角 contact sheet 仍係優勢場景。

### 2.5 實驗收據（本機，供對照）

| 路徑 | 含義 |
|---|---|
| `…/photo_film_test/forge_pair/` | ❌ blockout→Tripo 軟殼 |
| `…/photo_film_test/tripo_v2/` | ✅ 成車三四分單圖→比例好啲 |
| `…/photo_film_test/u15_scene/` | ✅ 成場→U1.5 2K；物理句＋「枱」→有枱 |
| `…/photo_film_test/char_loop/` | ✅ U1.5 全身多角度→Tripo 全身殼 |

---

## 3. 雲端要改嘅底層（checklist）

優先順序跟 APP CONTRACT：底層先於出片。

1. **Asset pipeline 模組（新）**  
   - `stills` 旁加 `mesh`／`asset` provider：TripoSR endpoint／本地 runner + 可選 Trellis。  
   - 輸入閘：成件入畫、唔接受「純 blockout render 當 image-to-3D 入料」（可 warn+refuse）。  
   - 輸出：`projects/<ep>/assets/<id>/{plates,mesh.glb,preview.png,meta.json}`。

2. **Astra / Blender**  
   - 正式 `object.import_mesh`（或 invent 同等 typed tool）。  
   - Import 後 **normalize + Z-up**（修 OBJ Y-up 瞓低）。  
   - Blockout observe：缺「承托面」／bust 高度異常 → check ✗（唔等 U1.5 先爆）。

3. **U1.5 lane**  
   - 鎖死 2K + `buildEditPayload` 常數；smoke test 拒絕非 2048×1152。  
   - 支援 **multi-pass edit**（events 記 pass1/2/3 + 每刀 prompt）。  
   - Prompt 模板：空間跟 Image-1 + **可選**「物理／家具」明示句（唔暗示模型會自己發明）。  
   - 混 ref：有肖像／無道具板 寫清楚。

4. **Identity 閉環**  
   - Character lock： bust 板 **唔准入** standing spawn；要全身板或多角度板。  
   - 允許 **U1.5 → Tripo → Blender → U1.5** 迴圈寫入 A2 memory（板＋mesh preview 都 ingest）。

5. **Fleet**  
   - 標清：Tripo GPU2（4G cap）、Trellis GPU3、U1.5 node0、H3 node1。  
   - Doctor／fleet panel 顯示 mesh runner alive（而家只有 LLM／U1.5／H3）。

6. **文件**  
   - README 補「3D 資產供應鏈」一節；廢除「Tripo 升級灰模 look」任何暗示。  
   - 對齊 `FABLE_LAW_APP_CONTRACT` identity 行：refs 可來自 generate／Tripo／Trellis。

---

## 4. 明確唔好再做

- 用偶發 HTTP 500 發明「U1.5 唔得 2K／要降解像度」。  
- 手填亂嚟嘅 steps／img_cfg「試吓」。  
- Blockout render → Tripo → 當完成 look。  
- Bust mesh 當站立英雄唔改上游。  
- 當 U1.5「自己識擺枱」卻 prompt 冇寫枱。  
- EEVEE headless 全黑就當 mesh 失敗（先 Workbench）。  
- 停服務／搶 pictureQc 27B 線去升 boards。

---

## 5. 成功標準（雲端改完）

- [ ] `produce`／CLI 能：全身板 → mesh → import → 成場 ref → **2K** `/edit` → 收據入 `events.jsonl`  
- [ ] Import 角色 **企立**（Z-up），唔使人手轉  
- [ ] Bust／半身板被閘住  
- [ ] Multi-pass edit 有事件  
- [ ] 文件同 smoke 寫死 2K + lane 參數  
- [ ] Trellis／Tripo 喺 fleet 可見、可選

---

## 6. 聯絡本機證據

- Branch tip（handoff 當日）：`crew-seats` @ fleet／scene-hop／scp／memory commit。  
- 實驗：`/mnt/ssd/tripo_assets/photo_film_test/{u15_scene,char_loop,tripo_v2}/`  
- 舊 Trellis：`/mnt/ssd/trellis_work/run_trellis.py`  
- 舊合約：`hookaudit/FABLE_LAW_APP_CONTRACT_0914.md` · `PIPELINE_MAP_vimax_0911.md`

Chau 意圖：雲端用呢份執底層；執完擺返嚟再同本地融合。唔好當「又一次出片任務」。
