# CARD_BUG3 — 0920 P1 bug3：keyframe prompt 清 Chau 禁句＋cookbook 重寫＋第二眼 config 開關（Fable 01:1x 發現，SlateLead 派）

法源：`CHAU_PROMPT_QC_LAW_0917.md` 頭 14 條（法1/2/4/5 逐句刪；法6/9/11 同族）。在 `/mnt/ssd/crew-wt/crew`（lane/crew）做，base 3239ded。

## 1. 禁句清場（任務卡 item 1）

**crew-seats HEAD（1d9bb51）四句所在**（onto-seats 重放嘅剷除清單；本 lane 冇掂 seats checkout）：

| # | 原文 | crew-seats 位置 |
|---|---|---|
| ① | 「人偶位置、姿勢、比例、鏡位、地平線、背景結構、牆面、室內外完全照 Image-1」 | keyframe-prompt.ts:177 |
| ② | 「夜只由室內燈表達」 | keyframe-prompt.ts:105（sceneLine 室內分支） |
| ③ | 「距離、身高照 Image-1」 | keyframe-prompt.ts:179 |
| ④ | 「只借五官同髮際。唔好加第三人」 | keyframe-prompt.ts:174；同族「唔好加人」:100/:105/:107 |

**本 lane（lane/crew）剷咗**：舊 L63「人偶位置、姿勢、比例、鏡位、地平線完全照 Image-1」（①＋③族「比例」）；舊 L88「正面肖像，只借樣貌」（④族＋法6「正面」逼朝向）；舊 L91「唔好加人」（④族冇錨 negative）；later-form 冇 prop 時 carried 默认「犁」字面一併剷（道具詞彙唔准無 prop 滲入）。

**驗收 grep（四句原文逐句＋同族，非 test src）**：地平線 0｜背景結構 0｜室內外 0｜完全照 Image-1 0｜夜只由室內燈 0｜身高照 0｜只借五官 0｜只借樣貌 0｜髮際 0｜唔好加第三人 0｜唔好加人 0｜正面肖像 0。殘留 mention 淨係 (a) `keyframe-prompt.test.ts` BUG3_BANNED 清單（absence 執法數據，5 形 prompt×14 句零 hit 有 test 鎖）、(b) `seat-charters.ts` heightM 欄位註釋「係灰模比例唔係真人身高」（數據欄位語義，唔係 prompt 句，HEAD 原有）。

## 2. cookbook 重寫模板（任務卡 item 2）

`keyframeEditPrompt` 重寫為六段：**【底圖】**Image-1 作用＋變咩（質感/材質/光線）＋保持咩唔變（人偶位置/姿勢/佔位——法1準錨清單逐字）；**【人物】**Image-N 對號（左起第i個人偶＝Image-i+2 嘅角色）：ref＝着好衫本體（面容、髮型同成套衫著照 Image-N——法5/9 閹ref禁），朝向同動作跟 Image-1 人偶（法6 唔逼正面）；**【場景】**真相源一句；**【道具】**noun-class 三分支原句不變；**【光影材質】**接觸遮擔句；**保留段** first＝人數錨人偶（「淨係得呢N個角色」，法5 錨定句代冇錨 negative）／later＝Image-2 上一鏡定格連續性。

**150–300 中文閘**：`cjkCount`（CJK-only，Image-N/URL 唔計）＋`EDIT_MIN_CJK=150`＋`EDIT_MAX_CJK=300`；薄→`prompt_too_thin`（Fable 00:20 U1.5=A 六行電報拒出）、肥→`prompt_too_thick`（法11 prompt 只解釋底圖唔補償）。**facts block（上屏逐字，Card D）騎喺 band 之後**——packet 數據唔算 brief 字數（8-fact 螢幕 shot 唔會誤觸 300 頂）；PE render 附錄同理（pipeline 側後接）。

機印（`npx tsx` probe，2人+軍大衣，shot.location=地下室 sheet尾=茶餐廳門口）：first=248、later=201，同在 band；【場景】出「地下室」證明真相源贏 sheet 尾。

