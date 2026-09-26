# CARD_README_FOUR_LANE_0921 — README 四線段重寫（docs only）

Chau 0921 令（websearch＋碼對讀：「README 係舊皮，真 SSOT 係 docs/H3_FOUR_LANE_LOCK_0915.md＋碼；人讀 README 會當我哋 ViMax 薄殼」）。Wire 行；lane/readme（base 4e1651c）。

## 交付

- **c2499a5**：README 重寫——四線表 0921 現實＋0921 新法（C 形／跨 shot 接駁／條界）＋現況段＋定位一句；ViMax 敘事成段／vimax DAG／RAG 段／wav plug 簡述照「變更＝替換」剷走；十二人表兩格過時欄位同步。diff 淨 `README.md`（41+/40−），**零碼改動**。
- **（本 commit）Chau 釘修正**：「同場連續」唔准寫做「multishot 真尾幀」。正確：**同場連續＝`H3MultishotSampler` 原生鏈成梳延續**——上一梳輸出直接餵下一梳（frame-0 keyframe latent＋anchor_frames／memory_frames＋chain_gain），自己嗰梳 reference_images 同時照擺（混合制）；「真 endframe 做 start_image」只係兩段分開燒（HardMode 兩段式／KFE 手動鏈）嘅入口接駁媒介，唔係同場連續本身。README 兩處（0921 新法 bullet＋條界 bullet）照改。

## 對卡四項

1. 四線表：①blockout→`ref_video_0`/`<Video 1>` motion only ②U1.5 still→kf 0%/100%（A 形，限冇 Video1 嘅 shot）③呢鏡 wav→`ref_audio_0`（唔用 spine）④一鏡一 generate＋concat。
2. 現況段：native-cut 純 copy／T44 GREEN pin 閘／attempt 燈＋掃墓（標「即將 merge」）／MOTSEL decider／`--scene` hop＋resume。
3. 定位一句：分鏡原子＋3D 灰模運動＋雙閘 QC＋雙機 U1.5/H3（唔係 ViMax 薄殼）；「同 take 續 45–120s」係另一條題，明文禁止。
4. 過時內容全剷；目錄樹／floor 示例隨 ViMax 段刪（結構資訊在 `docs/FULL_ARCHITECTURE_MAP_0921.md`）。

源：`docs/H3_FOUR_LANE_LOCK_0915.md`＋`SlateLead/out/CHAU_FULL_FLOW_LAW_0917.md` §5b/5c＋`ARCHITECTURE_INTEGRATED_0921.md` §9。
