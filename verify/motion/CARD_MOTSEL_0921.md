# CARD_MOTSEL_0921 — motion-select skill入repo（Mo, lane/motion-motsel, 0921）

法源：Chau 0921架構令（灰模片Video1由motion database揀，Jev式一次過）。
依據：MOTION_SELECT_0921試驗（SlateLead/scratch/motsel-0921/全套收據：一call 10.2s出5/5、temp0三跑一致、verb gate 5/5、壓力shot 02_06＝jev-pilot手揀同一條）。
基線：crew-seats 0229bca，worktree `/mnt/ssd/crew-wt/motion-motsel`，branch `lane/motion-motsel`（2 commits）。

## 做咗咩
- **S1 L0/L1座席步**（`src/lib/studio/motion-select.ts`，deterministic零LLM）：`parseCmuIndexText`（Subject頭＋`NN_MM\tdesc`，零位補齊id）＋`buildCmuIndex`（walk `cmu-mocap/data/**.bvh`；實測**2548在盤/2435有index描述**，113條照實標「no CMU index description」）＋`parseCombatSweepRanking`（**73條**臂軸mean/min/frames）＋`buildShortlist`（六族caps=martial34/walk22/run14/bend_pick20/sit18/stand_idle12＝**120**；martial照ranking低mean seed——C01=74_06 mean20°；**兄弟dedupe同subject同desc留一**：07_02/07_03消失07_01獨存＝trial揀中嗰條，conf 0.15假低訊號源頭結構性剷走；candidate行**必含category**——111_19 Pregnant Woman教訓）。`familiesForAction`：zh/en動詞→族自適應（英文action詞加闊族網，中文action對CMU英文desc係no-op，六族基本盤不變）。
- **S2 一call decider**：`selectMotions`＝**一個POST** :8015 qwen38（temp0/logprobs top-20/max_tokens 700；fetchImpl可注入）；prompt＝candidate表（`code id | category | desc [arm-axis]`）＋全shot；嚴格一行一shot（regex `C\d{2,3}`食到三位碼）；短parse重試**一次**（上限2 calls，計入result.calls）；再唔齊fail loud。`chainConf`＝chain-rule短路：每digit位top-20 renormalize去「仍通向有效候選嘅digit集」連乘；emitted digit跌出top-20＝floor best-6.0＋flag。
- **S3 閘＋schema**：`verbGate`（any-of命中過閘；all-of計partial flag——SX1實證rise/scoop中、stand up/pick唔中＝partial綠）；pick miss→runner-up重驗→三miss throw `verb gate fail`；`decideSelection`：conf≥0.7 auto，<0.7 tie-break（臂軸mean→CMU高號subject→時長近shot；分唔出`needs_human:true`）；flags＝clip_short/subject-metadata/verb-partial/low-conf tie-break；`bakeFor`＝`{start:1,len:round(durationSec×120),step:2,auto_anchor}`（4.82s→**1+578 step2**＝trial bake收據實參，唔係卡文嘅120/step除數——bake嘅--len食窗口源frames）；`writeSelections`寫job `motion/selection.json`；`bvh`欄**相對`cmu-mocap/data/`**（`data/data/`雙data路徑斷言禁——bake_combat.py docstring炸路徑教訓）。bake本身留repo外。
- **S4 fixtures＋test**：trial三份凍結入repo `src/lib/studio/motion-select-fixtures/`（shortlist/decision-raw token流/decision-gold含raw text）；`motion-select.test.ts` **15/15綠**。

## proof
```
cd /mnt/ssd/crew-wt/motion-motsel
./node_modules/.bin/tsx --test src/lib/studio/motion-select.test.ts   # 15/15
bun run typecheck                                                      # 非測試錯4＝0229bca基線同名
```
- **golden replay（F3）**：mock :8015回凍結token流→五shot pick/runner/**chain conf實數0.7502/0.1501/0.8354/0.7485/0.3274全中**，calls=1。
- **一call斷言（F2）**：完整流calls=1；短parse重試calls=2；兩短→throw /parse incomplete after 2 calls/。
- **F4 dry-run**：SC-0921-9V4Y callsheet（SH01/SH02）＋凍結流→selection.json出：SH01=111_19 auto conf0.7502 bake{1,578,2}；**SH02 conf0.15→tie-break 07_03（416f最近4.82s）贏07_01/07_02，tie_break記錄留檔、auto=false**。
- live實證：index 2548/2435、ranking 73、shortlist 120 caps全中、兄弟組=0、111_19 category隨行；BVH Frames:讀取111_19=1025/07_01=317（header喺~4KB深，chunked讀到64KB——首1KB讀唔到係實測捉到）。
- tsc非測試錯**4＝0229bca基線同名**（scripts TS5097×2、node:sqlite、pipeline kept）。
- **S4全套實數**（`tsx --test --test-force-exit src/lib/studio/*.test.ts`）：**486 tests / 480 pass / 5 fail**——5紅**全部＝0229bca基線同名紅**（noun-lint、resume/bun:test、27B-fake-fetch、no-seat-grave、Chau-home-paths），逐名comm對拍；基線git檔案集＝475 test/5紅（同機同日CFORM_0921卡實測，基線untracked WIP檔剝走後），**本卡+15 test、紅名零新增**（F1 ✓）。

## §5b銜接（CFORM上游供給）
selection.json →（repo外bake_combat.py）→ `blockout/{shot}.mp4` →CFORM嘅`fs.existsSync(blockout)`分流自然行C形。本worktree基0229bca（CFORM未merge），motion_form全鏈斷言住喺lane/motion-cform；兩lane獨立merge零依賴（本module零pipeline import）。`blockoutPathFor`鎖路徑慣例＝pipeline blockout lane同一路徑。

## 未做咗
- pipeline接線（produce行埋motion-select）唔在本卡（卡只有S1-S4 module+test）；bake調用留repo外。
- live :8015一call冇再燒（trial已實證10.2s/5shot/temp0三跑一致；本卡mock replay鎖行為）——卡禁以外仲有：唔停唔改:8015、motion library零寫入、jobs零改動（F4讀真callsheet但selection寫temp dir）。
- 需要9V4Y之外callsheet嘅golden：未有（新golden跟下一個實job開）。
