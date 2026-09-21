# CARD_CFORM_0921 — §5b C形分流（Mo, lane/motion-cform, 0921）

法源：CHAU_FULL_FLOW_LAW §5b（0921 Chau裁 good go）＋E2E SC-0921-9V4Y六路A/B實證（SH01.c8 mp4 tg 17976）。
基線：crew-seats 0229bca，隔離worktree `/mnt/ssd/crew-wt/motion-cform`，branch `lane/motion-cform`（commits 30e6157 → 5532d10）。

## 做咗咩

### S1 分流（決定欄位＝Video 1 asset：`blockout/{shot}.mp4` 喺唔喺 disk）

| 情形 | form | H3Keyframes | ref_image_0 | Video 1 | BINDINGS | prose pin |
|---|---|---|---|---|---|---|
| 有blockout（動作shot，生產正路） | **C** | **零node** | 角度肖像（照refAngle揀`{id}.png`/`{id}_45.png`） | blockout motion-only | `BINDINGS_CFORM`（C8款原文減scene句） | `<Picture 1>` |
| 冇blockout（still-to-video） | **A** | 0%/100%兩端 | 無（story零ref_images） | 無 | `BINDINGS`（照舊） | start keyframe image（照舊） |
| UI shot（③b）＋blockout | **C** | 零node | ui board（③b mapping照舊行ref_images） | blockout | `BINDINGS_CFORM` | ③b mapping句 |
| B/BKF/C alternates | 照舊 | b/c/bkf照舊 | b/bkf照舊 | 禁（submit拒收） | "" | buildProsePositive照舊 |

- `buildH3Graph`（h3-r2v-graph.ts）：`blockoutName`選填＝分流欄位；C形唔起keyframes/kf_strength/cond_combine（guider直指`cond_cs`）；A形要kfStartName（冇即throw）。
- `planH3Shot`（h3-slots.ts）：plan加`form`欄；C形`keyframes:null`＋photo slots=AnglePortrait（角色/refAngle/檔案）＋missKeyframe改identity調法（never含coexist禁句）；`assertH3Plan`/`assertH3SubmitWiring` form-aware。
- pipeline（h3MotionPack＋dry-run/live兩個motion loop）：`fs.existsSync(blockoutMp4)`決定form；`anglePortraitsFor`照marks左至右排、refAngle=45揀`{id}_45.png`（job portraits dir或`--portraits` plug dir都會搵，WR1Q款供給），**缺45°版＝throw `angle_portrait_missing`（正面版會拉返個面，B-lane regression，唔准頂）**；submit收據新欄`motion_form`（"a"|"c"|null）＋C形`keyframe_positions:""`＋`uploads.kf_start:null`。
- prose（h3-prose.ts）：新`PIN_SENTENCE_CFORM`＝「Faces and clothes continue exactly from <Picture 1>. Same {{PROP}}, not a morph. Do not add people.」（C8實證script款）；`buildProse`加`form` opt，**默認"a"零漂移**，pipeline兩form明傳。

### S2 FBC閘（§5b node1機器事實）
`buildH3Graph`：FBC/SolAttn **只喺`steps===4`**起（turbo4路照舊）；任何非4步（8-step v1.0＝而家config）chain＝loader→lora→sigma，**零FBC/SolAttn node**（8-step LoRA行FBC爆tensor 17428≠17418結構性，B1v3）。b/bkf/c variants同樣受閘。

### S3 禁並存斷言（四層，prompt_too_thin款refuse-to-emit）
1. `buildH3Graph`：blockoutName＋kf名→`throw keyframes_video1_coexist`
2. `submitH3Shot`：blockoutMp4＋kfStart/kfEnd**意圖**→throw（S1版收咗意圖但唔傳名落builder＝靜靜地跌，S3補返）
3. `assertH3SubmitWiring`：C形plan＋kf wiring→throw；A形plan＋blockout wiring→throw
4. WIST實data：A路並存submit→`assert.rejects(/keyframes_video1_coexist/)`

### Golden對拍（S3）

| | 舊0229bca並存golden | **新`workflows/h3-r2v.api.json`（C形）** | **新`workflows/h3-r2v-still2video.api.json`（A形）** |
|---|---|---|---|
| nodes | 35 | **27** | **30** |
| steps | 8 | 8 | 8 |
| keyframes node | 有（0%,100%） | **無** | 有（0%,100%） |
| FBC/SolAttn | 4節點@8步（死配） | **0** | **0** |
| ref_image_0 | — | `__PORTRAIT_A__` | — |
| Video 1 | 有（並存＝§5b死路） | 有 | 無 |
| lora_a.model | `["solattn_ref2va",0]` | `["ref2va",0]` | `["ref2va",0]` |
| guider.cond | cond_combine | **cond_cs** | cond_combine |
| split bindings | 舊still句 | **C8款** | 舊still句 |

