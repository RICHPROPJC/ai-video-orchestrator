import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { emit, readJob } from "../store";
import { localPictureQc } from "../providers";
import { shouldWaitEarnLock, waitEarnGpuLock } from "../earn-gpu-lock";
import { ensureDir, jobDir, jobFile, projectsDir } from "../paths";
import { isLocationFail, keyframeEditPrompt, keyframeRequire, loadBaseCast, needsShotFacts, sceneRetryNormalize, sceneRetrySchema, sceneRetryUser, textMiss } from "../keyframe-prompt";
import { applyBoardsDecision, forcesRedo, redoFromIndex } from "../shot-redo";
import { runPeStep } from "../pe-step";
import { MAX_IMAGES, type EditPayload, type U15EditRecord } from "../u15-edit";
import { photoQcEyesFromEnv, pinQcAccepted, runPhotoQc, type QcRequire } from "../photo-qc";
import { buildQcSheet, buildQcSheetHtml, readQcReceipt } from "../qc-sheet";
import { ingestStill, queryRefs } from "../memory";
import { appendViolation, checkBoardsToKeyframe, checkKeyframeToStills, hardPhotoQcRow } from "../trace";
import { chunkMomentSheets, keyframeSheetPrompt, liveBoardLane, momentsForShot } from "../asset-board";
import { diffPropPlates, propAssetId } from "../prop-plate-index";
import { runBoards } from "../seat-boards";
import { chatJson, SchemaMismatchError } from "../crew-llm";
import { BOARDS_CHARTER } from "../seat-charters";
import { submitH3Shot } from "../h3-submit";
import { wardrobeClauses } from "../h3-prose";
import { upsertDoc } from "../vault";
import { relInJob } from "../isolate";
import { open, packetLine, seal } from "../dispatch";
import { depStampOf, h3GraphVariant, h3MotionPack, kfRideFor, patch, prevShotOf, shotsForScene, uncutIdentityFiles, writeH3Plan, type Ctx } from "./shared";
import type { Shot } from "../types";

/** T44 §1 (Fable 08:58): `first` means a face the viewer has not seen — the
 *  slate's first shot or a character's first appearance. A size change alone
 *  no longer re-portraits the cast: same faces, same references. */
export function stillFirstFlags(boards: { marks: { characterId: string }[] }[]): boolean[] {
  const seen = new Set<string>();
  return boards.map((board, i) => {
    const newChar = board.marks.some((m) => !seen.has(m.characterId));
    for (const m of board.marks) seen.add(m.characterId);
    return i === 0 || newChar;
  });
}

/** T44 §4 (Fable 08:58), one law for every /edit ref: a file may feed
 *  Image-2+ only with its own hash-matched GREEN photo_qc — portraits and
 *  prior stills alike. Rejected candidates come back for a ref_rejected
 *  event; the f0 base keeps its own blockout gate (assertFiguresVisible):
 *  it is Image-1, never a ref. */
export function refsGreenOnly(candidates: string[]): { kept: string[]; rejected: string[] } {
  const kept: string[] = [];
  const rejected: string[] = [];
  for (const file of candidates) {
    const dir = path.dirname(file);
    const id = path.basename(file, path.extname(file));
    (pinQcAccepted(dir, id) ? kept : rejected).push(file);
  }
  return { kept, rejected };
}

/** T36 law, both stills /edit records go through here: base／refs land in the
 *  JSON as bare filenames — zero absolute paths inside job records — and the
 *  prompt is whatever 阿圖's packet said, verbatim. */
export function sealEditRecord(
  inputs: { prompt: string; first: boolean; base: string; refs: string[] },
  payload: EditPayload,
): Pick<U15EditRecord, "ts" | "prompt" | "img_cfg" | "cfg" | "steps" | "use_edit_pe" | "width" | "height" | "first" | "base" | "refs"> {
  return {
    ts: new Date().toISOString(),
    prompt: payload.prompt,
    img_cfg: payload.img_cfg_scale,
    cfg: payload.cfg_scale,
    steps: payload.num_steps,
    use_edit_pe: payload.use_edit_pe,
    width: payload.width,
    height: payload.height,
    first: inputs.first,
    base: path.basename(inputs.base),
    refs: inputs.refs.map((f) => path.basename(f)),
  };
}

/** 拆層段（stills）：由 runPipeline 原序搬入，行為零變——絕唔重排 call 次序、
 *  絕唔刪／合併任何 emit/speak/patch；early-return 以 ctx.stopped 回報。 */
