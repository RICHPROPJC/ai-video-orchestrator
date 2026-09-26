# CARD_BUG3_0920_VERDICT — Vera 0920

Verify對象：commit `10e7e4638dad6d5069941a38bac0f53ab75f2841`（lane/crew，worktree /mnt/ssd/crew-wt/crew，base 3239ded）
收據：`verify/crew/CARD_BUG3_0920.md`（本人獨立重跑，唔信收據句）

**結論：MERGE_OK** — 七點驗收全數屬實；兩處收據偏差（見 §備註）唔構成 hold。

## 驗收表

| # | 驗收點 | 結果 | 證據（本人重跑） |
|---|---|---|---|
| 1 | 禁句零hit（committed 10e7e46 非 test src，4句＋12同族token） | PASS | `git grep` 16 樣式對 10e7e46 `src`（排 `*.test.ts`）：`.ts` 非 test src 零hit。②「夜只由室內燈」本 lane 零hit；收據 §1 有列 seats 側剷除表（四句＋sceneLine :105/:100/:107），且本人實查 crew-seats HEAD（0c636e9，1d9bb51 係祖先）keyframe-prompt.ts 四句確實仲在——表屬實 |
| 2 | BUG3_BANNED test 真鎖 | PASS | 讀 test 本體：5 形 prompt（first/later×大衣/通緝令/無prop＋facts-screen）× 14 句零 hit，逐句 assert 帶 leak 訊息；唔係淨收據句 |
| 3 | cookbook 六段形狀＋150–300雙向閘 | PASS | 六段齊：【底圖】(Image-1作用＋變/保對：變=質感/材質/光線、保=人偶位置/姿勢/佔位保持照 Image-1)【人物】(左起第i人偶＝Image-i+2、面容髮型成套衫著照 Image-N、朝向動作跟 Image-1)【場景】【道具】(noun-class三分支)【光影材質】＋keep段(first=「淨係得呢N個角色」人數錨／later=Image-2定格連續性)。cjkCount CJK-only、150/300、thin→`prompt_too_thin`／fat→`prompt_too_thick`、facts 騎 band 後。**本人機印**（/tmp probe，2人+軍大衣，shot.location=地下室）：first=250／later=249 同喺 band，兩形零禁句，【場景】=地下室、sheet尾「茶餐廳門口」零滲入 |
| 4 | sceneLocation 真相源一個 | PASS | `trim(shot.require?.location ?? shot.location) \|\| sheet.location.trim()`；types.ts ShotRequire.location 入型（「the ONE scene truth source」註釋）；keyframeRequire 冇開第二 gate 欄位；test 鎖三級（require贏/shot次/sheet尾最後）；probe 證 fallback=茶餐廳門口 |
| 5 | 第二眼 config | PASS | config.ts `pictureQc.secondEndpoint/secondModel` DEFAULTS 空串（unarmed）＋`SLATECREW_SECOND_ENDPOINT/MODEL` env 覆蓋（MARS_URL 同式）；slatecrew.config.json 帶 `http://127.0.0.1:4000`＋`glm-5.3-flash`；doctor.ts `probeSecondQc`（unarmed 唔掂網絡、armed 先 probe）；doctor.test BUG3 item4 三分支真 assert（unarmed 講明 PASS_UNCONFIRMED 天花板／armed UP+model present／armed DOWN url+error）。**本人 live 跑 doctor：`second UP http://127.0.0.1:4000  glm-5.3-flash present`**，同收據逐字一致 |
| 6 | 跑測試對基線 | PASS | keyframe 18/18、u15 fail 0、doctor fail 0（本人跑）；全套 **284 tests / 276 pass / 7 fail**，7 紅名逐字同收據一致：blockout render 4（blender render exit 1，Material.use_nodes deprecation／pci bus 環境錯）＋pipeline 1（L95 `await import("bun:test")`，tsx ESM loader 唔收 `bun:` protocol，逐字喺 HEAD）＋reflector 2（seat reflection validation）；三個紅檔本 commit 冇掂、唔 dirty；tsc **17 錯=基線**，其中涉及 keyframe-prompt 嘅 `pipeline.ts(29,47) loadBaseCast TS2305` 經查 base 3239ded 已存在（base 嘅 keyframe-prompt 同樣冇此 export、base 嘅 pipeline.ts 同樣咁 import）＝HEAD 原有，唔係本 commit 新錯 |
| 7 | 冇越界 | PASS | commit 9 檔全部 lane 範圍；crew-seats checkout（/mnt/ssd/ai-video-orchestrator-crew）本 commit 掂唔到（commit 只喺 lane/crew）；他人三檔 dirty（.env.example、crew.ts EVIDENCE_LAW、seat-charters）原封未入 commit（本人 diff 對過）；`git branch -r --contains 10e7e46` 零輸出＝冇推 github；無停任何服務，live doctor 證 :4000 仲喺度 |

## 備註（唔 hold，但要記低）

1. **收據殘留清單唔完整**：收據 §1 話殘留 mention「淨係 (a) test BUG3_BANNED (b) seat-charters heightM 註釋」——漏咗 `src/lib/studio/trace-fixtures/wist-sh07.json`（非test src by path），入面有①族「人偶位置、姿勢、比例、鏡位、地平線完全照 Image-1」＋④族「唔好加人」。定性：凍結嘅 trace 記錄數據（`loadTraceFixture` 只有 trace.test.ts 引用，生產 pipeline 只 import gate 函數；noun-lint SKIP_DIRS 明文豁免 trace-fixtures；base 3239ded 已存在，本 commit 冇掂）。發射路徑乾淨，唔構成禁句滲出。seats 重放剷句時要一併決定呢個 fixture 命運。
2. **收據 seats HEAD 指針過時**：收據寫 crew-seats HEAD=1d9bb51，而家 crew-seats 分支已行到 0c636e9（lane/e2-min 嘅嘢，1d9bb51 係其祖先）。四句禁句喺 0c636e9 嘅 keyframe-prompt.ts 仲在，剷除表實質正確，只係 HEAD 指針要更新。

## Handover

- 判詞檔：`/mnt/ssd/crew-wt/crew/verify/vera/CARD_BUG3_0920_VERDICT.md`（本檔）
- probe script：`/tmp/vera_bug3_probe.ts`（可重跑：`cd /mnt/ssd/crew-wt/crew && npx tsx /tmp/vera_bug3_probe.ts`）
- 等 Grok sequential-merge `lane/crew` 入 `crew-seats`；重放時帶埋 §備註 兩項。
- 本人全程 read-only on src；只寫咗 verify/vera/ 同 /tmp。
