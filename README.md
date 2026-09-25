# SlateCrew / 開麥拉組

**分鏡原子＋3D 灰模運動＋雙閘 QC＋雙機 U1.5/H3**——唔係任何流水線嘅薄殼。同一條交片流水線，三個皮：**TUI · CLI · Web GUI**；生圖行 **U1.5 `/edit` node0 `:8097`**、生片行 **H3 R2V node1 `:8188`**。

故事、分鏡、剪接用**同一組 SH id、同一條次序**（阿剪唔可以重排）；packet / vault / embed / rerank 全部 bind 喺呢份 slate——何晴可以 dispatch 去阿圖，但信封寫住 `slate: SC-…`，阿圖冇權打開隔夜嗰份 vault。

## 分鏡交付

以 [ALIGN-LOCK.md](ALIGN-LOCK.md) 為準，維持十二席。`runBoards` 先拆文字鏡頭表，再經 U1.5 出可見分鏡板、切格及逐格 QC。收據留喺分鏡席，記錄鏡號、鏡內位置、板／格檔案、hash 同 QC；文字 callsheet 唔算分鏡完成。壞格抽出再拼板補格，只替換指定格。十一鏡唔等於十六格，空格唔會開新鏡。dry-run 只係草稿。

`buildings` 空就唔畫大廈。廚房、露台、木檯係場所或道具，唔會由場所名自動造建築板。明確宣告嘅建築板只供 look-dev，唔入鍵格參考鏈；共享鍵格板用未切角色身份板。

## H3 輸入同幀數

| 輸入 | 用途與接法 |
|---|---|
| 鍵格百分比 | `H3Keyframes.positions` 對應呢鏡 `17k+5` 總長度。首六釘依序入 `image_1`–`image_6`，第七張起順序入 `images_batch`，六張唔係上限。H3 補兩個釘之間嘅幀。 |
| 身份參考 | 樣貌／身份，冇百分比。C 形有灰色 Video 1、零鍵格；角度肖像入 `ref_images.ref_image_0`，Video 1 只供動作。故事鏡唔塞場景相入身份槽。 |
| 多鏡生成 | 只收未切身份板；拒收走位片、鍵格名及 start image。舊 chained Video 1 路徑已拒收；C 形鏡同後續多鏡段分開生成。 |
| 聲軌 | 該鏡 wav；無對白鏡嘅靜音跟鏡長，再按 H3 時鐘補齊。 |

冇百分比而同時交鍵格同 Video 1 會被拒。**有百分比＋Video 1** 嘅型別允許同 §5b 疊影警告仍未裁決；唔當其中一句已勝出。

提交、分段預算、concat gate 都向上對齊 `17k+5`。八鏡各請求 68 幀會預算成每鏡 73、共 584；實檔 577 唔會用嚟改 gate，manifest 亦唔可以覆蓋計算預算。剪接跟同一 cut 次序、純 copy concat；frame gate 同 QC 未過唔宣稱 picture lock。

## 聲音同網頁

AuK `:9882/tts` 只按參考聲讀原句；唔塞情緒符號。情緒、快慢、音高同非語言任務屬 `/run`，目前未接。SenseVoice `:9881` 對**實際已交鏡頭對白**做聲檢，唔對未讀出嘅完整旁白稿；收據記錄比較範圍。

- **畫布**：一集一塊；分鏡格、角色轉面、場景、道具、鍵格同層。實線只連鍵格剪接次序；虛線另示角色參考。場所節點唔假裝有建築圖，未交圖會保留標示。
- **分鏡**：顯示 runBoards 已交嘅板（有板路徑時）同切格，標明 SH id／鏡內位置；未有交付就顯示未完成。鍵格另列，唔當文字表已完成分鏡。
- **圖片**：縮圖用小型 WebP 預覽；撳開先讀原圖。
- **成片**：播放成片及逐鏡音頻，顯示對白／靜音；聲音唔係畫布節點。

`--scene` 配 `--resume` 只續跑指定場景嘅 stills／QC／motion；是否重用產物由相應時鐘及 QC pin 決定，唔靠檔案存在就宣稱已過關。

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

