# MERGE_THREE_0921 — Wire 三批 merge 入 crew-seats（Chau 0921 令：1人 last test confirm in slatecrew 開路）

日期：2026-09-21。執行：Wire。Vera 三份判詞（0920）全 MERGE_OK 為前置。

## 0. 前置發現（卡面冇講，開工前實證）

- lane/crew 嘅 c123（角度ref全套）同 lane/qc 嘅 pose-strip **當時仲未 commit**——Vera 驗嘅係 worktree 未 commit diff（mtime 全部早過判詞，樹態即所驗）。照卡「merge所需git commit照做」先喺各 lane 釘 sha：
  - **lane/crew `ed628fa`**＝c123 10 檔 249+/26−（剔卡外 .env.example；commit 前 keyframe/portraits/writer 39/39 綠）
  - **lane/qc `68db63d`**＝Kit pose-strip 8 檔 494+/10−（剔卡外 .env.example＋crew.ts；commit 前 photo-qc/boards-expand/keyframe-prompt 91/91 綠）
  - lane/motion `241d101` 本身已 commit，零改動。
- crew-seats 兩浸 dirty：(a) Fable 產物（.env.example/.gitignore/nex-*/blender-bin*/still-h3-proxy*/playbook 目錄）——**全程原封未入 git**（一次 `git add` glob 誤掃 4 件入 S1 commit，已即場 amend 剔走；S3 初版誤掃 verify/qc/MERGE_P1_0919.md，同樣 amend 剔走）；(b) 0920 朝手版 boards strip 草稿——backup 後 restore 返 HEAD，等 lane/qc 正版入場（變更＝替換）。backup：`/home/c/orca/workspaces/sov-cli-merge-wip/Wire/out/crew-seats-dirty-backup-0921.patch`（129 行）。
- crew-seats git 史零 merge commit（慣例＝onto-seats 手 port 線性史）。本卡行**真 git merge --no-ff**（衝突語義解、兩邊功能齊），message 照 onto-seats 款式。

## 1. 每步前後 sha

