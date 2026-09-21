# CARD_COMBAT_PORT_0921 — combat_action_engine移植入slatecrew（Forge, lane/combat-port, 0921）

法源：SlateLead 0921卡——continuity.ts 59行只鎖世界一致、零動作因果（SH01打鬥連續性fail根源層）；源碼真源`/mnt/ssd/h3studio/`（read-only，全卡零寫入）。
基線：crew-seats 4e1651c（MERGE_MOTSEL_0921），worktree `/mnt/ssd/crew-wt/combat-port`，branch `lane/combat-port`（3 commits：0cdcbba→424fc79→6be270b）。
S1批覆條件（三條全數兑現）：①非combat路徑byte-identical有test ②combat訊號先行 ③ACTION_RISK入events＋receipt。

## 做咗咩
- **S1 判決：TypeScript直譯，唔做Python wrap**——66KB純data transformation（regex分類＋模板合成＋dict relay，stdlib得re/copy）1:1落TS；wrap會令render path依賴外repo路徑（h3studio一update我哋render靜靜變）。Golden用**真Python引擎跑凍結input出fixture**（本機python3.11，h3studio自家21/21綠），drift死喺test time。更正卡文一處：preset係**六族各32**（`_presets()`對≠32 raise ValueError，import實數），唔係33/33/32。
- **S2 core port**（`combat-action.ts`，Python函數名原樣保留方便逐段對照）：Beat七欄structured_beat、六鍵state relay（＋guard_or_grip/wetness_damage）、_causal_validation_issues繼承≥4/6、五載體路由（weapon/supernatural未授權警告）、12扇區動態camera、**六種auto_repair**（generic pose/outcome-only/self-defence演員/ground ownership/repeat/carrier）user_edited讓路、fact ledger權威序、markers Final Combat Resolve重錨、speech_tail_hold、prompt clause＋compact field。Python數值語義逐位跟：`:.2f`正確十進位half-even（fmt2，toFixed(60)精確展開）、`round()`half-even（pyRound）、len/slice計code point——1.125→"1.12"、4.375→"4.38"同Python逐位一致。**Golden 26 case**（gen-golden.py）：13 reconcile（含重複生成vs用戶、sword生成vs用戶、空action、單beat、final settle、aftermath-only）＋2 markers＋3 ledger＋4 apply（他skill原樣返回、hk-comic speech tail、**唔繼承Kowloon濕貨市場**）＋baseline/clause/compact/載體力向量。
- **S3 presets＋adapter＋三處加法hook**（`combat-presets.ts`＋`combat-adapter.ts`）：六族×32 verbatim（_presets guard照搬assertPresetFamily）＋SHOT/MARKER/TRANSITION recommendations，golden鎖python-presets.json。Adapter：`hasCombatCause`（env引擎_has_combat_cause原word list）＋`detectCombat`（≥2 marked characters＋combat cause）＋`applyCombatToSheet`（名↔S1/S2雙向映射，screen-left mark=S1；**唔改寫packet欄位**——修復只影響combat view，shot.action/require原封）＋`combatProseSpec`（**Physical Contact卡法第一唔drop**、因果relay句、throw/ground加Motion Discipline＋Anatomy Lock、前鏡combat帶Match-on-Action momentum-carry剪接句、weather→Rain/Natural Outdoor/Urban Night soundscape，全部preset原文verbatim）＋`applyCombatPass`（ACTION_RISK events A4形＋`combat/combat-pass.json`收據）。Hook：types.ts `Shot.combat?`（type-only，UiShotSpec前例）、h3-prose.ts identity-long combat段落（**budget計埋未加嘅dialogue**，T42 300詞first-fit drop序）、pipeline.ts boards段lockContinuity後combat pass＋h3MotionPack三個buildProse位傳prevShot。keyframe-prompt（stills lane）**唔落preset**：/edit 150–300 CJK硬預算＋「packet-authored、code只組裝」法，英文preset會打呢兩條法；打鬥連續性係motion問題，freeze句已由require.action企位。
- **S4 環境繼承**（`combat-environment.ts`）：venue core直譯——transition time半秒grid、四級location ladder＋threshold crossing、venue效果表＋八物料MATERIAL_RESPONSE、directional responses（沿力向、次級唔逆行）、延遲crowd response、persistent ledger（渲染bounded last-6）、ENV-PHYSICS/ENV-IN/ENV-OUT/LOCATION行協議、user-edited讓路＋無因interaction警告、prompt clause。**Golden 10 case**（gen-env.py）。新增`environmentRelay`：同一套bounded-ledger機制行**單一packet location**（require.location??shot.location??sheet尾，場景slot法；地點變更開新ledger）；NEUTRAL_EFFECTS六行adapter data（**注明非源文**，源表係Kowloon品牌）；light無persist字唔入ledger（源法）、同文dedupe、bound 6；駁入`Shot.combat.environment`＋prose persistence line。
- **修咗一個真bug**：nameToEngine嘅length sort會將角色調轉（陳師傅3字/大強2字→長名錯綁S2，engine text「S2 punches S1」）。排序保留（重疊名安全），但每名綁自己token（s1→S1/s2→S2）；加第一beat主語名斷言。呢bug喺映射層，引擎golden鎖唔到——映射層test釘死。

