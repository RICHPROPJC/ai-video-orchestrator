import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { blenderBlockingScript } from "../blender";
import { emit, readJob } from "../store";
import { renderBlockingSvg } from "../painter";
import { ensureDir, jobDir, jobFile } from "../paths";
import { snapDurationToFrames, wavSeconds } from "../frame-grid";
import { GRID_BED_VERSION, layDialogueBed } from "../dialogue-bed";
import { plugShotWavs, plugVoiceEvents } from "../shot-wav-plug";
import { buildCutPlan } from "../cut-plan";
import { writeAnchors } from "../dhash-anchors";
import { assertFiguresVisible, blockoutFromPlug, extractFrame0, renderBlockout, stillFrameFor } from "../blockout";
import { ensurePortraits } from "../portraits";
import { lookupShelf } from "../asset-library";
import { writeStoryWorld, ensureWorldSizes, type WorldPlan } from "../world-assemble";
import { piecesFromCallSheet, resolveScales, type WorldPiece } from "../world-scale";
import { ensurePropBoard, ensureSceneBoard } from "../asset-board";
import { diffPropPlates, nextPropBoardSeq, propAssetId, writePropPinManifest } from "../prop-plate-index";
import { assertStoryPlatesReady, ensureCastOnce } from "../cast-mesh";
import { pinQcAccepted } from "../photo-qc";
import { audioTimelineRows } from "../creative";
import { blockoutPlugGap, gapEvent, gapMessage, motionNeedsHumanGap } from "../capability-gap";
import {
  DECIDER_DEFAULTS,
  MOTION_LIB_ROOT,
  bakeSelectionFrames,
  buildCmuIndex,
  buildShortlist,
  decideSelection,
  legalCandidates,
  parseCombatSweepRanking,
  postureConflict,
  selectMotions,
  verbsForGate,
  writeSelections,
  type MotionShotLine, type MotionSpec } from "../motion-select";
import { sheetDigest } from "../seat-boards";
import type { CallSheet, Shot } from "../types";
import { relInJob } from "../isolate";
import { depStampOf, ffmpeg, mediaSeconds, patch, shotsForScene, type Ctx, stableJson } from "./shared";

async function raster(svg: string, outFile: string) {
  ensureDir(path.dirname(outFile));
  const png = new Resvg(svg, {
    fitTo: { mode: "original" },
    font: {
      loadSystemFonts: true,
      fontFiles: [
        "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
        "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
      ],
    },
  })
    .render()
    .asPng();
  fs.writeFileSync(outFile, png);
}

/** 拆層段（world）：由 runPipeline 原序搬入，行為零變——絕唔重排 call 次序、
 *  絕唔刪／合併任何 emit/speak/patch；early-return 以 ctx.stopped 回報。 */
/** V3.2（PLAN-v2 0928）§9.2：frozen motion spec 衍生——由 callsheet 現有欄
 *  （marks stance/stanceEnd＋combat incoming/outgoing＋envAnim＋props 持有）
 *  組 typed 規格。selection prompt／selection.json／H3 prose 三處同一份。 */
function motionSpecOf(s: Shot): MotionSpec {
  const m0 = s.marks[0];
  const combat = s.combat as { incoming_state?: unknown; outgoing_state?: unknown } | undefined;
  return {
    ...(m0?.stance ? { startStance: String(m0.stance) } : {}),
    ...((m0 as { stanceEnd?: unknown } | undefined)?.stanceEnd ? { endStance: String((m0 as { stanceEnd?: string }).stanceEnd) } : {}),
    ...(s.props?.length ? { contact: s.props.map((pp) => `${pp.name}${pp.heldBy ? `(${pp.heldBy})` : ""}`).join("、") } : {}),
    ...(combat?.incoming_state ? { incoming: String(combat.incoming_state) } : {}),
    ...(combat?.outgoing_state ? { outgoing: String(combat.outgoing_state) } : {}),
    ...(s.envAnim ? { envChange: `${(s.envAnim as { object?: unknown }).object ?? "?"}:${(s.envAnim as { channel?: unknown }).channel ?? "?"}` } : {}),
    durationSec: s.durationSec,
  };
}