## 3. 場景真相源（任務卡 item 3）

新 `sceneLocation()`＝`shot.require?.location ?? shot.location`，空先落 `sheet.location` 尾——**Fable 1d9bb51 同一 idiom 逐字**（seats sceneLine :99 同式）；`types.ts` `ShotRequire.location` 入型（packet 欄位，非第二真相源）。`keyframeRequire` 唔郁（photo-qc 側 gate 欄位係 Kit/seats 線，1d9bb51「prompt and photo-qc gate on one field」喺重放時對齊）。

## 4. 第二眼 env 開關入 config（任務卡 item 4）

`config.ts` `pictureQc.secondEndpoint/secondModel`（DEFAULTS 空＝唔 armed＝GREEN 照降 PASS_UNCONFIRMED 語義不變）；env `SLATECREW_SECOND_ENDPOINT/MODEL` 照 MARS_URL 模式覆蓋 config（測試縫）；`slatecrew.config.json` 帶真值 `http://127.0.0.1:4000`＋`glm-5.3-flash`（:4000＝本檔 crew LiteLLM；glm-5.3-flash＝seats photo-qc.ts:613 自己嘅第二眼默認型號）。`doctor.ts` `secondQc` probe（armed 先 probe，unarmed 明文講「judge GREEN caps at PASS_UNCONFIRMED」）。

**Live**（`env -u HTTP_PROXY… npx tsx src/cli.ts doctor`，0920）：`second   UP http://127.0.0.1:4000  glm-5.3-flash present`。
**重放接點**：seats photo-qc.ts:611-613 讀鏈改為 `opts ?? env ?? cfg.pictureQc.secondEndpoint`（env 仍贏 config，現有 test 刪 env 路徑語義不變）。

## Proof

- `keyframe-prompt.test.ts` **18/18**（12 舊全綠＋6 個 BUG3 新 test：禁句零hit五形、法1變/保對、Image-N對號/着衫ref/朝向/人數錨、真相源三級、band三形 thin/fat/範圍、facts騎band後）。
- `u15-edit.test.ts` **11/11**（2 個 assert 由舊句（正面肖像／唯獨姿勢）改釘新法句：Image-2/3 對號、面容髮型衫著照 Image-2、朝向跟 Image-1、姿勢同企位跟 Image-1）。
- `doctor.test.ts` **7/7**（新：unarmed 講明天花板／armed UP+model present／armed DOWN 有 url+error）。
- 全套 `npm test`：**276 pass / 7 fail**；7 個 red（blockout render 4＋pipeline bun:test 1＋reflector 2）經 **stash 基線對照**（淨 stash 本人八檔重跑）**同名同數**＝HEAD 原有，零新 regression（baseline 269/7 → +7 全係我新 test）。pipeline bun: red 喺 HEAD L95 逐字存在（`import("bun:test")` tsx 行唔到）。
- `tsc --noEmit` **17 錯＝基線 17**（loadBaseCast/drama/episode/kept 等 HEAD 原有；本人檔零新錯——曾出現 1 個新錯（test fixture palette tuple）已修返 17）。

## 未做／重放注意

- ②句喺 seats `sceneLine`（:105）——本 lane 冇 sceneLine 引擎（阿圖 scene-retry 係 seats/t32b 線），**重放時要喺 seats 形狀入面剷**（連 :100/:107「唔好加人」）；殘句清理已列 §1 表。
- seats 模板原有 require.negatives（:101-102 禁止句組裝）同 angle 光角——packet 欄位，本 lane 未接（唔開第二真相源原則下，等 seats 線自己對齊）。
- `EDIT_MAX_CJK=300` 係法規上限：≥4 個着衫角色嘅場景會 prompt_too_thick 拒出（有 test 鎖）——法主（Fable/Chau）要放寬就搬上限，唔係我搬。
- 冇掂 crew-seats checkout／冇推 github／冇停服務；worktree 他人未提交改動（crew.ts EVIDENCE_LAW、seat-charters、.env.example）原封唔入本 commit。
