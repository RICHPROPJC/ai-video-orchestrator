# Step B 覆蓋帳——逐席源檔 vs 已遷 vs 剩餘
## SlateLead · 2026-10-02

---

## 席位覆蓋率總覽

| 席 | 源檔 | 源行數 | 源exports | 已遷函數 | 已遷/源 | 覆蓋率 |
|---|---|---|---|---|---|---|
| writer | creative.ts + author.ts + seat-writer.ts | 1456+771+268=2495 | 28+1+2=31 | maxBeatsForSec, dialogueSeconds, totalSceneSec | 3/31 | **~10%** |
| boards | seat-boards.ts + author.ts(boards段) | 441+~200=641 | 7+0=7 | isSizeJump, boardCellCheck | 2/7 | **~29%** |
| art | cast-mesh.ts + asset-board.ts | 476+902=1378 | 10+29=39 | needsRig, isIsolatedRef | 2/39 | **~5%** |
| layout | world.ts + world-scale.ts + motion-select.ts | 1382+~50+1213=2645 | 1+3+38=42 | piecesFromCallSheet, stillFrameFor, verbsForGate | 3/42 | **~7%** |
| stills | stills.ts | 1311 | 4 | stillFirstFlags, refsGreenOnly, sealEditRecord | 3/4 | **~75%** |
| motion | pipeline.ts(:318-790) + h3-submit.ts + h3-prose.ts | ~470+673+578=1721 | ~15 | determineMotionSource, shouldKeepOnResume, motionDepStamp | 3/15 | **~20%** |
| pictureQc | photo-qc.ts + pipeline.ts(:623-690) | 1075+~70=1145 | 35 | computeSliceBounds, motionClipRequire | 2/35 | **~6%** |
| voice | pipeline.ts(:794-855) | ~62 | N/A(inline) | runVoiceLogic | 1/1 | **~100%** |
| soundQc | pipeline.ts(:857-910) | ~54 | N/A(inline) | runSoundQcLogic | 1/1 | **~100%** |
| editor | pipeline.ts(:911-1085) | ~175 | N/A(inline) | concat gate + ffmpeg concat | 部分 | **~40%** |
| delivery | pipeline.ts(:1040-1184) | ~145 | N/A(inline) | runDelivery（concat+receipts+QC report） | 部分 | **~50%** |

## 各席剩餘函數清單

### writer（剩28個）
- creative.ts核心：DIRECTOR_CHARTER, DirectorPlanSchema, directorVisionLine, buildCreativeEnvelope, compileDirectorPlan, dialogueSignalsOf, declaredDialogueOf, normDialogue, claimPlacementOnce, parseTimeEstimate, audioTimelineRows, briefSha, readCreativeManifest, updateCreativeManifest, runDirector, writeCreativeArtifacts, runPlaywright, planDivergence, unplacedDialogueOf, + 9個internal
- seat-writer.ts: runWriter, outline validation
- author.ts: authorStage（整個stage調度）

### boards（剩5個）
- seat-boards.ts: runBoards, sheetDigest, boardsSchemaValidate, boardLaneSelect, boardsRetryLoop

### art（剩37個）
- cast-mesh.ts: ensureCastOnce, sf3dGenerate, glbUpAxis, rigOutput, +6 internal
- asset-board.ts: ensurePropBoard, ensureSceneBoard, keyframeSheetPrompt, liveBoardLane, momentsForShot, chunkMomentSheets, +23 internal

### layout（剩39個）
- world.ts: worldStage（整個stage：cast→mesh→world assemble→blockout bake→motion-select→timing ledger→cut plan）
- motion-select.ts: buildCmuIndex, buildShortlist, decideSelection, selectMotions, bakeSelectionFrames, legalCandidates, postureConflict, parseCombatSweepRanking, msGridFrames, segmentFrameBudget, snapFramesPerShot, writeSelections, adoptSelections, readAdoptedSelections, +24 internal
- world-scale.ts: assertScales, resolveScales

### motion（剩12個）
- pipeline.ts: segment scheduling（motionSegments）, prose構建, H3 submit調用參數組裝, resume判斷, video QC, dep stamp寫入
- h3-prose.ts: buildProse, buildProsePositive, validateProse, wardrobeClauses, SCRIPT_HEADER

### pictureQc（剩33個）
- photo-qc.ts: runPhotoQc, pinQcAccepted, photoQcEyesFromEnv, buildJudgePrompt, NON_PHOTOREAL_RE, DIGITAL_REALISM_RE, +29 internal

---

## 判決

**真實平均覆蓋率：~18%**（唔係「十一席完成」）。voice/soundQc接近100%係因為源碼本來就短。核心複雜席位（layout/art/writer/pictureQc）覆蓋率5-10%——只係提取咗最簡單嘅純函數，大量帶side-effect嘅業務邏輯未搬。