export async function stillsStage(ctx: Ctx): Promise<void> {
  const { jobId, input, cfg } = ctx;
  const { speak, think } = ctx;
  const trace = ctx.trace;
  // stills lane prompts + require (built in both live and dry run)
  ensureDir(ctx.stillDir!);
  // T44 §1: `first` tracks unseen faces only — a size change no longer
  // re-ctx.portraits! a cast the viewer already knows
  const firstFlags = stillFirstFlags(ctx.continuity!.boards);
  // --scene hop composes only its own shots: an out-of-scene prompt_too_thin
  // throw must not fail the hop (WR1Q SC01 died on SH06)
  let planBoards = input.scene ? shotsForScene(ctx.continuity!.boards, input.scene) : ctx.continuity!.boards;
  // §10.2：placement-gap blocked 鏡（修訂額度耗盡仍缺）唔燒 stills——同 motion
  // loop 同款 skip；blocked 真源＝磁碟（world 重算全替換 audio-placement rows）。
  const gapBlockedShots = new Set((readJob(jobId)?.blockedShots ?? []).filter((b) => b.stage === "audio-placement").map((b) => b.shot));
  if (gapBlockedShots.size) planBoards = planBoards.filter((b) => !gapBlockedShots.has(b.id));
  const baseCast = ctx.job.drama ? loadBaseCast(projectsDir(), ctx.job.drama) : undefined;
  // Two PE routes, before /edit. Web search on: wigolo → nex, qwen38 backup,
  // facts land in the packet. Web search off: 6.8 rewrites the shot, no wigolo.
  // Already-pinned stills skip both. Dry-run never POSTs.
  const peRenders = new Map<string, string>();
  if (!input.dryRun) {
    const peContext = `${ctx.timed!.title}｜${ctx.timed!.location}｜${ctx.timed!.timeOfDay}｜${ctx.timed!.mood}｜風格 grade：${ctx.timed!.styleBible.grade}`;
    for (const boardShot of planBoards) {
      if (input.only && boardShot.id !== input.only) continue;
      const shot = ctx.timed!.shots.find((s) => s.id === boardShot.id)!;
      if (pinQcAccepted(ctx.stillDir!, shot.id)) continue;
      const started = Date.now();
      const webSearch = needsShotFacts(shot) && !(shot.require?.facts?.length);
      if (!webSearch && !needsShotFacts(shot)) {
        const res = await runPeStep({
          shotId: shot.id,
          action: shot.action,
          context: peContext,
          config: cfg.pe,
          webSearch: false,
          receiptFile: path.join(ctx.stillDir!, `${shot.id}.pe_rewrite.json`),
        });
        peRenders.set(shot.id, res.render);
        await speak("stills", `${shot.id} PE 簡單改寫（${res.brain}，冇上網，${Date.now() - started}ms）。`);
        continue;
      }
      if (!webSearch) continue;
      const res = await runPeStep({
        shotId: shot.id,
        action: shot.action,
        context: peContext,
        config: cfg.pe,
        webSearch: true,
        receiptFile: path.join(ctx.stillDir!, `${shot.id}.pe_step.json`),
      });
      shot.require = { ...shot.require, facts: res.facts };
      peRenders.set(shot.id, res.render);
      await speak("stills", `${shot.id} PE 上網搜證：wigolo＋${res.brain} 出 ${res.facts.length} 條 facts（${res.wigoloMs}ms 搜證，${Date.now() - started}ms 全程）。`);
    }
  }
  const stillPlans = planBoards.map((boardShot) => {
    const shot = ctx.timed!.shots.find((s) => s.id === boardShot.id)!;
    const first = firstFlags[ctx.continuity!.boards.indexOf(boardShot)]!;
    const prompt = keyframeEditPrompt(ctx.timed!, shot, { first, ...(baseCast ? { cast: baseCast } : {}) });
    const peRender = peRenders.get(shot.id);
    const editPrompt = peRender ? `${prompt}\n\n【螢幕畫面 Render】\n${peRender}` : prompt;
    const require = keyframeRequire(shot);
    // D1a trace: soft edge invariants (boards→keyframe, keyframe→stills),
    // written for pass and fail alike, always before any QC gate can fail
    const softRows = [...checkBoardsToKeyframe(ctx.timed!.characters, shot, editPrompt), ...checkKeyframeToStills(shot, require)];
    for (const row of softRows) appendViolation(jobDir(jobId), row);
    fs.writeFileSync(path.join(ctx.stillDir!, `${shot.id}.require.json`), JSON.stringify(require, null, 2));
    return { shot, first, prompt: editPrompt, require };
  });
  ctx.stillPlans = stillPlans;

  if (input.dryRun) {
    const variant = h3GraphVariant(input);
    const receipts: string[] = [];
    for (const { shot } of stillPlans) {
      // --only/--scene 同 live 路徑同款過濾：dry-run 驗嘅範圍要同真提交一致
      if (input.only && shot.id !== input.only) continue;
      if (input.scene && shot.scene !== input.scene && !(shot.beatId ?? "").startsWith(`${input.scene}.`)) continue;
      try {
      const stillPng = path.join(ctx.stillDir!, `${shot.id}.png`);
      const prev = prevShotOf(ctx.timed!, shot);
      const blockoutMp4 = path.join(ctx.blockoutDir!, `${shot.id}.mp4`);
      // §5b routing field: the Video 1 asset on disk decides the form
      // 0927 fix ②：motion gap（kf_driven）嘅鏡唔食 blockout——舊跑留低嘅
      // 假 bake 都唔用，hasVideo1=false 行 A-form KF 驅動。
      const hasVideo1 = fs.existsSync(blockoutMp4) && ctx.motionSelections.get(shot.id)?.gap?.remedy !== "kf_driven";
      const { positions, cutFiles } = kfRideFor(jobId, ctx.timed!, shot, ctx.stillDir!);
      const rideCuts = Boolean(positions) && cutFiles.length > 0;
      const pack = h3MotionPack(ctx.timed!, shot, variant, stillPng, ctx.portraits!.files, prev, {
        hasVideo1,
        portraitDir: path.join(jobDir(jobId), "portraits"),
        plugDir: input.portraitsDir,
        sheets: ctx.portraits!.sheets,
        ...(rideCuts && hasVideo1 ? { cformStillRef: cutFiles[0] } : {}),
      });
      writeH3Plan(jobId, ctx.timed!, shot, {
        wav: ctx.h3WavByShot.get(shot.id)!,
        blockout: hasVideo1 ? blockoutMp4 : undefined,
        still: stillPng,
        kfStart: rideCuts ? cutFiles[0] : (hasVideo1 ? undefined : stillPng),
        kfEnd: rideCuts ? cutFiles[1] : pack.kfEnd,
        refImageFiles: pack.refImageFiles,
        anglePortraits: pack.anglePortraits,
      });
      const { receiptFile } = await submitH3Shot({
        prose: pack.prose,
        wavFile: ctx.h3WavByShot.get(shot.id)!,
        durationSec: shot.durationSec,
        blockoutMp4: hasVideo1 ? blockoutMp4 : undefined,
        keyframePositions: rideCuts ? positions : undefined,
        kfStart: rideCuts ? cutFiles[0] : (hasVideo1 ? undefined : stillPng),
        kfEnd: rideCuts ? cutFiles[1] : pack.kfEnd,
        kfExtraFiles: rideCuts ? cutFiles.slice(2) : undefined,
        refImageFiles: pack.refImageFiles,
        uiPhotoFiles: pack.uiPhotoFiles,
        outMp4: path.join(jobDir(jobId), "motion", `${shot.id}.mp4`),
        receiptJson: jobFile(jobId, "motion", `${shot.id}.h3_submit_dryrun.json`),
        dryRun: true,
        shot: shot.id,
        requireQuote: Boolean(shot.dialogue.trim()),
        wardrobe: wardrobeClauses(ctx.timed!),
        aspect: ctx.timed!.aspect,
        graphVariant: variant,
        stepsOverride: input.steps,
      });
      receipts.push(relInJob(jobId, receiptFile));
      } catch (err) {
        // 0927 停法手術（照 motion loop c9b11b1 同款）：呢鏡材料缺＝blocked skip，
        // 繼續其他鏡；基建錯照拸。dry-run 係驗收收據，一鏡缺件唔殺成個 dry-run。
        const msg = err instanceof Error ? err.message : String(err);
        const materialMissing = /photo_qc 未 GREEN|keyframe_positions_missing|identity_sheet_missing|C-form 冇|angle_portrait_missing|身份成張未齊|multishot段要一張未切成張/.test(msg);
        if (!materialMissing) throw err;
        emit(jobId, {
          agent: "motion", level: "warn",
          message: `${shot.id} blocked（${msg}）——dry-run 繼續其他鏡`,
          data: { shot: shot.id, stage: "motion", blocked: msg },
        });
        continue;
      }
    }
    ctx.job = patch(ctx.job, {
      status: "dry-run",
      progress: 55,
      currentAgent: "motion",
      providers: trace,
      outputs: { ...ctx.job.outputs, receipts },
    });
    emit(jobId, {
      agent: "motion",
      level: "warn",
      message: `dry-run：${receipts.length} 份 H3 receipt 已出，冇 POST 過任何機。`,
    });
    ctx.stopped = true;
    return;
  }

  // stills: U1.5 /edit on node0 (fail-loud — any throw fails the job)
  const stills = ctx.stills;
  const toStills = seal({
    slate: jobId,
    from: "boards",
    to: "stills",
    payload: { boards: ctx.continuity!.boards },
  });
  await think("stills");
  const stillWork = open(toStills, { slate: jobId, to: "stills" });
  await speak("stills", packetLine(toStills));
  await speak("stills", `U1.5 用起好嘅 Blender 世界生出呢排分鏡再切。世界圖唔係鍵格。`);
  const hopStillIds = new Set(shotsForScene(ctx.timed!.shots, input.scene).map((s) => s.id));
  const hopStillPlans = (input.scene ? stillPlans.filter((p) => hopStillIds.has(p.shot.id)) : stillPlans)
    .filter((p) => !input.only || p.shot.id === input.only);
  if (input.scene) {
    await speak("stills", `--scene ${input.scene} hop：stills/QC ${hopStillPlans.length}/${stillPlans.length} 鏡。`);
  }
  const hopIds = hopStillPlans.map((p) => p.shot.id);
  if (input.shot) {
    redoFromIndex(hopIds, input.shot);
    await speak("stills", `--shot ${input.shot}：由呢鏡同後面受影響嘅鏡重出，前面 GREEN 保留。`);
  }
  const commitBoards = (next: Shot) => {
    const i = ctx.timed!.shots.findIndex((s) => s.id === next.id);
    if (i >= 0) ctx.timed!.shots[i] = next;
    const req = keyframeRequire(next);
    fs.writeFileSync(path.join(ctx.stillDir!, `${next.id}.require.json`), JSON.stringify(req, null, 2));
    fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(ctx.timed!, null, 2));
    const plan = hopStillPlans.find((p) => p.shot.id === next.id);
    if (plan) {
      plan.shot = next;
      plan.require = req;
    }
    return req;
  };
  let prevKeyframe: string | null = null;
  const editInputs = new Map<string, { prompt: string; nodePaths: string[]; base: string; refs: string[]; first: boolean }>();
  await think("pictureQc");
  await speak("pictureQc", "Qwen 27B 盲測：人數、灰模、物件。每鏡 /edit 完即判（bug4），GREEN pin 先准做下鏡 Image-2。");
  // T39: earn out-earns us on this U1.5/H3 pair — before the first /edit
  // (and everything downstream) wait on earn's lock; dry-run and
  // boards/blockout runs never POST the pair, so they never wait
  if (shouldWaitEarnLock(input)) {
    await waitEarnGpuLock({
      speak: () => speak("stills", "earn GPU lock，等", "warn"),
    });
  }
  // V2c（PLAN-v2 0928）§8：still 材料指紋——呢鏡 GREEN png 綁住生成佢嘅材料
  // （shot 內容／first／identity refs 檔案 bytes／prompt 頭）。材料變＝指紋變
  // ＝resume 唔 keep 呢張 GREEN（重出），防止「改咗 shot／換咗肖像但舊 GREEN
  // 照食」。prompt 淨取頭 256 字：PE facts 段唔入指紋（事實更新唔當材料變）。
  const stillDepStamp = (shotId: string, first: boolean, prompt: string): string | null => {
    const shot = ctx.timed!.shots.find((x) => x.id === shotId);
    if (!shot) return null;
    const refs = editInputs.get(shotId)?.refs ?? [];
    const refHashes = refs
      .map((f) => { try { return createHash("sha256").update(fs.readFileSync(f)).digest("hex").slice(0, 12); } catch { return "missing"; } })
      .sort();
    return depStampOf({ shot: { action: shot.action, marks: shot.marks, props: shot.props ?? null, durationSec: shot.durationSec, camera: shot.camera, size: shot.size }, first, refHashes, promptHead: prompt.slice(0, 256) });
  };
  const stillStampFile = (shotId: string) => path.join(ctx.stillDir!, `${shotId}.dep.json`);
  const stillStampOk = (shotId: string, first: boolean, prompt: string): boolean => {
    try {
      const prev = JSON.parse(fs.readFileSync(stillStampFile(shotId), "utf8")) as { dep?: string };
      const now = stillDepStamp(shotId, first, prompt);
      return Boolean(now) && prev.dep === now;
    } catch {
      return false; // 冇 stamp＝provenance-unknown：唔 keep，重出一次寫 stamp
    }
  };
  const writeStillStamp = (shotId: string, first: boolean, prompt: string): void => {
    const dep = stillDepStamp(shotId, first, prompt);
    if (dep) fs.writeFileSync(stillStampFile(shotId), JSON.stringify({ dep, ts: new Date().toISOString() }, null, 2));
  };

  // T44 §4: the one ref_rejected event shape for every gate below
  const refRejected = (shotId: string, file: string) =>
    emit(jobId, {
      agent: "stills",
      level: "warn",
      message: `ref_rejected ${path.basename(file)}（photo_qc 非 GREEN，唔准入 /edit refs）`,
      data: {
        shot: shotId, stage: "stills", eye: "stills", verdict: "ref_rejected",
        file: path.basename(file), reason: "photo_qc not GREEN",
      },
      step_id: "keyframe-prompt",
      parent_steps: ["boards"],
      seat: "stills",
    });
  // T37 眼板: every shot gets stills/SHxx.qc-sheet.png + one SCxx.qc-sheet.html.
  // Built from the receipt (fresh or resumed), never an LLM, no absolute paths.
  const qcSheetRows: { shotId: string; status: string; failReasons: string[]; sheetBasename: string }[] = [];
  const buildShotSheet = async (shotId: string, require_: QcRequire, prompt: string) => {
    try {
      const receipt = readQcReceipt(path.join(ctx.stillDir!, `${shotId}.photo_qc.json`));
      const f0File = path.join(ctx.blockoutDir!, `${shotId}.f0.png`);
      await buildQcSheet(
        {
          shotId,
          f0File: fs.existsSync(f0File) ? f0File : path.join(ctx.stillDir!, `${shotId}.png`),
          stillFile: path.join(ctx.stillDir!, `${shotId}.png`),
          status: receipt.status,
          failReasons: receipt.failReasons,
          requireLocation: require_.location,
          blind: receipt.blind,
          prompt,
        },
        path.join(ctx.stillDir!, `${shotId}.qc-sheet.png`),
      );
      qcSheetRows.push({
        shotId,
        status: receipt.status,
        failReasons: receipt.failReasons,
        sheetBasename: `${shotId}.qc-sheet.png`,
      });
    } catch (error) {
      await speak("pictureQc", `${shotId} qc-sheet 出唔到（${error instanceof Error ? error.message : error}）— QC 本身唔受影響。`, "warn");
    }
  };
  const writeSceneSheetHtml = () => {
    if (qcSheetRows.length === 0) return;
    try {
      buildQcSheetHtml(qcSheetRows, path.join(ctx.stillDir!, `${jobId}.qc-sheet.html`));
    } catch (error) {
      void (error instanceof Error ? error.message : error);
    }
  };

  const sheetLane = liveBoardLane(cfg.stills.url);
  const shotCells = new Map<string, string[]>();
  const qcFail = (shotId: string) => {
    const qcVerdictJson = path.join(ctx.stillDir!, `${shotId}.photo_qc.json`);
    if (!fs.existsSync(qcVerdictJson)) return false;
    try {
      return (JSON.parse(fs.readFileSync(qcVerdictJson, "utf8")) as { status?: string }).status === "FAIL";
    } catch {
      return false;
    }
  };
  const needsFreshSheet = (shotId: string) => {
    if (forcesRedo(hopIds, shotId, input.shot)) return true;
    if (input.resume && pinQcAccepted(ctx.stillDir!, shotId)) return false;
    const png = path.join(ctx.stillDir!, `${shotId}.png`);
    if (input.resume && !qcFail(shotId) && fs.existsSync(png) && fs.statSync(png).size >= 8_000) return false;
    return true;
  };
  // Every shot owes its real U1.5 anchors: momentsForShot splits the action
  // clauses into per-beat cells, so a mark-less shot still gets its board.
  // (The old "2+ pre-written marks" gate left fresh callsheets with no cells,
  // which the per-shot loop below rejects as 鍵格板未切出.)
  const keyframePlans = hopStillPlans.filter((p) => needsFreshSheet(p.shot.id));
  const sheets = chunkMomentSheets(
    keyframePlans.map((p) => momentsForShot(p.shot, ctx.stillDir!)),
  );
  for (const [si, moments] of sheets.entries()) {
    const identity = [...new Set([...new Set(moments.map((m) => m.shotId))].flatMap((id) => {
      const shot = hopStillPlans.find((p) => p.shot.id === id)!.shot;
      return uncutIdentityFiles(shot, ctx.portraits!.sheets, [path.join(jobDir(jobId), "portraits"), input.portraitsDir ?? ""]);
    }))];
    if (identity.length > MAX_IMAGES) throw new Error("boards: identity sheets exceed U1.5 image capacity; split the board");
    // 素材管事實（SAMPLES40 ①）：道具外形由 GREEN plate 以圖入 ref 照抄，文字
    // 唔再重新發明（杯/雙手/構圖漂移嘅結構病根——只餵 identity 一張圖，個樽
    // 靠文字次次作新）。文字留返姿勢同狀態（單右手/開咗蓋）。
    const sheetPropIds = [...new Set(moments.flatMap((m) => {
      const sh = hopStillPlans.find((p) => p.shot.id === m.shotId)!.shot;
      return (sh.props ?? []).map((pp) => propAssetId(pp.name));
    }))];
    const propRefs = sheetPropIds.length
      ? diffPropPlates(path.join(jobDir(jobId), "assets"), path.join(jobDir(jobId), "assets", "props.pinned.json"), sheetPropIds)
        .resolved.map((r) => r.file).filter((f) => fs.existsSync(f))
      : [];
    // R18（root 0928）：同 asset **GREEN cut 版**附加做第二道具 ref（比較實驗
    // 差異——refs/attempt hashes 留 receipt；pinned manifest qcFile 同源）；冇
    // cut 收據（舊款）淨 plate 照舊，唔靜靚加未驗圖。
    const propCutRefs: string[] = [];
    if (sheetPropIds.length) {
      try {
        const pinned = JSON.parse(fs.readFileSync(path.join(jobDir(jobId), "assets", "props.pinned.json"), "utf8")) as { assets?: { assetId?: string; qcFile?: string; qcStatus?: string }[] };
        for (const a of pinned.assets ?? []) {
          if (!a.assetId || !sheetPropIds.includes(a.assetId) || a.qcStatus !== "GREEN" || !a.qcFile) continue;
          const cut = a.qcFile.replace(/\.photo_qc\.json$/, ".cut.png");
          if (fs.existsSync(cut)) propCutRefs.push(cut);
        }
      } catch { /* 壞 manifest＝淨 plate 照舊 */ }
    }
    const leadId = moments[0]!.shotId;
    // 單格板改餵單張正面肖像：4 格角度板做 ref 會令 U1.5 抄埋版式（board_layout
    // asked 1 columns picture has 4 實證）；多格板先需要角度板。
    if (moments.length === 1) {
      const oneShot = hopStillPlans.find((p) => p.shot.id === leadId)!.shot;
      for (const cid of new Set(oneShot.marks.map((m) => m.characterId))) {
        const single = ctx.portraits!.files[cid];
        if (single && fs.existsSync(single)) {
          const at = identity.findIndex((f) => f.includes(`${cid}.angles`));
          if (at >= 0) identity[at] = single;
        }
      }
    }
    // 官方樣本⑥身份鎖遞進：非首鏡有上一鏡 GREEN 劇照就以佢做 Image-1 畫面基礎
    // （同一人同一場同一道具由佢續接），道具外形漂移嘅最後一道鎖。
    const leadIdx = hopStillPlans.findIndex((p) => p.shot.id === leadId);
    const prevId = leadIdx > 0 ? hopStillPlans[leadIdx - 1]!.shot.id : "";
    // sheet 階段 per-shot QC json 未寫——boards-visual 對 GREEN cell 先 copy 落
    // destination（stills/<id>.png），所以「劇照存在」已係 GREEN 意義。
    const prevStill = prevId && fs.existsSync(path.join(ctx.stillDir!, `${prevId}.png`)) ? path.join(ctx.stillDir!, `${prevId}.png`) : "";
    const baseStill = prevStill && fs.existsSync(prevStill) ? [prevStill] : [];
    // 0917 法（C4 #41）：U1.5 still 三參考位，Image-1＝Blender 企位圖——灰模
    // f0 管人物位置/構圖/鏡位，外觀永遠唔參考（灰模永遠唔做出品外觀位）。
    // 冇 blockout 嘅鏡（motion gap 行 KF 驅動／零 cast 現象鏡）冇 f0，照舊。
    const leadF0 = path.join(ctx.blockoutDir!, `${leadId}.f0.png`);
    const greyLayout = fs.existsSync(leadF0) ? [leadF0] : [];
    const images = [...greyLayout, ...baseStill, ...identity, ...propRefs, ...propCutRefs];
    if (images.length > MAX_IMAGES) throw new Error("boards: still+identity+prop refs exceed U1.5 image capacity; split the board");
    // 非位置描述（GPT-6 覆核）：repairBoard prepend 會改變圖序——角色按「係咩」
    // 講，唔按「第幾張」講，prepend 後唔會錯號。
    // R18：本 sheet 首鏡 tool/tool_shape（正面句材料）——真源＝
    // stills/<id>.require.json（QcRequire 落盤檔；ShotRequire type 冇 tool 欄）
    let leadRequireTool: { name: string; shapes: string[] } | null = null;
    try {
      const rq = JSON.parse(fs.readFileSync(path.join(ctx.stillDir!, `${leadId}.require.json`), "utf8")) as { tool?: string; tool_shape?: string[] };
      if (rq.tool) leadRequireTool = { name: rq.tool, shapes: rq.tool_shape ?? [] };
    } catch { /* 冇 require 檔＝冇 tool 句 */ }
    const refNote = [
      ...(greyLayout.length ? ["灰模企位圖＝人物位置、構圖、鏡位照佢；外觀（人樣/衫/道具look）永遠唔參考佢"] : []),
      ...(baseStill.length ? ["上一鏡劇照（同場同一人同一道具嗰張）＝畫面續接基礎"] : []),
      ...(identity.length ? ["角色肖像／角度板＝同一人，跨格一致"] : []),
      ...(propRefs.length ? [
        `道具實物照＝該道具嘅外形、顏色、質感、比例照抄，文字唔取代`,
        // R18：require 驅動材質/形狀正面句（當集 tool_shape 詞直列——正面
        // 寫法，唔 negative token；KF-01 分項死因「杯/材質未提及」對症）
        ...(leadRequireTool ? [`${leadRequireTool.name}：${leadRequireTool.shapes.join("、")}——呢啲形狀/材質特徵必須畫得出嚟`] : []),
      ] : []),
    ].join("；") + "。";
    const bumpFile = path.join(ctx.stillDir!, `${leadId}.seedbump`);
    let bump = 0;
    if (qcFail(leadId)) {
      bump = (fs.existsSync(bumpFile) ? Number(fs.readFileSync(bumpFile, "utf8")) || 0 : 0) + 1;
      fs.writeFileSync(bumpFile, String(bump));
    }
    await runBoards({ render: {
      moments,
      boardsDir: path.join(ctx.stillDir!, "boards"),
      name: `keyframes-${String(si + 1).padStart(2, "0")}`,
      refNote,
      images,
      lane: sheetLane,
      seed: cfg.motion.seed + bump * 10,
      receiptDir: path.join(jobDir(jobId), "seats", "boards"),
      require: Object.fromEntries(hopStillPlans.map((p) => [p.shot.id, p.require])),
    } });
    for (const m of moments) {
      const list = shotCells.get(m.shotId) ?? [];
      list.push(m.file);
      shotCells.set(m.shotId, list);
    }
    for (const shotId of new Set(moments.map((m) => m.shotId))) {
      const shot = hopStillPlans.find((p) => p.shot.id === shotId)?.shot;
      const group = moments.filter((m) => m.shotId === shotId);
      if (!shot || shot.keyframePositions?.trim()) continue;
      if (group.length < 2) continue;
      shot.keyframePositions = group
        .map((m, i) => m.at || `${Math.round((i / (group.length - 1)) * 100)}%`)
        .join(", ");
    }
    await speak("stills", `鍵格板 ${si + 1}：一次出 ${moments.length} 格再切。`);
  }

  for (const { shot, first, prompt, require } of hopStillPlans) {
    const out = path.join(ctx.stillDir!, `${shot.id}.png`);
    const recordJson = path.join(ctx.stillDir!, `${shot.id}.u15_edit.json`);
    const base = path.join(ctx.blockoutDir!, `${shot.id}.f0.png`);
    const refIds = [...new Set(shot.marks.map((m) => m.characterId))];
    // T44 §5/R5: memory refs rank by real WeMM cosine against the previous
    // keyframe — no query file (first shot) or a down embed eye means no
    // memory refs this pass; the GREEN gate below still vets what returns
    const memHits = !first && prevKeyframe && cfg.embed.endpoint.trim()
      ? await queryRefs(ctx.job.slate, {
          queryFile: prevKeyframe,
          characters: refIds,
          scene: shot.location || ctx.timed!.location,
          k: 3,
        }).catch(async (error: unknown) => {
          await speak("stills", `WeMM 拒收，唔入參考：${error instanceof Error ? error.message : error}`, "warn");
          return [];
        })
      : [];
    emit(jobId, {
      agent: "stills",
      level: "info",
      message: `${shot.id} memory ${memHits.length} hits${memHits.length ? "" : " — no prior stills"}`,
      data: {
        shot: shot.id,
        stage: "memory",
        eye: "memory",
        verdict: memHits.length ? "pass" : "info",
        memoryHits: memHits,
        reason: memHits.length ? "character/scene stills" : "no prior stills",
      },
    });
    // a hash-matched GREEN keyframe is finished work; resume chains from it
    if (input.resume && pinQcAccepted(ctx.stillDir!, shot.id) && !forcesRedo(hopIds, shot.id, input.shot) && stillStampOk(shot.id, first, prompt)) {
      prevKeyframe = out;
      stills.push(out);
      await speak("stills", `${shot.id} keyframe 照舊（QC 已 GREEN＋材料指紋夾），唔重出。`);
      continue;
    }
    // resume：已有 png 但未 QC — 照用，唔重 /edit（唔再 scp node0）。
    // T44 §3：FAIL 唔算未 QC — FAIL png 要重行 /edit；T35b PASS_WITH_WARN
    // 照舊照用（warn-pass 係出貨態，唔係 FAIL）
    const qcVerdictJson = path.join(ctx.stillDir!, `${shot.id}.photo_qc.json`);
    const qcSaysFail = (() => {
      if (!fs.existsSync(qcVerdictJson)) return false;
      try {
        return (JSON.parse(fs.readFileSync(qcVerdictJson, "utf8")) as { status?: string }).status === "FAIL";
      } catch {
        return false;
      }
    })();
    if (input.resume && !forcesRedo(hopIds, shot.id, input.shot) && !qcSaysFail && fs.existsSync(out) && fs.statSync(out).size >= 8_000) {
      prevKeyframe = out;
      stills.push(out);
      if (fs.existsSync(recordJson)) {
        const rec = JSON.parse(fs.readFileSync(recordJson, "utf8")) as {
          prompt?: string;
          nodePaths?: string[];
          node_paths?: string[];
          base?: string;
          refs?: string[];
          first?: boolean;
        };
        const nodePaths = rec.nodePaths ?? rec.node_paths ?? [];
        // records carry bare filenames (T36 law) — resolve them back to
        // real paths so the T44 retry gate can hash-check the files
        const resolveRef = (r: string) => {
          if (path.isAbsolute(r)) return r;
          const p = Object.values(ctx.portraits!.files).find((f) => path.basename(f) === r);
          return p ?? path.join(ctx.stillDir!, r);
        };
        if ((rec.prompt || prompt) && nodePaths.length) {
          editInputs.set(shot.id, {
            prompt: rec.prompt || prompt,
            nodePaths,
            base: rec.base ? (path.isAbsolute(rec.base) ? rec.base : path.join(ctx.blockoutDir!, rec.base)) : base,
            refs: (rec.refs ?? []).map(resolveRef),
            first: Boolean(rec.first ?? first),
          });
        }
      }
      // record 缺 node_paths：仍然照用 png，QC fail 時下面會 rebuild + /edit
      if (!editInputs.has(shot.id)) {
        editInputs.set(shot.id, {
          prompt,
          nodePaths: [],
          base,
          refs: [],
          first,
        });
      }
      await speak("stills", `${shot.id} keyframe 照舊（未 QC），唔重 /edit。`);
    } else {
    const stillStarted = Date.now();
    const cells = shotCells.get(shot.id);
    if (!cells?.length || !cells.every((f) => fs.existsSync(f))) {
      // 0927 停法手術：per-item 唔殺成隊（照 ViMax REPL 唔死）——呢鏡 blocked，
      // 繼續其他鏡；缺件落 events，唔令成個 job 死。
      emit(jobId, {
        agent: "stills", level: "warn",
        message: `${shot.id} 鍵格板未切出——呢鏡 blocked，繼續其他鏡`,
        data: { shot: shot.id, stage: "stills", blocked: "keyframe-cells-missing" },
      });
      continue;
    }
    if (path.resolve(cells[0]!) !== path.resolve(out)) fs.copyFileSync(cells[0]!, out);
    shot.keyframeFiles = cells;
    const identity = refIds
      .map((id) => ctx.portraits!.sheets?.[id] || ctx.portraits!.files[id])
      .filter((p): p is string => Boolean(p && fs.existsSync(p)));
    const sheetPrompt = keyframeSheetPrompt(momentsForShot(shot, ctx.stillDir!));
    editInputs.set(shot.id, { prompt: sheetPrompt, nodePaths: [], base, refs: identity, first });
    prevKeyframe = cells[cells.length - 1]!;
    stills.push(out);
    upsertDoc({
      id: `image:${shot.id}`,
      slate: jobId,
      modality: "image",
      shotId: shot.id,
      text: sheetPrompt,
      absPath: out,
    });
    emit(jobId, {
      agent: "stills",
      level: "info",
      message: `${shot.id} 鍵格由成張板切出（${cells.length} 格）`,
      data: {
        file: `stills/${path.basename(cells[0]!)}`,
        cells: cells.map((f) => path.basename(f)),
        shot: shot.id, stage: "keyframe", eye: "stills", verdict: "pass",
        proof: `stills/${shot.id}.png`, ms: Date.now() - stillStarted,
      },
      step_id: "keyframe-prompt",
      parent_steps: ["boards"],
      seat: "stills",
      constraints_checked: ["prop-drift", "cast-drift", "require-keys"],
    });
    } // else: cells already cut from the shared sheet

    // bug4: picture QC judges THIS still inside the same loop, immediately
    // after /edit (or a reused un-QC png) — GREEN pin exists before the next
    // shot asks for Image-2. T44 GREEN-only gate unchanged. Retry stays FAIL-only
    // (PASS_UNCONFIRMED 唔自動當 FAIL 重出 — 報 SlateLead，唔自決).
    const png = out;
    const geometryShot = localPictureQc({ stills: [out], sheet: { ...ctx.timed!, shots: [shot] }, target: "stills" });
    if (!geometryShot.pass) {
      const detail = geometryShot.issues.map((i) => i.detail).join("; ");
      appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc-geometry", geometryShot.issues.map((i) => i.detail)));
      // 0927 停法手術：結構預檢唔過＝呢鏡 blocked，繼續其他鏡，唔殺 job。
      emit(jobId, {
        agent: "pictureQc", level: "warn",
        message: `${shot.id} plan-geometry 預檢唔過——呢鏡 blocked（${detail}）`,
        data: { shot: shot.id, stage: "stills", blocked: "plan-geometry", detail },
      });
      continue;
    }
    const qcStarted = Date.now();
    const qcJson = path.join(ctx.stillDir!, `${shot.id}.photo_qc.json`);
    // 內部期望版（0927 fix ③）：判官食埋呢張 still 生成嗰陣嘅完整 prompt 原文
    // （editInputs 就係每鏡生成 prompt 真源），require 字面配對升級做對生成
    // 承諾驗收。攞唔到 prompt＝expectation 缺席，行為完全不變。
    const qcRequireWithExpectation = (req: QcRequire): QcRequire => {
      const genPrompt = editInputs.get(shot.id)?.prompt;
      return genPrompt ? { ...req, expectation: genPrompt } : req;
    };
    let result = await runPhotoQc(png, qcJson, qcRequireWithExpectation(require), {}, photoQcEyesFromEnv());
    let promptShot = shot;
    let liveRequire = require;
    if (result.status === "FAIL" && isLocationFail(result.checks.fail_reasons) && !textMiss(result.checks.fail_reasons)) {
      // T32 rev2: location FAIL 退返阿圖重寫場景 slot 一次（自動，唔係人手改 prompt）
      const inputs0 = editInputs.get(shot.id);
      if (!inputs0) {
        // 0927 停法手術：冇 /edit 記錄（舊 job resume 等）＝場景 rewrite 冇材料，
        // 跳過 rewrite 直接行下面通用 retry，唔殺 job。
        emit(jobId, {
          agent: "pictureQc", level: "warn",
          message: `${shot.id} scene-retry 冇 /edit inputs——跳過場景 rewrite，行通用 retry`,
          data: { shot: shot.id, stage: "retry", blocked: null },
        });
      }
      const backToBoards = seal({
        slate: jobId,
        from: "pictureQc",
        to: "boards",
        payload: { shotId: shot.id, failReasons: result.checks.fail_reasons, current: shot.require?.location ?? shot.location },
      });
      // T32b: 請求自帶 schema（阿圖唔使估）＋charter 形 map＋junk 另計 ceiling 3
      let next: { location: string; angle?: "eye" | "high" | "low"; negatives?: string[] } | null = null;
      try {
        const rewrite = await chatJson({
          seat: "boards",
          unit: `${shot.id}.scene-retry`,
          model: cfg.crew.boardsModel,
          crew: cfg.crew,
          system: BOARDS_CHARTER,
          user: sceneRetryUser(shot, result.checks.fail_reasons),
          schema: sceneRetrySchema,
          normalize: sceneRetryNormalize,
          schemaJunkCeiling: 3,
          receiptDir: path.join(jobDir(jobId), "seats"),
        });
        next = rewrite.value;
      } catch (err) {
        if (!(err instanceof SchemaMismatchError)) throw err;
        // T32b 裁4：shape 唔啱停喺 schema_mismatch，attempt 0 — 唔食 ceiling，
        // 阿圖 rewrite 作罷，行返通用 retry（起碼一張 /edit 出到）。
        emit(jobId, {
          agent: "pictureQc",
          level: "warn",
          message: `${shot.id} 阿圖 scene-retry shape 三次都唔啱（schema_mismatch）— rewrite 作罷，行通用 retry。`,
          data: { stage: "retry", seat: "阿圖", reason: err.reason, attempts: err.attemptsBurned, shot: shot.id, receipts: err.receipts },
          step_id: "require",
          parent_steps: ["keyframe-prompt"],
          seat: "pictureQc",
          constraints_checked: ["photo-qc"],
        });
      }
      if (next) {
        promptShot = applyBoardsDecision(shot, {
          location: next.location,
          angle: next.angle,
          negatives: next.negatives,
        });
        liveRequire = commitBoards(promptShot);
        emit(jobId, {
          agent: "pictureQc",
          level: "warn",
          message: `${shot.id} location FAIL — 退返阿圖重寫場景 slot（${next.location}），重出一次。`,
          data: { stage: "retry", seat: "阿圖", shot: shot.id, packet: open(backToBoards, { slate: jobId, to: "boards" }) },
          step_id: "require",
          parent_steps: ["keyframe-prompt"],
          seat: "pictureQc",
          constraints_checked: ["photo-qc"],
        });
        // V0 修：inputs0 可能 undefined（scene-retry 冇 /edit 記錄嗰陣）——spread 會令
        // nodePaths/base/refs/first 全變 optional 炸型。缺記錄就唔 set，行下面通用
        // retry 重建（L605 已 emit warn）。
        if (inputs0) {
          editInputs.set(shot.id, { ...inputs0, prompt: keyframeEditPrompt(ctx.timed!, promptShot, { first, ...(baseCast ? { cast: baseCast } : {}) }) });
        }
      }
    }
    if (result.status === "FAIL") {
      const reasons = result.checks.fail_reasons.join("; ") || "not GREEN";
      appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc", result.checks.fail_reasons));
      // T36 law: fail_reasons go to events + violations only, never into the
      // prompt — the old retry suffix taught the stills model to game its own
      // QC by quoting its fail reasons back at it. retry = the 阿圖 packet
      // re-issued verbatim (same base, same refs, same lane settings); if it
      // fails again the job blocks below.
      emit(jobId, {
        agent: "pictureQc",
        level: "warn",
        message: `${shot.id} 唔過（fail_reasons 只入 events，唔入 prompt）`,
        data: {
          shot: shot.id, require, fail_reasons: result.checks.fail_reasons,
          stage: "require", eye: "pictureQc", verdict: "fail",
          proof: `stills/${shot.id}.photo_qc.json`, ms: Date.now() - qcStarted,
        },
        step_id: "require",
        parent_steps: ["keyframe-prompt"],
        seat: "pictureQc",
        constraints_checked: ["photo-qc"],
      });
      await speak(
        "pictureQc",
        textMiss(result.checks.fail_reasons)
          ? `${shot.id} 文字唔啱，同一張卡再抽一次，唔加字、唔改 prompt。`
          : `${shot.id} 唔過（${reasons}）— 原封重出同一 packet 一次。`,
        "warn",
      );
      let inputs = editInputs.get(shot.id);
      const plan = hopStillPlans.find((p) => p.shot.id === shot.id);
      if (!inputs || !inputs.nodePaths.length) {
        // T44 §2: the rebuild may not ride the shot's own FAILed still back
        // in — a non-first rebuild refs the previous shot's still instead
        // (the GREEN gate below drops it if that one is not GREEN either)
        const base = path.join(ctx.blockoutDir!, `${shot.id}.f0.png`);
        const refIds = [...new Set(shot.marks.map((m) => m.characterId))];
        const planIdx = hopStillPlans.findIndex((p) => p.shot.id === shot.id);
        const prevPlan = planIdx > 0 ? hopStillPlans[planIdx - 1] : undefined;
        const firstAppearance = Boolean(plan?.first);
        if (firstAppearance) {
          const missing = refIds.filter((id) => {
            const p = ctx.portraits!.files[id];
            return !p || !fs.existsSync(p);
          });
          if (missing.length) {
            // 0927 停法手術：retry 缺肖像＝呢鏡 blocked（首次出場要有肖像），
            // 繼續其他鏡，唔殺 job。
            emit(jobId, {
              agent: "stills", level: "warn",
              message: `${shot.id} retry 冇肖像（${missing.join("、")}）——呢鏡 blocked，繼續其他鏡`,
              data: { shot: shot.id, stage: "retry", blocked: "portrait-missing", missing },
            });
            continue;
          }
        }
        const refFiles = firstAppearance
          ? refIds.map((id) => ctx.portraits!.files[id]!)
          : prevPlan
            ? [path.join(ctx.stillDir!, `${prevPlan.shot.id}.png`)]
            : [];
        inputs = {
          prompt: inputs?.prompt || plan?.prompt || "",
          nodePaths: [],
          base,
          refs: refFiles,
          first: firstAppearance,
        };
        editInputs.set(shot.id, inputs);
      }
      if (!inputs.prompt) {
        // 0927 停法手術：retry 冇 prompt 記錄＝呢鏡 blocked，繼續其他鏡。
        emit(jobId, {
          agent: "pictureQc", level: "warn",
          message: `${shot.id} retry 冇 /edit prompt——呢鏡 blocked，繼續其他鏡`,
          data: { shot: shot.id, stage: "retry", blocked: "prompt-missing" },
        });
        continue;
      }
      // T44 §2/§4: the retry re-derives refs through the GREEN gate — the
      // shot's own failed still is structurally never among the candidates,
      // and any ref that lost its GREEN since the first attempt drops out
      // with a ref_rejected event, ctx.portraits! standing in
      const regate = refsGreenOnly((inputs.refs ?? []).filter((f) => /\/stills\//.test(f.replace(/\\/g, "/"))));
      for (const r of regate.rejected) refRejected(shot.id, r);
      const sheets = uncutIdentityFiles(shot, ctx.portraits!.sheets, [
        path.join(jobDir(jobId), "portraits"),
        input.portraitsDir ?? "",
      ]);
      const retryImages = sheets.slice(0, MAX_IMAGES);
      // The outer shot QC rejected its primary still; other anchors stay pinned.
      const retryMoments = momentsForShot(promptShot, ctx.stillDir!).slice(0, 1);
      await runBoards({ render: {
        moments: retryMoments,
        boardsDir: path.join(ctx.stillDir!, "boards"),
        name: `${shot.id}-retry`,
        images: retryImages,
        lane: sheetLane,
        seed: cfg.motion.seed + 1,
        receiptDir: path.join(jobDir(jobId), "seats", "boards"),
        require: { [shot.id]: liveRequire },
      } });
      if (path.resolve(retryMoments[0]!.file) !== path.resolve(png)) fs.copyFileSync(retryMoments[0]!.file, png);
      shot.keyframeFiles = momentsForShot(promptShot, ctx.stillDir!).map((m) => m.file);
      editInputs.set(shot.id, { ...inputs, refs: [...sheets, ...regate.kept] });
      result = await runPhotoQc(png, qcJson, qcRequireWithExpectation(liveRequire), {}, photoQcEyesFromEnv());
      if (result.status === "FAIL") {
        await speak("pictureQc", `${shot.id} 再抽仍然唔啱，同一句故事再出一次，唔改動作。`, "warn");
        await runBoards({ render: {
          moments: retryMoments,
          boardsDir: path.join(ctx.stillDir!, "boards"),
          name: `${shot.id}-same`,
          images: retryImages,
          lane: sheetLane,
          seed: cfg.motion.seed + 3,
          receiptDir: path.join(jobDir(jobId), "seats", "boards"),
          require: { [shot.id]: liveRequire },
        } });
        if (path.resolve(retryMoments[0]!.file) !== path.resolve(png)) fs.copyFileSync(retryMoments[0]!.file, png);
        shot.keyframeFiles = momentsForShot(promptShot, ctx.stillDir!).map((m) => m.file);
        result = await runPhotoQc(png, qcJson, qcRequireWithExpectation(liveRequire), {}, photoQcEyesFromEnv());
      }
    }
    if (result.status === "FAIL") {
      const reasons = result.checks.fail_reasons.join("; ") || "not GREEN";
      const textStill = textMiss(result.checks.fail_reasons);
      appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc", result.checks.fail_reasons));
      await buildShotSheet(shot.id, require, editInputs.get(shot.id)?.prompt ?? shot.stillPrompt ?? "");
      writeSceneSheetHtml();
      const redoRel = `seats/${shot.id}.redo.json`;
      fs.mkdirSync(path.join(jobDir(jobId), "seats"), { recursive: true });
      const from = hopIds.indexOf(shot.id);
      fs.writeFileSync(jobFile(jobId, redoRel), JSON.stringify({
        owner: "boards",
        shot: shot.id,
        reasons: result.checks.fail_reasons,
        tail: from < 0 ? [shot.id] : hopIds.slice(from),
      }, null, 2));
      ctx.job = patch(ctx.job, {
        status: "blocked",
        currentAgent: "pictureQc",
        providers: trace,
        error: textStill
          ? `picture QC ${shot.id} 再抽同改一句都唔過：${reasons}`
          : `picture QC ${shot.id} 連續兩次唔過：${reasons}`,
        outputs: { ...ctx.job.outputs, redo: redoRel },
      });
      emit(jobId, {
        agent: "pictureQc",
        level: "fail",
        message: textStill
          ? `${shot.id} 同一張卡再抽，改一句之後仍然文字唔啱（${reasons}）。停，唔再改。`
          : `${shot.id} 兩次都唔過（${reasons}）。停手，唔硬出。修 prompt 或者換 plug 之後 --resume ${jobId}。`,
        data: {
          shot: shot.id, require, fail_reasons: result.checks.fail_reasons,
          stage: "require", eye: "pictureQc", verdict: "fail",
          proof: `stills/${shot.id}.photo_qc.json`, ms: Date.now() - qcStarted,
        },
        step_id: "require",
        parent_steps: ["keyframe-prompt"],
        seat: "pictureQc",
        constraints_checked: ["photo-qc"],
      });
      ctx.stopped = true;
      return;
    }
    const warns = (result.checks.warns as string[] | undefined) ?? [];
    if (result.status === "PASS_WITH_WARN") {
      emit(jobId, {
        agent: "pictureQc",
        level: "warn",
        message: `${shot.id} PASS_WITH_WARN（${warns.join("; ")}）— 照出，警示留底。`,
        data: {
          shot: shot.id, warns, stage: "require", eye: "pictureQc", verdict: "pass_with_warn",
          proof: `stills/${shot.id}.photo_qc.json`,
        },
        step_id: "require",
        parent_steps: ["keyframe-prompt"],
        seat: "pictureQc",
        constraints_checked: ["photo-qc"],
      });
      await speak("pictureQc", `${shot.id} PASS_WITH_WARN（${warns.join("; ")}）`, "warn");
    } else {
      await speak("pictureQc", `${shot.id} GREEN（人數 ${liveRequire.people_count}）`, "pass");
      writeStillStamp(shot.id, first, editInputs.get(shot.id)?.prompt ?? prompt);
      emit(jobId, {
        agent: "pictureQc",
        level: "pass",
        message: `${shot.id} photo QC GREEN（人數 ${liveRequire.people_count}）`,
        data: {
          shot: shot.id, stage: "require", eye: "pictureQc", verdict: "pass",
          proof: `stills/${shot.id}.photo_qc.json`, ms: Date.now() - qcStarted,
        },
        step_id: "require",
        parent_steps: ["keyframe-prompt"],
        seat: "pictureQc",
        constraints_checked: ["photo-qc"],
      });
    }
    if (cfg.embed.endpoint.trim()) {
      try {
        await ingestStill({
          ep: ctx.job.slate,
          shot: shot.id,
          character: shot.marks[0]?.characterId ?? "",
          scene: shot.location || ctx.timed!.location,
          file: png,
          rel: `stills/${shot.id}.png`,
        });
      } catch (error) {
        await speak("stills", `${shot.id} WeMM 入庫失敗：${error instanceof Error ? error.message : error}`, "warn");
      }
    }
    await buildShotSheet(shot.id, require, editInputs.get(shot.id)?.prompt ?? shot.stillPrompt ?? "");
  }
  writeSceneSheetHtml();
  // picture QC slate record: every hop still above is already GREEN-pinned
  // in-loop (bug4). Whole-slate (or hop) plan-geometry is the receipt.
  const qcSheet = input.only
    ? { ...ctx.timed!, shots: ctx.timed!.shots.filter((s) => s.id === input.only) }
    : input.scene
      ? { ...ctx.timed!, shots: shotsForScene(ctx.timed!.shots, input.scene) }
      : ctx.timed!;
  const geometry = localPictureQc({ stills, sheet: qcSheet, target: "stills" });
  ctx.geometry = geometry;
  if (!geometry.pass) {
    const detail = geometry.issues.map((i) => i.detail).join("; ");
    appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc-geometry", geometry.issues.map((i) => i.detail)));
    throw new Error(`picture QC plan-geometry pre-check failed: ${detail}`);
  }
  trace.mars = `qwen38 ${cfg.pictureQc.endpoint} (${cfg.pictureQc.model})`;
  ctx.job = patch(ctx.job, { pictureQcStills: geometry, providers: trace, progress: 55 });
}