`workflows/*.api.json` 係圖形工作流參考；生產 H3 graph 由代碼建構。供應端唔通或 QC 缺證據，唔視為成功。

```bash
H3_COMFY_URL=http://127.0.0.1:8188
U15_URL=http://127.0.0.1:8097
AUK_TTS_URL=http://127.0.0.1:9882
```

SenseVoice 同 Blender 等設定讀 `slatecrew.config.json` 嘅 `soundQc.endpoint`／`mesher.blender`；環境變數只用代碼支援嘅名稱。

## 十二人（名 / 工 / 諗法）

| 人 | 工 | 諗法 |
|---|---|---|
| 何晴 | 製片 | dispatch 專職；信封只裝呢份 slate |
| 阿文 | 編劇 | 故事同對白寫死 |
| 阿圖 | 分鏡 | runBoards 交可見板、切格、鏡內位置、QC／補格收據。文字表只係草稿。 |
| 阿釉 | 美術 | 唔另開世界 |
| 阿標 | 走位 | IK 只跟分鏡 mark |
| 阿靜 | 生圖 | U1.5；rerank 只問呢份 vault |
| 阿察 | 畫檢 | Nex 五路盲描述＋qwen38 判官（公版 QC） |
| 阿動 | 生片 | C 形身份／動作，百分比鍵格，或純身份板多鏡 |
| 阿聲 | 聲線 | 只讀 continuity 對白 |
| 阿耳 | 聲檢 | SenseVoice |
| 阿剪 | 剪接 | 照 cut[]，純 copy |
| 阿鎖 | 交片 | 三閘先 picture lock |

## 公共庫同劇目庫

文字同立體件用同一條名詞測試。專名來自 `projects/<劇目>/entities.json`。

| 層 | 路徑 | 入面係咩 |
|---|---|---|
| 公共文字 | `seats/<scope>.primitive.md` | 冇專名嘅教訓。每份新 slate 阿文、阿圖都會食。冇指名劇目就唔撈劇目 playbook |
| 劇目文字 | `projects/<劇目>/playbook/<scope>.md` | 句入面有專名。唔會自動升去公共 |
| 公共件 | `library/<characters\|props\|scenes>/<公共名>/` | 去背板同／或 `mesh_front_rigged.glb`。目錄名唔可以含劇目專名 |
| 劇目件 | `projects/<劇目>/library/<角色\|道具\|場景>/<故事名>/` | 個名撞到專名，只可以留喺呢度 |
| 本份 | `data/jobs/<slate>/` | 呢份嘅板、rig、vault、WeMM。隔籬 slate 睇唔到 |

本份已經有板，用本份。本份冇，先去庫攞。庫有 rig 就唔再 mesh。庫唔會自動抄一份 job 入去。

故事名留喺 callsheet。要複用公共件，喺角色、道具或 `buildings[]` 寫 `publicName`，指住公共目錄個名。`publicName` 如果仲含有專名，當冇呢次攞件。

## 一個世界

出圖同 rig 之前先查尺寸同動作。尺寸缺就停。動作用詞組，`抹走` 唔當行路；`坐低` 同 `gait turn` 或 `stance stand` 矛盾就停。模型只睇該鏡合格片段，揀定先出圖。Rig 齊之後先組裝一次，寫 `world/assemble.json` 同 `world/story.blend`。每鏡只讀呢個世界，鏡頭望已擺好嘅件（`lookAtId`）。分鏡 `pos`／`lookAt` 唔塞入世界。

角色身份板只切頂條四格全身入模。切半張會把下面嘅剪影帶切入正面格，畫檢當灰模，rig 就唔開。正面格冇釘到會換 seed 再畫一次，唔當個角色唔存在。

尺寸只得三條，缺就停，唔估：

- 角色：`heightM`
- 道具／場景：`sizeM` 加 `sizeSource`
- 或者一句已確認比例：`proportion.of` 指住有 `heightM` 嘅角色，`at` 係 `knee` 0.25、`waist` 0.55、`chest` 0.72、`shoulder` 0.82