兩份golden都係builder重生（README重寫生成法；runtime永遠唔讀呢兩檔）。

## proof

```
cd /mnt/ssd/crew-wt/motion-cform
./node_modules/.bin/tsx --test src/lib/studio/*.test.ts   # → S4實數（下）
bun run typecheck                                          # → 非測試錯4＝基線同名（見下）
```

逐檔實數（tsx --test）：
- h3-r2v-graph 16/16（C形/A形golden deep-equal＋coexist拒出＋FBC閘steps 4/6/8/20＋b/bkf/c照舊）
- h3-slots 10/10（C形plan/A形plan/coexist wiring/45°肖像缺件……）
- h3-submit 7/7（C形receipt：motion_form=c、kfpos=""、kf_start=null；A形照舊；並存reject）
- h3-dry-run-wist 2/2（WIST實job data；A＝C形全斷言＋**四variant全部零FBC/SolAttn**）
- h3-prose 29/29（+1新「form c pin指Picture 1」test；T42 28個全綠——默認a零漂移）
- pipeline 18 tests 17 pass 1 fail——**1紅＝基線同名**（resume test嘅`bun:test` import，基線0229bca同紅，已實證：基線pipeline.test.ts 16 tests 15 pass 1 fail同名）

WIST C形收據樣本（worktree內副本`data/jobs/SC-0913-WIST/verify/ab/dry/SH01.A.json`）：
`graph_variant=a, motion_form=c, steps=8, keyframe_positions="", uploads.kf_start=null, ref_images=[...ref_img_0.png], graph零keyframes node, 零FBC, ref_image_0=["ref_img_0",0], bindings=<Picture 1> is the sole appearance..., prompt pin=Faces and clothes continue exactly from <Picture 1>`。

tsc（`bun run typecheck`）：**5錯全部＝0229bca基線同名**（`scripts/nex-blender-real-call.ts` TS5097×2、`memory.ts` node:sqlite、`pipeline.test.ts` bun:test、`pipeline.ts` PortraitResult kept——基線實跑清單逐個對過名）。worktree要`npm ci`＋`npx next typegen`（gitignore咗嘅next-env/.next types係生成物，基線樹有、新worktree冇——LayoutProps個假錯係咩嚟，typegen後消失）。

S4全套實數（`tsx --test --test-force-exit src/lib/studio/*.test.ts`——`--test-force-exit`係必須嘅：photo-qc.test.ts §7 hang→retry個fixture server嘅`close()`等緊吊住嘅socket，成個test child永不退場（基線同樣，001a6c6帶入嘅pre-existing test-infra漏；test本身72/72綠，單檔實證）：
- worktree（lane/motion-cform 5532d10+收尾commit）：**485 tests / 480 pass / 5 fail**
- 基線（crew-seats 0229bca，同機同時實跑）：**480 tests / 473 pass / 7 fail**（＝0229bca自報「全套480/473pass/7紅」實數重現）
- 紅名對拍：我5紅（noun-lint、resume/bun:test、27B-fake-fetch、no-seat-grave、Chau-home-paths）**全部係基線同名紅，零新增**（名單逐一對過：`comm` diff兩個log嘅test名）
- 基線多出嘅test全部來自基線樹**untracked WIP檔**（`git status`＝`??`）：`still-h3-proxy.test.ts`（3 test，2紅——件WIP import唔存在嘅STILLS_EDIT所以紅）＋`blender-bin.test.ts`（2 test綠）——唔係0229bca嘅內容，我worktree由git 0229bca開所以冇呢啲檔。剝走後：**基線git檔案集＝475 test/5紅；我＝485 test/5紅＝+10 test（graph+2、slots+3、submit+1、wist+1、prose+1、pipeline+2）、紅名零新增**。

## 未做咩
- **真render驗證冇做**（卡禁自己開render job）——C形graph嘅實物驗證係E2E SH01.c8（tg 17976，NEX三問全過＋五問乾淨）；呢卡只做pipeline出同一形狀graph（golden＋WIST dry receipt對拍）。燒掣喺Chau/Vera。
- **45°肖像生成lane未做**：pipeline而家只會「揀」`{id}_45.png`（job portraits dir或`--portraits` plug dir供給），唔識「造」；refAngle=45嘅shot喺新job冇45°版→C形submit會fail loud（好過燒一個拉面返嚟嘅render）。生成＝ensurePortraits加u15Edit 45°步（portraitPrompt 45°公式已驗證），留下一張卡。
- jobs數據零改動（WIST係複製入worktree嘅副本；主樹crew-seats dirty同開工前一致）。主樹WIST `verify/ab/dry`收據10:35時間戳係我跑基線對拍時基線test自己寫嘅（同任何基線套件run一樣）。
- `--scene` hop嘅dry-run：hop外鏡頭冇blockout在disk→出A形收據（§5b語義正確：冇Video1 asset；以前係並存形）。