export async function worldStage(ctx: Ctx): Promise<void> {
  const { jobId, input, cfg } = ctx;
  const { speak, think } = ctx;
  const trace = ctx.trace;
  const motionSelections = ctx.motionSelections;
  {
    const idxFile = path.join(MOTION_LIB_ROOT, "cmu-mocap/cmu-mocap-index-text.txt");
    if (!fs.existsSync(idxFile)) {
      await speak("layout", "motion-select 跳過：motion library index 唔在盤（workbench 灰模照舊）。", "warn");
    } else if (input.noMotionSelect) {
      await speak("layout", "motion-select 關咗（--no-motion-select）：workbench 灰模照舊。");
    } else if (input.dryRun) {
      await speak("layout", "motion-select 跳過：--dry-run 零 socket（decider call 留畀 live run）。");
    } else {
      await think("layout");
      const idx = buildCmuIndex(MOTION_LIB_ROOT);
      const rankFile = path.join(MOTION_LIB_ROOT, "out/combat_sweep_ranking.txt");
      const rank = fs.existsSync(rankFile)
        ? parseCombatSweepRanking(fs.readFileSync(rankFile, "utf8"))
        : new Map();
      const selShots = shotsForScene(ctx.locked!.shots, input.scene);
      const shortlist = buildShortlist(idx, rank, selShots.map((s) => s.action));
      const lines: MotionShotLine[] = selShots.map((s) => ({
        id: s.id,
        heading: s.heading,
        action: s.action,
        durationSec: s.durationSec,
        gait: s.marks[0]?.gait,
        stance: s.marks[0]?.stance,
        spec: motionSpecOf(s),
      }));
      for (const line of lines) {
        const clash = postureConflict(line);
        if (clash) await speak("layout", clash, "warn");
        if (verbsForGate(line.action).needAny.length > 0 && legalCandidates(shortlist, line.action).length === 0) {
          throw new Error(`${line.id}: 冇合法 motion，GPU 前停`);
        }
      }
      const { rows, calls } = await selectMotions({ shots: lines, shortlist });
      const sels = lines.map((s) =>
        decideSelection(rows.find((r) => r.shot === s.id)!, shortlist, rank, s, null),
      );
      writeSelections(path.join(jobDir(jobId), "motion"), sels, {
        job: jobId,
        one_call: true,
        calls,
        n_candidates: shortlist.nCandidates,
        decider_model: DECIDER_DEFAULTS.model,
      });
      // CAPGAP_0927：needs_human 由死人 flag 變真閘——未有人手接嘅揀片
      // 唔准入 motionSelections（bake map），collect 成 capability gap block 成 job。
      const humanSels = sels.filter((s) => s.needs_human);
      for (const sel of sels) {
        if (!sel.needs_human) motionSelections.set(sel.shot, sel);
      }
      const auto = sels.filter((s) => s.auto).length;
      await speak(
        "layout",
        `motion-select：${calls} 個 decider call 揀齊 ${sels.length} 鏡 → motion/selection.json（${auto} auto${humanSels.length ? `、${humanSels.length} needs_human` : ""}；120候選）。`,
      );
      const humanGap = motionNeedsHumanGap(sels);
      if (humanGap) {
        ctx.job = patch(ctx.job, {
          status: "blocked",
          currentAgent: "layout",
          providers: trace,
          error: gapMessage(humanGap),
        });
        emit(jobId, gapEvent(jobId, humanGap));
        ctx.stopped = true;
        return;
      }
    }
  }

  // portraits before any keyframe: a first appearance needs a face to anchor on
  // --until blockout stops before U1.5/QC — skip the eye (pictureQc may be DOWN)
  const stillDir = path.join(jobDir(jobId), "stills");
  ctx.stillDir = stillDir;
  // V2c（PLAN-v2 0928）§8：portraits 材料指紋——角色定義（wardrobe/palette/
  // 身形）變＝肖像過期。skip 除咗全 GREEN，仲要 stamp 夾；冇 stamp＝
  // provenance-unknown 重行 ensure（ensure 自身有 exists-skip，成本係核對）。
  const portraitsStampFile = path.join(jobDir(jobId), "portraits", ".dep.json");
  const portraitsStampParts = () => depStampOf({ characters: ctx.locked!.characters.map((c) => ({ id: c.id, wardrobe: c.wardrobe, palette: c.palette, heightM: c.heightM })) });
  const portraitsStampOk = () => {
    try {
      return (JSON.parse(fs.readFileSync(portraitsStampFile, "utf8")) as { dep?: string }).dep === portraitsStampParts();
    } catch {
      return false;
    }
  };
  const skipPortraits =
    input.resume && ctx.continuity!.boards.every((shot) => pinQcAccepted(stillDir, shot.id)) && portraitsStampOk();
  let portraits: Awaited<ReturnType<typeof ensurePortraits>>;
  let hopCast: string[] | undefined;
  if (skipPortraits) {
    emit(jobId, {
      agent: "stills",
      level: "info",
      message: "repair: portraits saw ensurePortraits became skip (all stills pinned GREEN on resume)",
    });
    await speak("stills", "肖像跳過：stills 已全 GREEN，肖像唔再守門");
    const portraitDir = path.join(jobDir(jobId), "portraits");
    const files: Record<string, string> = {};
    const sheets: Record<string, string> = {};
    const anglePins: NonNullable<Awaited<ReturnType<typeof ensurePortraits>>["anglePins"]> = {};
    for (const c of ctx.locked!.characters) {
      const angles = path.join(portraitDir, "boards", `${c.id}.angles.png`);
      const front = path.join(portraitDir, `${c.id}.front.cut.png`);
      if (fs.existsSync(angles)) sheets[c.id] = angles;
      if (!fs.existsSync(front)) continue;
      files[c.id] = front;
      anglePins[c.id] = { front };
      for (const angle of ["45", "side", "back"] as const) {
        const cut = path.join(portraitDir, `${c.id}.${angle}.cut.png`);
        if (fs.existsSync(cut)) anglePins[c.id]![angle] = cut;
      }
    }
    portraits = { files, made: [], plugged: [], anglePins, sheets };
  } else {
    await think("stills");
    hopCast = input.scene
      ? [...new Set(shotsForScene(ctx.locked!.shots, input.scene).flatMap((s) => s.marks.map((m) => m.characterId)))]
      : undefined;
    portraits = await ensurePortraits({
      sheet: ctx.locked!,
      outDir: path.join(jobDir(jobId), "portraits"),
      plugDir: input.portraitsDir,
      server: cfg.stills.url,
      seed: cfg.motion.seed,
      onlyIds: hopCast,
      angleBoard: true,
      onEvent: (message, data) => emit(jobId, { agent: "stills", level: "info", message, data }),
    });
    await speak(
      "stills",
      `肖像齊：plug ${portraits.plugged.length}、新做 ${portraits.made.length}${hopCast ? `（hop ${hopCast.join(",")}）` : ""}；角度板釘 ${Object.values(portraits.anglePins ?? {}).reduce((n, m) => n + Object.keys(m).length, 0)} 張 RGBA 角度肖像（{角度}檔入 portraits/）。`,
    );
    // V2c §8：ensure 完成＝肖像同現角色定義對齊，寫材料指紋
    fs.mkdirSync(path.join(jobDir(jobId), "portraits"), { recursive: true });
    fs.writeFileSync(portraitsStampFile, JSON.stringify({ dep: portraitsStampParts(), ts: new Date().toISOString() }, null, 2));
  }
  ctx.portraits = portraits;

  await think("art");
  await speak("art", `Grade: ${ctx.locked!.styleBible.grade}. 只描述已有 ${ctx.continuity!.boards.length} 鏡，唔另開世界。`);
  // 世界米數（g41）：art seat 係 art_direction 真源——sizes.json 缺席時由
  // 阿釉出（character 真身高＋props 實物尺寸，每條帶 source 口徑）。已有檔
  // （手補／上輪 resume）＝唔掂。boards seat 唔做呢件事：charter 話 brief
  // 冇寫唔准估——估唔係 boards 職責，藝術決定先係。
  if (!input.dryRun) {
    const propSeen = new Set<string>();
    const namedProps = ctx.locked!.shots.flatMap((s) => s.props ?? []).filter((p) => {
      if (propSeen.has(p.name)) return false;
      propSeen.add(p.name);
      return true;
    });
    const sizes = await ensureWorldSizes({
      dir: path.join(jobDir(jobId), "world"),
      brief: input.brief?.trim() ? input.brief : ctx.locked!.logline,
      characters: ctx.locked!.characters.map((c) => ({ id: c.id, name: c.name, heightM: c.heightM })),
      props: namedProps.map((p) => ({ name: p.name, ...(p.heldBy ? { heldBy: p.heldBy } : {}) })),
      locations: [...new Set(ctx.locked!.shots.map((s) => s.location).filter((l): l is string => Boolean(l)))],
      io: {
        crew: cfg.crew,
        // art 係細 seat：full glm-5.3 淨係導演席（creative）carve-out 准用
        // （crew-llm deny 閘），呢度行 flash 級。
        model: cfg.crew.boardsModel ?? (() => { throw new Error("boards_model_missing"); })(),
        receiptDir: jobDir(jobId),
        fallbackModel: cfg.crew.secondFallback,
      },
    });
    await speak(
      "art",
      sizes.wrote
        ? `世界米數 ${sizes.count} 件入 world/sizes.json（art_direction 口徑，每條帶 source）。`
        : `世界米數沿用 world/sizes.json（${sizes.count} 件，唔掂）。`,
    );
    // 預檢同 world 段 fatal 閘（planStoryWorld）同一口徑：merge sizes.json 先
    // resolve。唔係嘅話 character 淨得 heightM，piecesFromCallSheet 結構上永遠
    // 報 missing——預檢長期誤報，seats 學會忽略 warn。
    const sizeFile = path.join(jobDir(jobId), "world", "sizes.json");
    const sizeEv = fs.existsSync(sizeFile)
      ? (JSON.parse(fs.readFileSync(sizeFile, "utf8")) as Record<string, { sizeM?: number; source?: string }>)
      : {};
    const preflightPieces = piecesFromCallSheet(ctx.locked!.characters, ctx.locked!.shots).map((p) => ({
      ...p,
      sizeM: p.sizeM ?? sizeEv[p.id]?.sizeM,
      sizeSource: p.sizeSource ?? sizeEv[p.id]?.source,
    }));
    const sized = resolveScales(preflightPieces);
    if ("missing" in sized) {
      await speak("layout", `世界米數未齊，人偶 heightM 唔當米：${sized.missing.join("；")}`, "warn");
    } else {
      await speak("layout", "尺寸齊，先鎖動作，先出圖。");
    }
  }

  await think("layout");
  await speak("layout", "走位只跟分鏡 mark：camera、手 IK、腳 IK。wav 係時鐘。");
  const blenderFile = jobFile(jobId, "blender", "blocking.py");
  fs.writeFileSync(blenderFile, blenderBlockingScript(ctx.locked!));
  const blockingDir = path.join(jobDir(jobId), "blocking");
  ensureDir(blockingDir);
  for (const shot of ctx.continuity!.boards) {
    await raster(renderBlockingSvg(ctx.locked!, shot), path.join(blockingDir, `${shot.id}.png`));
  }

  // voice hop: copy the given SHxx.wav plugs, or AuK speaks the continuity
  // dialogue (clone ref = job --clone upload, else tts.promptWav)
  const gapSec = input.gapSec ?? 0;
  ctx.gapSec = gapSec;
  const audioDir = path.join(jobDir(jobId), "audio");
  ctx.audioDir = audioDir;
  ensureDir(audioDir);
  const cloneRef = input.voiceClonePath && fs.existsSync(input.voiceClonePath) ? input.voiceClonePath : undefined;
  ctx.cloneRef = cloneRef;
  // DIALOGUE_RULE_PROVENANCE_0927：有聲音事件時間線（新 callsheet）行事件
  // 路徑——一句一條連續 take、逐鏡切片；舊 plug callsheet（冇 audioEvents）
  // 照行每鏡一句舊路，位元組行為不變。
  const eventTakes = ctx.locked!.audioEvents?.length
    ? (await plugVoiceEvents({
        boards: ctx.continuity!.boards,
        events: ctx.locked!.audioEvents,
        wavDir: input.wavDir || undefined,
        audioDir,
        cloneRef,
      }))
    : undefined;
  // PROVENANCE_0927 第4點後半：實際音軌時長回填共同時間線——每事件 take
  // 實長對事件窗口（鏡組成）。短過＝bed 照墊；長過＝逐鏡切片會截尾（記
  // overflow 警告，唔靜靜食）。落 creative/audio-timeline.json 俾 producer/
  // 下游讀實際時鐘，唔改窗口（窗口＝callsheet，要改係修訂輪嘅事）。
  if (eventTakes && ctx.locked!.audioEvents) {
    const rows = await audioTimelineRows(ctx.locked!.audioEvents, eventTakes.takes, wavSeconds, ctx.locked!.directorPlacements);
    // 裁決 0928 D：聲畫對位缺口回責任席線——missing placement 逐句 emit
    // （唔阻行：收據落 events；revise_unclosed 已喺上游 fail-loud 把關）
    // §8.1：coverage 收據改用實際音訊切片（plugVoiceEvents slices）——
    // 「邊鏡真係播咗呢句嘅邊段」而唔係 boards 標記推算；onImage 對照收據：
    // 導演指定嘅畫面對象 vs 實際播出鏡嘅 action/cast 文字（詞級 hit 紀錄，
    // 自由文字語義判斷留責任席，呢度只列對照事實）。
    const sliceCover = new Map<string, string[]>();
    // §9①：用當輪 eventTakes.perShot（ctx.plugged 呢刻仲未賦值——首跑空 coverage）
    for (const ps of eventTakes.perShot) {
      for (const sl of ps.slices ?? []) {
        sliceCover.set(sl.beatId, [...(sliceCover.get(sl.beatId) ?? []), ps.shotId]);
      }
    }
    for (const r of rows) {
      r.coveredByShotIds = sliceCover.get(r.beatId) ?? [];
      if (r.placement === "matched" && r.onImage) {
        const coverShots = ctx.locked!.shots.filter((sh) => r.coveredByShotIds!.includes(sh.id));
        const lensText = coverShots.map((sh) => `${sh.action} ${sh.marks.map((mk) => mk.characterId).join(" ")}`).join(" ");
        r.onImageCheck = r.onImage
          .split(/[\s，、,]+/)
          .filter(Boolean)
          .map((w) => ({ word: w, seenInCoverShots: lensText.includes(w) }));
      }
    }
    // §7②：缺口寫 job（resume 攔截強制 revise——emit 之外嘅真回修路徑）
    // §9③：完整 gap 集合＝missing＋unresolved（0→0 唔准避開修訂同 final 閘）
    const missingRows = rows.filter((r) => r.placement === "missing" || r.placement === "unresolved");
    for (const r of missingRows) {
      emit(jobId, { agent: "producer", level: "warn",
        message: `聲畫對位缺口：${r.text.slice(0, 60)} 冇導演落點（resume 時回導演席修訂）`,
        data: { stage: "audio-placement", blocked: null, utterance: r.beatId, text: r.text.slice(0, 120) } });
    }
    // 重算語義：gaps＝今次對照嘅 missing 全集（revise 後已解嘅自然消失）；
    // attempts 跨 resume 繼承（§8.2 修訂額度唔被重算重置）
    // §13.2：額度真源改 job 持久 soundRepairEpisode（§12 text 鍵只救同文重編，
    // 改台詞仍重置——superseded；row attempts＝episode 淺 mirror）。
    // §12 優先2＋§13.3.3：adoption issues 併 placementGaps；§13.2 episode＝額度
    // 真源（row attempts 淺 mirror；唔用文字身份決定額度）。
    const adoptionGapRows = (ctx.locked!.adoptionIssues ?? []).map((issue, i) => ({
      utterance: `adoption:${i}`,
      text: `聲畫採用矛盾：${issue}`,
      ts: new Date().toISOString(),
    }));
    const gapsAll = [
      ...missingRows.map((m) => ({ utterance: m.beatId, text: m.text, ts: new Date().toISOString() })),
      ...adoptionGapRows,
    ];
    let episode = readJob(jobId)?.soundRepairEpisode ?? null;
    if (!gapsAll.length) episode = null;
    else if (!episode) episode = { id: `sr-${Date.now().toString(36)}`, openedAt: new Date().toISOString(), source: gapsAll[0]!.text, attempts: 0 };
    ctx.job = patch(ctx.job, {
      placementGaps: gapsAll.map((g) => ({ ...g, attempts: episode?.attempts ?? 0 })),
      soundRepairEpisode: episode,
    });
    // §8.2：受影響生成阻住——gap 句嘅實際播出鏡 per-shot blocked（V3.1
    // blockedShots 自動入帳；motion loop 見 placement-gap skip 唔燒）
    for (const r of missingRows) {
      for (const shotId of r.coveredByShotIds ?? []) {
        emit(jobId, { agent: "producer", level: "warn",
          message: `${shotId} blocked（placement-gap：${r.text.slice(0, 40)} 冇導演落點）`,
          data: { shot: shotId, stage: "audio-placement", blocked: `placement-gap:${r.beatId}` } });
      }
    }
    // §10.2：audio-placement block 完整生命週期——每輪重算全替換本 stage 原因
    // 集合：已解（唔喺本輪 gap 播出鏡）移除、他 stage 原因保留、未解全在
    // （唔再等同 stage pass event 清——修好即刻解鎖；revision 刪鏡亦自然清走）。
    const openGapShots = new Set(missingRows.flatMap((r) => r.coveredByShotIds ?? []));
    const nowTs = new Date().toISOString();
    // §13.3.3：採用矛盾冇結構化鏡指認——阻依賴該決定嘅範圍（boards→stills
    // 成鏈）：全部鏡 blocked，修好（adoption rows 清）先解鎖。
    const adoptionBlockRows = adoptionGapRows.length
      ? ctx.continuity!.boards.map((b) => ({ shot: b.id, stage: "audio-placement", reason: `adoption-gap:計劃採用矛盾未解（${adoptionGapRows.length} 條，額度內修訂中）`, ts: nowTs }))
      : [];
    const diskRows = readJob(jobId)?.blockedShots ?? [];
    const keptRows = diskRows.filter((b) => b.stage !== "audio-placement");
    ctx.job = patch(ctx.job, {
      blockedShots: [...keptRows,
        ...[...openGapShots].map((shotId) => ({
          shot: shotId,
          stage: "audio-placement",
          reason: `placement-gap:${missingRows.filter((r) => (r.coveredByShotIds ?? []).includes(shotId)).map((r) => r.beatId).join(",")}`,
          ts: nowTs,
        })),
        ...adoptionBlockRows],
    });
    fs.writeFileSync(jobFile(jobId, "creative", "audio-timeline.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      // §7③：採用 revision 收據——呢份 timeline 由邊個 callsheet 生出嚟
      // （cut/mix/mux 同源對照用；revision 唔一致唔可以混做最終交付）
      callsheetDigest: sheetDigest(ctx.locked!),
      note: "實際音軌時長回填（共同時間線）；take 一次生成逐鏡切片，呢度係事件層時鐘",
      events: rows,
    }, null, 2));
    // §9⑥：本輪凍結 expected revision（mux 三比用；行內回修重寫收據時更新）
    ctx.callsheetDigest = sheetDigest(ctx.locked!);
    const overs = rows.filter((r) => r.overflowSec);
    if (overs.length) {
      await speak("voice", `音軌回填：${overs.length} 句 take 長過事件窗口（${overs.map((o) => `${o.beatId}+${o.overflowSec}s`).join("、")}）——切片會截尾，見 creative/audio-timeline.json。`, "warn");
    }
  } else {
    // §10.3：無對白／外來 callsheet 路都寫明示 N/A 收據——本輪 expected
    // revision 嘅建立唔依賴是否有對白；mux 三比全合法路徑有據（N/A 收據同
    // cut_plan 同本輪 digest）。殘留舊 timeline 同時被覆蓋——歷史檔唔會被
    // 誤認成本輪（舊 digest 過唔到三比）。
    // §11①：兩分支共同收口——由有對白方案修訂成合法無對白係狀態轉移，前輪
    // placementGaps/audio-placement rows 呢輪清（唔殘留幽靈 gap 觸發回修或
    // 永久 blocked）；他 stage 未解原因保留。absence 屬必需資料遺失（導演
    // 聲畫路缺 events）嘅分流喺 creative §9③ runtime 判嗰度（events 有 text
    // ＝required 缺全 missing），呢度淨收合法無事件轉移。
    // §13.3.3：issues 收集獨立於有冇音訊事件——無事件分支照收 adoption
    // gaps＋blocked（唔清採用矛盾；placement 類照清）。
    const adoptionGapRows = (ctx.locked!.adoptionIssues ?? []).map((issue, i) => ({
      utterance: `adoption:${i}`,
      text: `聲畫採用矛盾：${issue}`,
      ts: new Date().toISOString(),
    }));
    let episode = readJob(jobId)?.soundRepairEpisode ?? null;
    if (!adoptionGapRows.length) episode = null;
    else if (!episode) episode = { id: `sr-${Date.now().toString(36)}`, openedAt: new Date().toISOString(), source: adoptionGapRows[0]!.text, attempts: 0 };
    const adoptionBlockRows = adoptionGapRows.length
      ? ctx.continuity!.boards.map((b) => ({ shot: b.id, stage: "audio-placement", reason: `adoption-gap:計劃採用矛盾未解（${adoptionGapRows.length} 條，額度內修訂中）`, ts: new Date().toISOString() }))
      : [];
    const diskRows = readJob(jobId)?.blockedShots ?? [];
    ctx.job = patch(ctx.job, {
      placementGaps: adoptionGapRows.map((g) => ({ ...g, attempts: episode?.attempts ?? 0 })),
      soundRepairEpisode: episode,
      blockedShots: [...diskRows.filter((b) => b.stage !== "audio-placement"), ...adoptionBlockRows],
    });
    fs.writeFileSync(jobFile(jobId, "creative", "audio-timeline.json"), JSON.stringify({
      generatedAt: new Date().toISOString(),
      callsheetDigest: sheetDigest(ctx.locked!),
      note: "本 callsheet 冇 audioEvents（無對白／外來音訊時間線）——聲音時間線 N/A 收據；前輪聲畫 gap 已清（§11①）",
      events: [],
    }, null, 2));
    ctx.callsheetDigest = sheetDigest(ctx.locked!);
  }
  const plugged = eventTakes ? eventTakes.perShot : await plugShotWavs({
        boards: ctx.continuity!.boards,
        wavDir: input.wavDir || undefined,
        audioDir,
        cloneRef,
      });
  ctx.plugged = plugged;
  const wavByShot = ctx.wavByShot;
  const h3WavByShot = ctx.h3WavByShot;
  const gapDelivered = ctx.gapDelivered;
  // §10.4：修訂輪已刪 shot 唔留殘收據——本輪三個 maps 淨留本輪 boards keys
  const liveShotIds = new Set(ctx.continuity!.boards.map((b) => b.id));
  for (const k of [...wavByShot.keys()]) if (!liveShotIds.has(k)) wavByShot.delete(k);
  for (const k of [...h3WavByShot.keys()]) if (!liveShotIds.has(k)) h3WavByShot.delete(k);
  for (const k of [...gapDelivered.keys()]) if (!liveShotIds.has(k)) gapDelivered.delete(k);
  const bedRows: { id: string; take: string; story: string; grid: string; storySec: number; gridSec: number }[] = [];
  for (const shot of ctx.continuity!.boards) {
    const dst = plugged.find((p) => p.shotId === shot.id)!.file;
    const take = path.join(audioDir, `${shot.id}.take.wav`);
    fs.copyFileSync(dst, take);
    wavByShot.set(shot.id, dst);
    const frames = snapDurationToFrames(shot.durationSec);
    const gridSec = frames / 24;
    bedRows.push({
      id: shot.id,
      take,
      story: dst,
      grid: path.join(audioDir, `${shot.id}.h3.wav`),
      storySec: shot.durationSec,
      gridSec,
    });
    gapDelivered.set(shot.id, Math.round((gridSec - (await wavSeconds(take))) * 1e4) / 1e4);
  }
  await layDialogueBed({
    segments: bedRows.map((r) => ({ id: r.id, take: r.take, out: r.story, seconds: r.storySec })),
    workDir: path.join(audioDir, "bed-story"),
  });
  // Sol 0926 凍結令：resume 唔重鋪 grid bed（H3 ref_audio）——bed render 非
  // bytes-deterministic，每跑一個樣本 sha 就變（R0/R2 實證），H3 音訊要凍結
  // 同一份 bytes。已有檔＋時長吱一 gridSec 就照用。
  // §11③（supersede 10.4a per-shot h3.json）：layDialogueBed 係全時間線運算
  // （連續 amix＋全序列頭尾 fade）——dirty 子集重鋪會令子集首尾 fade／bed 相
  // 位同完整鏡序唔一致。全軌指紋（有序 shot IDs＋take hashes＋gridSec＋bed
  // 版本）完全一致先凍結重用全部；任一依賴變→完整當輪序列交 layDialogueBed
  // 重建＋更新 track 收據（bed-grid.track.json）。take 生成輸入指紋（clone/
  // src bytes）喺 events textSidecar（§11②）上游收。
  const trackFile = path.join(audioDir, "bed-grid.track.json");
  const curTrackShots = bedRows.map((r) => ({
    id: r.id,
    takeSha: createHash("sha256").update(fs.readFileSync(r.take)).digest("hex"),
    gridSec: r.gridSec,
  }));
  let gridKeepAll = false;
  if (input.resume && fs.existsSync(trackFile)) {
    try {
      const prev = JSON.parse(fs.readFileSync(trackFile, "utf8")) as { bedVersion?: string; shots?: typeof curTrackShots };
      const seqEq = prev.bedVersion === GRID_BED_VERSION && JSON.stringify(prev.shots) === JSON.stringify(curTrackShots);
      const durs = await Promise.all(bedRows.map(async (r) =>
        fs.existsSync(r.grid) && Math.abs((await wavSeconds(r.grid)) - r.gridSec) <= 1 / 48));
      gridKeepAll = seqEq && durs.every(Boolean);
    } catch {
      gridKeepAll = false;
    }
  }
  if (!gridKeepAll) {
    await layDialogueBed({ segments: bedRows.map((r) => ({ id: r.id, take: r.take, out: r.grid, seconds: r.gridSec })), workDir: path.join(audioDir, "bed-grid") });
    fs.writeFileSync(trackFile, JSON.stringify({ bedVersion: GRID_BED_VERSION, shots: curTrackShots, generatedAt: new Date().toISOString() }, null, 2));
  }
  for (const row of bedRows) h3WavByShot.set(row.id, row.grid);
  await speak("voice", "對白留 AuK 原長。底下鋪連續床，只喺成片頭淡入、尾淡出。");
  const spineGiven = input.wavDir ? path.join(input.wavDir, "spine.wav") : undefined;
  const spineWav = spineGiven && fs.existsSync(spineGiven) ? path.join(audioDir, "spine.wav") : undefined;
  ctx.spineWav = spineWav;
  if (spineGiven && spineWav) fs.copyFileSync(spineGiven, spineWav);
  const cutPlan = await buildCutPlan({
    cut: ctx.continuity!.cut,
    wavDir: audioDir,
    gapSec,
    spineWav,
    outFile: jobFile(jobId, "cut_plan.json"),
    lockedSec: Object.fromEntries(ctx.continuity!.boards.map((s) => [s.id, s.durationSec])),
  });
  ctx.cutPlan = cutPlan;
  // h3_clock_s is data for the report (the gate still snaps the ORIGINAL wav)
  const cutPlanFile = jobFile(jobId, "cut_plan.json");
  const cutPlanOnDisk = JSON.parse(fs.readFileSync(cutPlanFile, "utf8")) as { shots: { id: string; h3_clock_s?: number }[] };
  for (const s of cutPlanOnDisk.shots ?? []) {
    const h3 = h3WavByShot.get(s.id);
    if (h3) s.h3_clock_s = Math.round((await wavSeconds(h3)) * 1e4) / 1e4;
  }
  // §7③：cut plan 採用 revision 收據（同 audio-timeline 同源對照）
  fs.writeFileSync(cutPlanFile, JSON.stringify({ ...cutPlanOnDisk, callsheetDigest: sheetDigest(ctx.locked!) }, null, 2));
  const timed: CallSheet = ctx.locked!;
  ctx.timed = timed;

  const sceneBoards = ctx.locked!.buildings ?? [];
  if (!input.dryRun && sceneBoards.length) {
    const assetsDir = path.join(jobDir(jobId), "assets");
    for (const board of sceneBoards) {
      const slug = board.era.trim().replace(/[\s/\\]+/g, "-");
      const manifest = path.join(assetsDir, "scenes", `${slug}.lookdev.json`);
      if (fs.existsSync(manifest)) {
        await speak("layout", `${board.era} 建築板已切，唔重出。`);
        continue;
      }
      const made = await ensureSceneBoard({
        era: board.era,
        types: board.types,
        assetsDir,
        server: cfg.stills.url,
        seed: cfg.motion.seed,
      });
      await speak("layout", `${board.era} 建築板一次出 ${board.types.length} 款再切（${made.cells.length} 格）。`);
    }
  }

  if (!input.dryRun) {
    const assetsDir = path.join(jobDir(jobId), "assets");
    const props = new Map<string, NonNullable<Shot["props"]>[number]>();
    for (const shot of ctx.locked!.shots) {
      for (const prop of shot.props ?? []) {
        const key = propAssetId(prop.name);
        if (!props.has(key)) props.set(key, prop);
      }
    }
    const propMark = path.join(assetsDir, "props.pinned.json");
    let plateDiff = diffPropPlates(assetsDir, propMark, [...props.keys()]);
    if (props.size > 0 && plateDiff.missingIds.length > 0) {
      fs.mkdirSync(assetsDir, { recursive: true });
      const missingProps = plateDiff.missingIds
        .map((id) => props.get(id))
        .filter((prop): prop is NonNullable<typeof prop> => Boolean(prop));
      const madeProps = await ensurePropBoard({
        props: missingProps,
        assetsDir,
        server: cfg.stills.url,
        seed: cfg.motion.seed,
        boardSeqStart: nextPropBoardSeq(assetsDir),
      });
      plateDiff = diffPropPlates(assetsDir, propMark, [...props.keys()]);
      if (plateDiff.missingIds.length > 0) {
        // 0927 停法手術：缺板唔殺 job——warn 照行，世界食到幾多得幾多，
        // 下游 readiness/QC 對實際缺件各自反映。
        await speak("layout", `道具板未補齊：${plateDiff.missingIds.join("、")}——照行（入庫 ${madeProps.pinned.length}），下游各自反映。`, "warn");
      } else {
        await speak("layout", `道具差集補 ${madeProps.pinned.length} 件，已有板唔重出。`);
      }
    }
    if (plateDiff.resolved.length > 0) writePropPinManifest(propMark, plateDiff.manifest);
  }

  let castRigs: Record<string, string> = {};
  if (!input.dryRun && ctx.locked!.characters.length > 0) {
    const assetsDir = path.join(jobDir(jobId), "assets");
    const propMark = path.join(assetsDir, "props.pinned.json");
    const plateDiff = diffPropPlates(assetsDir, propMark, [...new Set(ctx.locked!.shots.flatMap((s) => (s.props ?? []).map((p) => p.name)))]);
    const propPlate = (name: string) => plateDiff.resolved.find((row) => row.assetId === propAssetId(name))?.file;
    const propNames = [...new Set(ctx.locked!.shots.flatMap((s) => (s.props ?? []).map((p) => p.name)))];
    const propPublic = (name: string) => ctx.locked!.shots.flatMap((s) => s.props ?? []).find((p) => p.name === name)?.publicName;
    const fromShelf = (id: string, role: "characters" | "props" | "scenes", own?: string, publicName?: string) => {
      if (own && fs.existsSync(own)) return { file: own };
      const hit = lookupShelf(id, role, undefined, publicName);
      return { file: hit?.plate ?? hit?.rig, rig: hit?.rig };
    };
    const characters = ctx.locked!.characters.map((c) => {
      const got = fromShelf(c.id, "characters", portraits.anglePins?.[c.id]?.front, c.publicName);
      return { id: c.id, pin: got.file, rig: got.rig, deform: "rig" as const };
    });
    const props = propNames.map((name) => {
      const got = fromShelf(name, "props", propPlate(name), propPublic(name));
      const row = plateDiff.resolved.find((item) => item.assetId === propAssetId(name));
      return { name, file: got.file, rig: got.rig, deform: "rigid" as const, meshAliasId: row?.aliasFrom };
    });
    const items = assertStoryPlatesReady({ characters, props }).map((item) => {
      const row = [...characters, ...props].find((entry) => ("id" in entry ? entry.id : entry.name) === item.id);
      return {
        ...item,
        rig: row?.rig,
        deform: row?.deform,
        meshAliasId: row && "meshAliasId" in row ? row.meshAliasId : undefined,
      };
    });
    castRigs = await ensureCastOnce({
      characters: ctx.locked!.characters,
      items,
      meshRoot: path.join(jobDir(jobId), "cast"),
      endpoint: cfg.mesher.endpoint,
      // Chau 0927 拍板：成套片一個窗口——SkinTokens 批量綁晒所有 pending
      // 先返 SF3D（cast-mesh 內置 stop→waitGpu2→rig all→start 返，失敗都拉返）
      allowGpuHandoff: true,
    });
    await speak("layout", `故事元素 ${items.length} 件齊晒。人物先對來源哈希。`);
  }

  // per-shot grey blockout (plug, mocap bake, or the cast rig), frame 0, dHash anchors
  // --scene hop: only render that scene's blockouts (rest wait for their hop)
  let worldPlan: WorldPlan | undefined;
  const worldDir = path.join(jobDir(jobId), "world");
  if (!input.dryRun && Object.keys(castRigs).length) {
    const sizeFile = path.join(worldDir, "sizes.json");
    const sizes = fs.existsSync(sizeFile)
      ? JSON.parse(fs.readFileSync(sizeFile, "utf8")) as Record<string, {
          sizeM?: number; source?: string;
          proportion?: WorldPiece["proportion"];
        }>
      : {};
    const sceneNames = new Set(ctx.locked!.shots.map((s) => s.location).filter(Boolean));
    const pieces: WorldPiece[] = [];
    for (const person of ctx.locked!.characters) {
      const glb = castRigs[person.id];
      const evidence = sizes[person.id] ?? {};
      if (glb) pieces.push({
        id: person.id,
        role: "character",
        glb,
        heightM: person.heightM,
        sizeM: evidence.sizeM,
        sizeSource: evidence.source,
      });
    }
    // A location string never goes to SF3D on its own; but an already-meshed
    // canonical with a succeeded receipt may stand in the world as the
    // support surface (SH04 放蓋上木檯 needs a real tabletop to land on).
    for (const loc of sceneNames) {
      if (castRigs[loc]) continue;
      const canonical = path.join(jobDir(jobId), "cast", loc, "sf3d", "0", "mesh_front.glb");
      const receiptFile = path.join(jobDir(jobId), "cast", loc, "sf3d", "mesh-receipt.json");
      if (!fs.existsSync(canonical) || !fs.existsSync(receiptFile)) continue;
      try {
        const receipt = JSON.parse(fs.readFileSync(receiptFile, "utf8")) as { status?: string };
        if (receipt.status !== "succeeded") continue;
      } catch {
        continue;
      }
      const evidence = sizes[loc] ?? {};
      pieces.push({
        id: loc,
        role: "scene",
        glb: canonical,
        sizeM: evidence.sizeM,
        sizeSource: evidence.source,
      });
    }
    for (const [id, glb] of Object.entries(castRigs)) {
      if (pieces.some((p) => p.id === id)) continue;
      const evidence = sizes[id] ?? {};
      const named = ctx.locked!.shots.flatMap((s) => s.props ?? []).find((p) => p.name === id);
      pieces.push({
        id,
        role: sceneNames.has(id) ? "scene" : "prop",
        glb,
        sizeM: named?.sizeM ?? evidence.sizeM,
        sizeSource: named?.sizeSource ?? evidence.source,
        proportion: named?.proportion ?? evidence.proportion,
        heldBy: named?.heldBy,
      });
    }
    worldPlan = await writeStoryWorld({
      dir: worldDir,
      pieces,
      shots: ctx.locked!.shots.map((s) => ({
        id: s.id,
        lensMm: s.camera.lensMm,
        size: s.size,
        location: s.location,
        heldPropId: s.props?.find((p) => p.heldBy)?.name,
        // 世界暫停前後動作入 worldJson（bake 輸入檔；bake 讀取待 COS patch）
        ...(s.envAnim?.length ? { envAnim: s.envAnim } : {}),
      })),
      blenderBin: cfg.mesher.blender,
    });
    await speak("layout", `一個世界 ${worldPlan.pieces.length} 件，寫入 world/story.blend。`);
  }
  const blockoutDir = path.join(jobDir(jobId), "blockout");
  ctx.blockoutDir = blockoutDir;
  ensureDir(blockoutDir);
  const blockouts: string[] = [];
  const hopBoards = shotsForScene(ctx.continuity!.boards, input.scene);
  if (input.scene) {
    await speak("layout", `--scene ${input.scene} hop：blockout ${hopBoards.length}/${ctx.continuity!.boards.length} 鏡。`);
  }
  // §10.2：placement-gap blocked 鏡（額度耗盡仍缺）唔重 render blockout——
  // 修好後 revision 重算全替換 rows 自然解鎖。磁碟真源（本段喺重算之後）。
  const gapBlockedShots = new Set((readJob(jobId)?.blockedShots ?? []).filter((b) => b.stage === "audio-placement").map((b) => b.shot));
  for (const shot of hopBoards) {
    if (gapBlockedShots.has(shot.id)) continue;
    const outMp4 = path.join(blockoutDir, `${shot.id}.mp4`);
    const frames = snapDurationToFrames(shot.durationSec);
    const sceneStamp = path.join(blockoutDir, `${shot.id}.scene.json`);
    // V2c（PLAN-v2 0928）§8：fingerprint 入 setKey——shot 內容（action／cast
    // 企位姿態／props 持有／durationSec 時間／camera）＋motion 選用變咗，
    // blockout 即過期重 render。舊 sceneStamp 冇呢段＝唔夾＝一次過重 render
    // （新 revision，來源清楚）。
    const shotFingerprint = createHash("sha256")
      .update(stableJson({
        action: shot.action,
        marks: shot.marks,
        props: shot.props ?? null,
        durationSec: shot.durationSec,
        camera: shot.camera,
        size: shot.size,
        motion: motionSelections.get(shot.id) ?? null,
      }))
      .digest("hex")
      .slice(0, 12);
    const setKey = [
      "world-frame",
      Object.keys(castRigs).sort().join("|"),
      String(shot.camera.lensMm),
      shot.size,
      shotFingerprint,
    ].join("|");
    let sceneStamped = false;
    if (fs.existsSync(sceneStamp)) {
      try {
        sceneStamped = (JSON.parse(fs.readFileSync(sceneStamp, "utf8")) as { setKey?: string }).setKey === setKey;
      } catch {
        sceneStamped = false;
      }
    }
    const gotFrames = fs.existsSync(outMp4) ? Math.round((await mediaSeconds(outMp4)) * 24) : 0;
    const kept = input.resume && sceneStamped && gotFrames > 0;
    if (kept) {
      trace.blender = "resume (kept)";
      await speak("layout", `${shot.id} blockout 照舊 ${frames}f，唔重 render。`);
    } else if (input.blockoutDir) {
      const plugged = await blockoutFromPlug(input.blockoutDir, shot.id, h3WavByShot.get(shot.id)!);
      fs.copyFileSync(plugged, outMp4);
      trace.blender = "blockout plug";
      // CAPGAP_0927：plug 係已知工作模式（degraded 唔阻行），但每鏡 emit
      // 一筆 warn 萛 events——呢條片嘅灰模係 plug 唔係真 render。
      emit(jobId, gapEvent(jobId, blockoutPlugGap(shot.id)));
    } else {
      const sel = motionSelections.get(shot.id);
      if (sel?.gap?.remedy === "kf_driven") {
        // 0927 fix ②（motion gap）：手部動作 CMU 六族冇覆蓋——唔 bake 近族
        // clip 假 Video1。gap 落 events 留檔；下游 plan 冇 blockout 自然行
        // A-form KF 驅動（hasVideo1 兩個 call site 同步唔食舊假片）。
        emit(jobId, gapEvent(jobId, { ...sel.gap, shot: shot.id }));
        trace.blender = "kf-driven (motion gap)";
        await speak("layout", `${shot.id} 動作 CMU 冇覆蓋——唔 bake 假 Video1，行 KF 驅動（A-form）。`);
        continue;
      }
      if (sel) {
        // MULTISHOT_WIRE: the selected mocap clip IS the blockout — a grey
        // bake of the real motion, the §5b C-form's Video 1
        const rigId = shot.marks[0]?.characterId ?? "";
        const glb = rigId ? castRigs[rigId] : undefined;
        // 零 cast 鏡（物件特寫：樽內檸檬片／冷凝水）冇 rig 係正常——
        // bakeSelectionFrames 對 glb 係 optional（--glb 有先傳），行
        // glb-less bake（淨 world＋相機）。呢個閘淨係捉「有角色但要 rig」。
        if (!input.dryRun && rigId && !glb) {
          // 0927 停法手術：呢鏡 rig 缺＝blocked skip（per-item 唔殺成隊），
          // 唔郁 GPU；下游 stills 對呢鏡會自行 blocked。
          emit(jobId, {
            agent: "layout", level: "warn",
            message: `${shot.id} blockout rig 缺（${rigId}）——呢鏡 blocked，繼續其他鏡`,
            data: { shot: shot.id, stage: "world", blocked: "rig-missing", rigId },
          });
          continue;
        }
        const aim = worldPlan?.shots.find((s) => s.id === shot.id);
        const worldJson = path.join(worldDir, "assemble.json");
        const { framesDir, frames: baked } = await bakeSelectionFrames(sel, outMp4, {
          ...(glb ? { glb } : {}),
          ...(worldPlan && fs.existsSync(worldJson) ? { worldJson } : {}),
          ...(aim?.lookAtId ? { lookTarget: aim.lookAtId } : {}),
          camera: { lensMm: shot.camera.lensMm, size: shot.size },
        });
        await ffmpeg([
          "-framerate", "60",
          "-i", path.join(framesDir, "frame_%04d.png"),
          // bake renders at 60fps; every other blockout consumer (anchors,
          // resume snap, plug contract) speaks 24fps snapped frames — drop
          // to 24 at the same wall duration
          "-r", "24",
          "-c:v", "libx264", "-pix_fmt", "yuv420p",
          outMp4,
        ]);
        fs.rmSync(framesDir, { recursive: true, force: true });
        trace.blender = `mocap-bake ${sel.bvh} ${baked}f`;
        await speak("layout", `${shot.id} blockout＝motion-select bake ${sel.bvh}（win ${sel.bake.start}+${sel.bake.len} step${sel.bake.step} → ${baked}f@60fps）。`);
        fs.writeFileSync(sceneStamp, JSON.stringify({ setKey, setInFrame: true }) + "\n");
      } else if (input.dryRun) {
        const done = await renderBlockout({
          sheet: timed,
          shot,
          frames,
          outMp4,
        });
        trace.blender = `blender-workbench ${done.frames}f`;
      } else {
        // 0927 停法手術：冇 motion-select＝呢鏡 blocked skip（方塊人偶唔入正片
        // 呢條不變式照守——只係唔再用殺 job 嘅方式守）。
        emit(jobId, {
          agent: "layout", level: "warn",
          message: `blockout_needs_rig: ${shot.id} 冇 motion-select——呢鏡 blocked，繼續其他鏡`,
          data: { shot: shot.id, stage: "world", blocked: "motion-select-missing" },
        });
        continue;
      }
    }
    const f0png = path.join(blockoutDir, `${shot.id}.f0.png`);
    await extractFrame0(outMp4, f0png, stillFrameFor(shot, frames));
    await assertFiguresVisible(f0png, shot);
    await writeAnchors(outMp4, path.join(blockoutDir, `${shot.id}.anchors.json`));
    blockouts.push(outMp4);
    if (!kept) await speak("layout", `${shot.id} blockout ${frames}f（鎖死鏡長）`);
  }
  const worldPng = path.join(blockoutDir, "world.png");
  const firstF0 = hopBoards[0] ? path.join(blockoutDir, `${hopBoards[0].id}.f0.png`) : "";
  if (firstF0 && fs.existsSync(firstF0)) {
    const worldStale = !fs.existsSync(worldPng) || fs.statSync(firstF0).mtimeMs > fs.statSync(worldPng).mtimeMs;
    if (worldStale) fs.copyFileSync(firstF0, worldPng);
  }
  ctx.job = patch(ctx.job, {
    providers: trace,
    progress: 30,
    outputs: {
      ...ctx.job.outputs,
      blenderScript: "blender/blocking.py",
      blockingPreview: "blocking/SH01.png",
      cutPlan: "cut_plan.json",
      blockout: blockouts.map((f) => relInJob(jobId, f)),
    },
  });
  await speak("layout", `cut_plan ${cutPlan.shots.length} 鏡 · gap ${gapSec}s · 走位稿已出。下一席接靜畫。`);
}