## proof
```
cd /mnt/ssd/crew-wt/combat-port
./node_modules/.bin/tsx --test src/lib/studio/combat-action.test.ts src/lib/studio/combat-presets.test.ts src/lib/studio/combat-adapter.test.ts src/lib/studio/combat-environment.test.ts   # 27/27
./node_modules/.bin/tsx --test --test-force-exit src/lib/studio/*.test.ts   # 527/520/5紅
./node_modules/.bin/eslint src/lib/studio/combat-*.ts src/lib/studio/combat-*.test.ts   # 0錯
```
- **Golden三份全deep-equal綠**：python-golden.json（26 case）、python-presets.json（六族×32）、python-env-golden.json（10 case）——全部由verify/combat/gen-*.py read-only跑真源凍結，**h3studio @ 2bc8c907 anchor寫入每份fixture頭**，test斷言anchor。
- **全套實數**：527 tests / 520 pass / 5 fail——5紅**全部＝crew-seats 4e1651c基線同名紅**（noun-lint、resume/bun:test、27B-fake-fetch、no-seat-grave、Chau-home-paths）；基線500 test/493綠/5紅/2 skip，本卡+27 test、**紅名零新增**。
- 卡指定驗收：兩shot打鬥序列→relay繼承**6/6**（incoming===前鏡outgoing）＋Beat七欄齊＋ACTION_RISK喺user-owned重複序列觸發（warning＋「repeats the preceding Shot」，用戶原文零改寫）。
- 非combat byte-identical：既有h3-prose/pipeline test（鎖死舊輸出字符串）照舊綠＋新test斷言非combat prose零combat句、同sheet過pass輸出逐byte相等；detectCombat閘——兩人對望冇打鬥動詞→pass完全no-op（零event零收據零combat欄，test釘死）。
- tsc combat檔零錯（全套tsc 5錯全基線其他檔）；noun-lint combat檔**0 hit**（總12 hit全基線）。

## 接線位＋依賴聲明（DISPATCH_BOARD規3）
- 共用檔三處，全部**加法式、flag-gated**：`types.ts`（Shot.combat type-only選填欄）、`h3-prose.ts`（buildProseLong尾段combat段落＋BuildProseOpts.prevShot；dialogue預算先計）、`pipeline.ts`（boards段applyCombatPass一行hook＋h3MotionPack三個buildProse位）。
- **merge次序（SlateLead 0921釘）：mswire先行、本卡第二**——rebase上mswire結果後重跑byte-identical＋全套先准交Vera。預飛（merge-tree 4e1651c vs lane/motion-mswire@0a4ba50）：實際交疊＝pipeline.ts＋types.ts（mswire**唔掂h3-prose.ts**，佢嘅multishot接線喺h3-r2v-graph＋motion loop）；試合併**零衝突標記**，兩檔加法hunk與motion loop重組區域唔撞。本卡全部係`if (shot.combat)`閘住嘅加法，非combat路徑byte-identical有test釘死。
- combat訊號 = `detectCombat`（≥2 marked chars＋combat cause）——唔係skill flag，slatecrew無skill概念，訊號源自packet數據本身。

## 未做咗（照卡「渲染細節後卡」＋範圍外）
- **唔port**：reference/comic世界級power-field VFX路徑（CONTINUOUS_LEGENDARY_POWER_FIELD、solar corona）、environment plates媒體請求、_install_continuous_power_field——綁住H3 Studio嘅comic Skill，屬渲染細節；`_location_description`源碼core本身dead唔port（注明）。
- live端到端produce未跑（卡範圍＝port＋golden＋接線；pipeline hook已接但冇燒真job——jobs零改動硬閘遵守）。
- 真combat slate嘅端到端golden未有（新golden跟下一個實job開）。
- h3studio四條combat sweep（17967-70）照板等Chau表態。