| 步 | 前 | merge 對象 | 後 | parents |
|---|---|---|---|---|
| 基線 | — | 4908bc8（HEAD） | — | 全套 387/380 pass/**7 紅**；noun-lint 12 hits；tsc 追蹤檔 3 錯 |
| S1 | 4908bc8 | lane/crew **ed628fa** | **0554bd2** | 4908bc8＋ed628fa |
| S2 | 0554bd2 | lane/motion **241d101** | **62336f2** | 0554bd2＋241d101 |
| S3 | 62336f2 | lane/qc **68db63d** | **001a6c6**（amend 後） | 62336f2＋68db63d |
| S3收尾 | 001a6c6 | —（curation＋noun 紀律） | **be2fea8** | 單親 |

## 2. 測試實數（tsx --test --test-force-exit src/lib/studio/*.test.ts，proxy unset）

| 樹 | tests | pass | fail | skipped | 紅名對拍 |
|---|---|---|---|---|---|
| 4908bc8 基線 | 387 | 380 | 7 | 0 | — |
| S1 0554bd2 | 441 | 434 | 7 | 0 | 7 紅與基線**逐名相同**（僅 index 位移），+54 全綠 |
| S2 62336f2 | 464 | 457 | 7 | 0 | 同名零新增，+23 全綠 |
| S3 001a6c6 | 480 | 473 | 7 | 0 | 同名零新增，+16 全綠 |
| S3收尾 be2fea8 | 480 | 473 | 7 | 0 | 同名零新增 |

7 個基線紅（全程同名不變）：repo lint（noun-lint）、resume+all-stills-GREEN、27B full loop fake fetch、no-seat grave、Chau-home paths、writeH3KeyframeProxy 4K→2K、writeH3KeyframeProxy refuses non-4K。

卡面「全套292基準（284pass/7紅）」係 lane/crew 樹參考數（Vera C123 判詞）；seats 樹基線如上 387/380/7。

### S4 專項

- **motion golden 三重**：h3-r2v-graph.test `ok 1 builder deep-equals the H3Keyframes golden`＋`ok 2 official H3Keyframes node, never H3KeyframeInject`＋`ok 3 positions one entry per anchor（'0%, 100%'/'0%'）`——三鎖全綠（builder 對 golden deepEqual / Inject 禁詞 / positions 不變式）。h3 四檔批（graph/submit/doctor/pipeline）43 tests／42 pass／1 fail（＝pipeline resume 基線紅）。
- **qc batch**：photo-qc.test **72/72 pass 0 fail**（pose疊加 6 新＋strip 鎖全在）。
- **tsc --noEmit**：追蹤檔 **3 錯全 pre-existing**——memory.ts node:sqlite（TS2307）、pipeline.test.ts bun:test（TS2307）、pipeline.ts:492 kept（TS2353，MERGE_P1 收據早列）。noun-lint hits 12＝4908bc8 基線逐條同名（途中一度 23，收口見 §4）。

## 3. GAP② 解法（逐處列——--no-ff 批准條件）

| # | 位置 | 揀咗邊行 | 兩邊功能點解仲喺 |
|---|---|---|---|
| 1 | `types.ts` | 兩邊並存零交疊：c123 `export type RefAngle = "front"\|"45"`＋`shot.refAngle?: RefAngle` 留原位；motion `import type { UiShotSpec } from "./h3-prose"; export type { UiShotSpec }` 加喺後面 | 兩個 identifier 唔相撞，Shot 型同時載 refAngle（角度ref）同 uiShot/uiSpec/uiRefs（UI photo通道）——S1 測試（C1 45°）與 S2 測試（uiShot 閘）各自全綠 |
| 2 | `doctor.ts` H3_NODES probe | 兩邊同一切名（`H3KeyframeInject`→`H3Keyframes`）：crew 側 ed628fa、motion 側 2d2c0c0，merge 匯流成一筆；註解取 motion「card C ①」 | 改動語義相同無分叉；S2 後 graph（fa15ce9）／golden（h3-r2v.api.json）／probe 三者同一 node 名——S1→S2 之間 doctor 短暫 probe 未切 node（Vera C123 備註嘅「半截」），S2 收口，收據 §2 h3 四檔批 43/42/1 為證 |
| 3 | `h3-prose.ts` `BuildProseOpts` | union 三欄：seats `prevLocation`（return-pin）＋motion `ui`（UiShotSpec）＋`timingRef` | `buildProse` 用 motion 嘅 mode-pick（`opts.ui → identity-long`）；action-short 路徑保留 seats return-pin（`prevLocation`）；identity-long 用 motion buildProseLong（sound design ③a＋UI mapping ③b）——28/28 綠 |
| 4 | `h3-prose.ts` PIN 句 | seats PIN 句（雙 `{{PROP}}`）＋motion buildProseLong 嘅單數 `replace`→**修為 `replaceAll`** | 真 merge bug：seats PIN 句有兩個 `{{PROP}}`，單數 replace 淨低模板字入 prose；motion 原句單佔位冇事。h3-prose.test #9 鎖住 |
| 5 | `pipeline.ts` `h3MotionPack` | motion 嘅 `export`（測試要）＋seats 私有 helpers（prevShotOf/writeH3Plan/assertH3SubmitWiring）全部留 | story-shot 分支帶 `{ prevLocation: prev?.location }`（seats law）＋motion uiShot 閘/uiSpec prose/uiRefs 通道原封；ui 分支照 motion |
| 6 | `h3-r2v-graph.ts` graph opts | seats `visualStrength` 留＋motion `uiPhotoNames`/`audioTimingRefName`/`proseMode` 加；inputs 區取 motion 排版（值同） | golden 三重（builder deepEqual／Inject 禁詞／positions 不變式）全綠為證 |
| 7 | 測試側 | 兩側 test 並存；三處重校各帶 `MERGE_THREE_0921` 行內註解：①h3-prose thin packet 改單 mark＋空 action（seats PIN 句較重，原 2-mark 校準過 150）②C1b lock-delta 改減法式（景別行騎 lock 後，union extras 順序）③C1 fat 改五人 fatSheet（seats 短句下 2人唔夠爆 300，法唔變） | 語義不變只遷就 seats 校準值；lane 斷言原文留存於 lane parent（ed6fa/241d101 可尋） |

一句總結：types 兩邊並存零交疊（RefAngle＋UiShotSpec 同檔）；doctor 兩邊同切 H3Keyframes 匯流；h3-prose opts 三欄 union；h3MotionPack story 線帶 prevLocation、ui 線帶 uiSpec。

## 4. 語義裁決表（兩邊對撞位，照「已 verify 較新事實」裁）

| 對撞 | 裁決 | 根據 |
|---|---|---|
| 【動作】句來源（seats 0c636e9/94f8b74 shot.action 恆出 vs lane c123 純 packet require.action） | **seats 贏**：actionBlock 加 shot.action fallback（packet 有 freeze 句優先）；QC require action key 鏡射 prompt 源（require.action ?? shot.action）；c123 測試一句 assert 改 fallback 形 | seats 兩 commit 係 WR1Q 真跑實證（SH04 唔夠 150 會拒出＝生產死）；同 bug class c123 自己都係修呢樣 |
| 模型 pin（lane 舊 c10 預設 sensenova/qwen3.6-35b vs seats nex-n2.5/qwen38） | **seats 贏**（crew-llm＋slatecrew.config）：nex-n2.5 註解帶「flash-lite content=null 半死」較新實證；lane 側唔係本卡 payload | 較新 verify 事實；文件係 seats 整合目標 |
| PIN 句雙 `{{PROP}}`＋motion buildProseLong 單數 `replace` | **修咗**（→replaceAll）——真 merge bug，h3-prose.test #9 鎖住 | seats PIN 句（<Video 1>＋morph 禁）係 seats 法 |
| SYSTEM_RE「系統」token / SYSTEM_FORM_RE「系統人樣」 | **seats 紀律贏**：唔收（4908bc8 port 已剷——「系統」係 guojia-lingdaoren 劇目 entity＝story noun，noun-lint 硬閘）；lane 註解字眼去 token 化（系統形象法→光框法、系統人樣→全息人樣），RE 語義由其餘 token 承擔 | 硬閘＞功能微差；noun-lint hits 23→12＝基線 |
| 收據 add/add（SYSAVATAR） | seats 重放版為準；Kit 原版在 merge parent 史（git 可尋） | seats 樹自有重放記錄 |
| T35 warn-speak / T37 眼板 / T40 cli | lane 法**保留**：warn-never-GREEN speak、buildShotSheet/writeSceneSheetHtml graft 入 bug4 in-loop 結構、photo-qc-cli 入樹（import.meta.main bun guard） | lane/qc 功能齊原則 |

## 5. 未做／留手

- 冇 push github（未准）；冇停任何服務；jobs 數據（data/jobs）零接觸；冇開 E2E job（等 Vera 驗＋E2E 卡）。
- lane 側 worktree 卡外 dirty（.env.example/crew.ts 等）原封留在各 worktree，未 commit。
- verify/crew/CARD_BUG3_0920.md 判詞備註嘅 wist-sh07 frozen fixture 命運、lane/qc T41b/T37-fix 等其餘 commit——照 lane 全史 merge 已入（ parents 鏈可尋），語義重複處以 seats 手 port 版為準。

## Handover

- 收據：本檔。backup patch＋紅名單：`/home/c/orca/workspaces/sov-cli-merge-wip/Wire/out/`。
- 等 Vera 驗 be2fea8（+S1/S2/S3 三個 merge commit）；E2E 卡另開，唔係本卡。
