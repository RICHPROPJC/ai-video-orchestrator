# CARD_C_0919 — P1卡C：H3三卡（Mo, lane/motion, 0919）

## 做咗咩
- **卡①（大）**：`h3-r2v-graph.ts` H3KeyframeInject→官方 **H3Keyframes**（live node1 object_info probe 收據 `verify/motion/H3Keyframes.object_info.node1.json`；source＝ComfyUI-H3-Multishot `h3_keyframes.py`）。anchors＝image_1/image_2＋`positions:"0%, 100%"`（%定位天生；冇end＝`"0%"`）；keyframes positive 行官方 `H3ConditionStrength`（0.999/1.0同v6）；refs conditioning（voice ref_audio_0＋Video 1 blockout）與 anchors positive 用 stock `ConditioningCombine` 合流→guider；latent 仍 `["r2v",1]`（兩node同出 `_empty_av_latent`）。v6常數（turbo 4-step/SolAttn/FBC/SigmaShift/LoraStack）原封。新golden `workflows/h3-r2v.api.json`（diff＝kfinject拆走、keyframes+kf_strength+cond_combine加入，別嘅零郁）。images_batch＝「動作anchors」語義寫明喺代碼註釋（anchors batch AFTER image_N slots，一anchor一positions位），未接線。
- **卡②（細）**：cli.ts help＋types.ts graphVariant doc 標明 b/bkf＝**documented fallback**（角色圖ref官方正路 samples #17/#22/#23/#31/#34，但A路still已燒身份——冇still釘身份嘅鏡頭先用）；c＝verify實驗位。代碼＋舊variant測試照留唔剷。
- **卡③a（細）**：h3-prose.ts 加 **聲音設計正式段**（#24三層：低頻bed(天氣)／畫內聲源(道具+腳步,#25)／事件點綴跟動作(#36)）織入identity-long（setting/motion/pin/**sound**/dialogue）；`overall_soundscape:` 由 BANNED_LABELS 解禁（概念自由，line-start真label照禁F2）。**蒙太奇timing ref optional位**：graph `audioTimingRefName`→LoadAudio→H3ReferenceAudio→`ref_audios.ref_audio_1`（<Audio 2>，#31 cuts-land-on-beats句 `TIMING_REF_SENTENCE`）；**audio「恰好一條對白wav」assert原封不動**（冇timing時audio refs≡`ref_audio_0`一條，有test釘死）。
- **卡③b（中）**：A路 **UI photo通道**：graph `uiPhotoNames`→`ref_images.ref_image_N`（LoadImage）；submit `uiPhotoFiles` live上傳＋dry-run名；story shot維持零ref_images（test釘死）。**上屏文字工程**：`buildUiLines`/`validateUiSpec`——case02 Image-N對號mapping表（`<Picture 1>`=UI layout/字體/配色ref＋逐卡`<Picture N>`）＋#34機位鎖＋「只准呢啲郁」白名單＋exact copy逐字（「」引用+位置級+字體weight顏色跟ref）＋case06舊字→新字逐字樣式不變；**≤6詞閘**（ONSCREEN_MAX_WORDS）。UI spec強制identity-long；ui/timing通道b/bkf/c一律reject（fallback凍結求receipt可比對）。
- 收據：`keyframe_positions`入H3SubmitReceipt；uploads加`ui_photos`/`audio_timing`。

## proof
```
cd /mnt/ssd/crew-wt/motion
bun test src/lib/studio/h3-r2v-graph.test.ts src/lib/studio/h3-submit.test.ts src/lib/studio/h3-prose.test.ts
→ 47 pass / 0 fail（13 graph＋6 submit＋28 prose；含「builder deep-equals the H3Keyframes golden fixture」）
commits: fa15ce9（卡①＋③ab通道）→ b2398be（卡②）→ a26479f（卡③ab prose）；全部 lane/motion 字頭、只動自己lane檔案
live probe: GET http://100.127.176.64:8188/object_info/H3Keyframes → required含positions，optional=image_1–6＋images_batch（verify/motion/H3Keyframes.object_info.node1.json）
全套studio測試對比基線：零新fail（doctor/blockout-render/reflector嘅fail係基線已有，屬Ivo/Wire lane＋環境）
```

## 未做咗
- **真燒H3驗證**（卡明文：等Chau）—— specifically：ConditioningCombine兩entry（refs entry＋anchors entry）喺DiT runtime嘅payload合流行為未經真燒證實；core `model_base.py`所見keyframes同refs嘅`cond_video_latents`會per-entry處理，官方example冇r2v+H3Keyframes共存先例，**第一槍係Chau個gate**。
- pipeline餵食：③a timing wav同③b UI photo嘅per-shot數據源（callsheet/UI spec由writer邊定）未接——通道＋機件＋測試已開，接線等callsheet有欄位（開卡俾writer/pipeline，非motion lane）。
- images_batch（多anchor動作釘幀）未接線——語義已寫明，接線等有多anchor來源（blockout抽幀/U1.5多still）先開。
- `bun src/cli.ts` bare跑有基線已有嘅import錯（pipeline.ts `loadBaseCast`，crew合流態）——唔係本卡範圍，未執。
- h3-dry-run-wist.test.ts 本worktree無`data/jobs/SC-0913-WIST`會skip-fail（bun t.skip未實現，基線同樣）；crew-seats行到，斷言已改新node名。

handover: Vera——三commit已上lane/motion，dry-run對拍可以用`submitH3Shot({dryRun:true})`出graph receipt對`workflows/h3-r2v.api.json`。
```
