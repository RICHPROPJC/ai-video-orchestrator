import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import sharp from "sharp";
import { Resvg } from "@resvg/resvg-js";
import { blenderBlockingScript } from "./blender";
import { readWavMono, runCommand } from "./audio";
import { acquireJob, emit, ownerHeartbeatMs, ownerIsStale, readJob, releaseJob, takeoverJob, writeJob, type JobOwner } from "./store";
import { renderBlockingSvg } from "./painter";
import { localPictureQc, senseVoiceHttp, soundQcFromRemote, soundQcUnconfigured, wavPrecheck } from "./providers";
import { shouldWaitEarnLock, waitEarnGpuLock } from "./earn-gpu-lock";import { loadConfig, type SlateConfig } from "./config";
import type { AgentId, CallSheet, JobRecord, ProduceInput, ProviderTrace, Shot } from "./types";
import { floorLine, seat } from "./crew";
import { assertSameCanon, continuityMarkdown, lockContinuity } from "./continuity";
import { open, packetLine, seal } from "./dispatch";
import { buildNarrativePlan, planMarkdown } from "./narrative";
import { indexPlanTexts, recall, upsertDoc, vaultStats } from "./vault";
import { relInJob, resolveInJob } from "./isolate";
import { loadCallSheet } from "./writer";
import { runWriter } from "./seat-writer";
import { runDirector, writeCreativeArtifacts, runPlaywright, briefSha, readCreativeManifest, updateCreativeManifest, unplacedDialogueOf, declaredDialogueOf, planDivergence, audioTimelineRows } from "./creative";
import type { DirectorSkeleton } from "./seat-boards";
import { runBoards } from "./seat-boards";
import { chatJson, SchemaMismatchError } from "./crew-llm";
import { BOARDS_CHARTER } from "./seat-charters";
import { ensurePortraits } from "./portraits";
import { assertStoryPlatesReady, ensureCastOnce } from "./cast-mesh";
import { lookupShelf } from "./asset-library";
import { writeStoryWorld, ensureWorldSizes, type WorldPlan } from "./world-assemble";
import { piecesFromCallSheet, resolveScales, type WorldPiece } from "./world-scale";
import { chunkMomentSheets, ensurePropBoard, ensureSceneBoard, keyframeSheetPrompt, liveBoardLane, momentsForShot } from "./asset-board";
import { diffPropPlates, nextPropBoardSeq, propAssetId, writePropPinManifest } from "./prop-plate-index";
import { ensureDir, jobDir, jobFile, projectsDir, seatsDir } from "./paths";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { layDialogueBed } from "./dialogue-bed";
import { plugShotWavs, plugVoiceEvents } from "./shot-wav-plug";
import { buildCutPlan, type CutPlan } from "./cut-plan";
import { checkGate } from "./concat-gate";
import { writeAnchors } from "./dhash-anchors";
import { assertFiguresVisible, blockoutFromPlug, extractFrame0, renderBlockout, stillFrameFor } from "./blockout";
import { isLocationFail, keyframeEditPrompt, keyframeRequire, loadBaseCast, needsShotFacts, sceneRetryNormalize, sceneRetrySchema, sceneRetryUser, textMiss } from "./keyframe-prompt";
import { applyBoardsDecision, forcesRedo, redoFromIndex } from "./shot-redo";
import { runPeStep } from "./pe-step";
import { buildProse, buildProsePositive, validateProse, wardrobeClauses, SCRIPT_HEADER } from "./h3-prose";
import { applyCombatPass } from "./combat-adapter";
import { submitH3Shot } from "./h3-submit";
import type { H3GraphVariant } from "./h3-r2v-graph";
import { assertH3Plan, assertH3SubmitWiring, planH3Shot, type AnglePortrait } from "./h3-slots";
import {
  DECIDER_DEFAULTS,
  MOTION_LIB_ROOT,
  bakeSelectionFrames,
  buildCmuIndex,
  buildShortlist,
  decideSelection,
  legalCandidates,
  postureConflict,
  verbsForGate,
  motionSegments,
  parseCombatSweepRanking,
  selectMotions,
  msGridFrames,
  segmentFrameBudget,
  snapFramesPerShot,
  writeSelections,
  type MotionSelection,
  type MotionShotLine,
} from "./motion-select";
import { assertNativeFfmpeg, concatCopyArgs } from "./native-cut";
import { MAX_IMAGES, type EditPayload, type U15EditRecord } from "./u15-edit";
import { runPhotoQc, pinQcAccepted, photoQcEyesFromEnv, type QcRequire } from "./photo-qc";
import { buildQcSheet, buildQcSheetHtml, readQcReceipt } from "./qc-sheet";
import { pinVideoQcAccepted, runVideoQc } from "./video-qc";
import { attachMemoryDistances, ingestStill, queryRefs } from "./memory";
import { appendViolation, checkBoardsToKeyframe, checkKeyframeToStills, hardErrorRow, hardPhotoQcRow } from "./trace";
import { rangesFor } from "./script-contract";
import { blockoutPlugGap, gapEvent, gapMessage, motionNeedsHumanGap, storyboardZeroGap } from "./capability-gap";
import {
  patch,
  h3GraphVariant,
  prevShotOf,
  writeH3Plan,
  kfRideFor,
  anglePortraitsFor,
  uncutIdentityFiles,
  h3MotionPack,
  ffmpeg,
  mediaSeconds,
  shotsForScene,
  hopGeometrySheet,
  describeFloor,
  type Ctx, setActiveOwner, depStampOf, GAP_BUDGET } from "./pipeline/shared";
export {
  anglePortraitsFor,
  uncutIdentityFiles,
  h3MotionPack,
  shotsForScene,
  hopGeometrySheet,
  describeFloor,
} from "./pipeline/shared";
import { stillsStage } from "./pipeline/stills";
export { stillFirstFlags, refsGreenOnly, sealEditRecord } from "./pipeline/stills";
import { worldStage } from "./pipeline/world";
import { authorStage } from "./pipeline/author";

/** Sol 0926 裁決 E：KF 兩幅同一構圖策略備 544×960——2304 方圖交畀 node 會
 *  首張 stretch 尾張 center-crop，兩幅處理唔一致互相打架。centre-crop 9:16
 *  再 resize；derived 圖自帶 receipt（source/out sha），唔沿用原圖 GREEN。 */
async function prepR2v544(file: string): Promise<string> {
  const out = file.replace(/\.png$/, ".r2v544.png");
  if (!fs.existsSync(out)) {
    const tmp = `${out}.tmp.png`;
    await sharp(file).resize(544, 960, { fit: "cover", position: "centre" }).png().toFile(tmp);
    fs.renameSync(tmp, out);
    const sha = (f: string) => createHash("sha256").update(fs.readFileSync(f)).digest("hex");
    fs.writeFileSync(out.replace(/\.png$/, ".json"), JSON.stringify({
      purpose: "sol_0926_E_kf_prep",
      strategy: "centre-crop-9:16-then-resize-544x960 (sharp cover/centre)",
      source: file,
      source_sha256: sha(file),
      out,
      out_sha256: sha(out),
      note: "derived 圖；QC 對應以本 receipt 為準，原圖 GREEN 唔直接沿用",
    }, null, 2));
  }
  return out;
}

function assertIdentitySheets(
  shot: Shot,
  portraits: { sheets?: Record<string, string>; files: Record<string, string> },
  portraitDir: string,
  plugDir?: string,
): void {
  const missing = [...new Set(shot.marks.map((m) => m.characterId))].filter((id) => {
    const candidates = [
      portraits.sheets?.[id],
      portraits.files[id],
      path.join(portraitDir, `${id}.png`),
      ...(plugDir ? [path.join(plugDir, `${id}.png`)] : []),
    ];
    return !candidates.some((file) => typeof file === "string" && fs.existsSync(file));
  });
  if (missing.length > 0) throw new Error(`${shot.id}: 身份成張未齊 ${missing.join("、")}`);
}

/** CFORM7: the motion eye judges the take's own timeline. require.json.action is
 *  the boards' freeze sentence (企定零過程動詞，B-lane keyframe discipline — right
 *  for stills), but the clip runs the callsheet action script: motion-select
 *  verbGated the bake against it and the prose anchors it verbatim. Judging a
 *  moving take against the freeze line fails exactly the frames that moved
 *  (run6 SH01 f61/f123 misses 企定全句). So the motion QC require's action key
 *  is written from the clip action — shot.action first, motionPrompt fallback;
 *  every other key (location/size/people) rides the keyframe require unchanged. */
export function motionClipRequire(base: QcRequire, shot: Shot | undefined): QcRequire {
  const clipAction = shot?.action?.trim() || shot?.motionPrompt?.trim();
  return clipAction ? { ...base, action: clipAction } : base;
}

/** H3's ref-audio clock must equal the video clock: pad the wav with trailing
 *  silence to the snapped frame length; the same file feeds the mux. */
export async function padH3Wav(src: string, dst: string, frames: number): Promise<number> {
  const seconds = frames / 24;
  await ffmpeg(["-i", src, "-af", `apad=whole_dur=${seconds.toFixed(6)}`, "-c:a", "pcm_s16le", dst]);
  const got = await wavSeconds(dst);
  if (Math.abs(got - seconds) > 1 / 48) {
    throw new Error(`${dst}: padded to ${got.toFixed(4)}s, wanted ${seconds.toFixed(4)}s (${frames}f/24)`);
  }
  return got;
}

/** per-shot mux: own padded wav, level-matched; H3's own audio is dropped */
export function muxArgs(mp4: string, h3Wav: string, out: string): string[] {
  const args = [
    "-i", mp4,
    "-i", h3Wav,
    "-map", "0:v", "-map", "1:a",
    "-af", "loudnorm=I=-18:TP=-1.5:LRA=11",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    out,
  ];
  assertNativeFfmpeg(args);
  return args;
}

export async function runPipeline(jobId: string, input: ProduceInput) {
  const initial = readJob(jobId);
  if (!initial) throw new Error("missing job");
  // V2a（PLAN-v2 0928）：唯一執行者——開工前原子取權。撞活躍 owner＝
  // fail-loud 報邊個行緊；靜過 30 分鐘（STALE）先准接管（epoch+1，舊 token
  // 由呢刻起全部失效）。
  const taken = acquireJob(jobId);
  let owner: JobOwner;
  if (taken.ok) {
    owner = taken.owner;
  } else if (!taken.holder || taken.holder.releasedAt || ownerIsStale(jobId)) {
    owner = takeoverJob(jobId, taken.holder?.releasedAt ? "前一 owner 已 release" : "STALE 超過 30 分鐘無心跳");
  } else {
    const h = taken.holder;
    const quietMin = ownerHeartbeatMs(jobId) === null ? 0 : Math.round((ownerHeartbeatMs(jobId) as number) / 60_000);
    throw new Error(
      `owner_conflict: ${jobId} 有現行執行者（epoch ${h.epoch}，pid ${h.pid ?? "?"}，${quietMin} 分鐘前心跳）——等佢完或者接管佢。`,
    );
  }
  setActiveOwner(owner);
  const cfg = loadConfig();
  // no plug wavs ⇒ voice seat speaks the VO through AuK — the door must be armed up front
  if (!input.wavDir && input.until !== "boards" && !cfg.tts.endpoint.trim()) {
    throw new Error("--wav-dir 缺，而 tts.endpoint 未接（AuK http://127.0.0.1:9882）：無聲軌來源");
  }
  const trace: ProviderTrace = {
    stills: `U1.5 /edit ${cfg.stills.url}`,
    motion: `H3 R2V ${cfg.motion.comfyUrl}`,
    tts: "wav plug",
    senseVoice: cfg.soundQc.endpoint ? "SenseVoice HTTP" : "SenseVoice unconfigured",
    mars: `qwen38 ${cfg.pictureQc.endpoint}`,    blender: "pending",
    lipSync: "none — H3 audio dropped; own wav muxed",
  };
  const ctx: Ctx = {
    jobId,
    input,
    cfg,
    job: initial,
    trace,
    speak: async (agent: AgentId, message: string, level: "info" | "warn" | "pass" | "fail" = "info") => {
      const who = seat(agent);
      ctx.job = patch(ctx.job, { currentAgent: agent, status: "running" });
      emit(jobId, {
        agent,
        level,
        message: `${who.name}／${who.job} · ${message}`,
        data: { name: who.name, job: who.job, thinking: who.thinking },
      });
    },
    think: async (agent: AgentId) => {
      const who = seat(agent);
      emit(jobId, {
        agent,
        level: "info",
        message: `想：${who.thinking}`,
        data: { name: who.name, thinking: who.thinking },
      });
    },
    motionSelections: new Map(),
    wavByShot: new Map(),
    h3WavByShot: new Map(),
    gapDelivered: new Map(),
    stills: [],
    shotVideos: [],
    receipts: [],
  };
  const speak = ctx.speak;
  const think = ctx.think;

  try {
    await authorStage(ctx);
    if (ctx.stopped) return;
    await worldStage(ctx);
  // §9④：有界自主回修——world 發現聲畫 gap 且額度內→行內返 author revise→
  // world 重算，先放行受影響 still/motion；額度耗盡先照落（gap 鏡已 per-shot
  // blocked，收尾統一 verdict 兜底）。唔另造 runner——即場 stage 控制。
  for (let repairRound = 0; repairRound < GAP_BUDGET; repairRound++) {
    if (ctx.stopped) break;
    // §13.2：額度真源＝episode（行內 loop 同 author/resume 共用）
    const jobNow = readJob(jobId);
    const gapsNow = jobNow?.placementGaps ?? [];
    if (!gapsNow.length || (jobNow?.soundRepairEpisode?.attempts ?? 0) >= GAP_BUDGET) break;
    emit(jobId, {
      agent: "producer", level: "warn",
      message: `自主回修第 ${repairRound + 1} 輪：${gapsNow.length} 句聲畫 gap 額度內——返 author 修訂後重算 world`,
      data: { stage: "sound-picture-repair", round: repairRound + 1 },
    });
    await authorStage(ctx);
    if (ctx.stopped) break;
    await worldStage(ctx);
  }
    if (ctx.stopped) return;
    await stillsStage(ctx);
    if (ctx.stopped) return;
    // motion: H3 R2V per shot — photo QC pin must be accepted before submit
    const motionDir = path.join(jobDir(jobId), "motion");
    ensureDir(motionDir);
    const shotVideos: string[] = [];
    const receipts: string[] = [];
    const toMotion = seal({
      slate: jobId,
      from: "stills",
      to: "motion",
      payload: { boards: ctx.continuity!.boards },
    });
    await think("motion");
    open(toMotion, { slate: jobId, to: "motion" });
    await speak("motion", packetLine(toMotion));
    await speak("motion", `H3 R2V ${cfg.motion.comfyUrl} · Video1 係呢條 Blender clip（motion only），shot 嘅百分比字串跟住一齊行。一鏡一 submit。`);
    // C-scene-hop: the scene flag crops the stills/QC lanes above and this
    // motion loop; a no-match scene throws before any H3 is burned
    const motionShots = shotsForScene(ctx.stillPlans!.map((p) => p.shot), input.scene)
      .filter((s) => !input.only || s.id === input.only);
    const motionIds = motionShots.map((s) => s.id);
    if (input.shot) redoFromIndex(motionIds, input.shot);
    if (input.scene) {
      await speak("motion", `--scene ${input.scene} hop：燒 ${motionShots.length}/${ctx.stillPlans!.length} 鏡，其餘唔郁。`);
    }
    // MULTISHOT_WIRE cross-shot scheduling: motion-heavy shots (martial/run)
    // anchor C-form renders; trailing simple shots chain onto the anchor
    // (true-endframe multishot); a leading run of simple shots is ONE
    // standalone multishot call. Solo shots keep the single-shot path.
    const segments = motionSegments(motionShots.map((s) => ({ id: s.id, action: s.action })));
    const segShotsOf = new Map<string, string[]>(); // first shot id -> all segment shots
    const followerOf = new Map<string, string>(); // follower id -> anchor/first id
    for (const seg of segments) {
      const shots = seg.kind === "cform" ? [seg.anchor, ...seg.chain] : seg.shots;
      segShotsOf.set(shots[0]!, shots);
      for (const id of shots.slice(1)) followerOf.set(id, shots[0]!);
    }
    const segmentsFile = path.join(motionDir, "segments.json");
    // multi = any segment rendering MORE than one shot (a C-form anchor with
    // even ONE chained follower, or a multishot run of 2+)
    const hasMulti = segments.some((s) => (s.kind === "cform" ? s.chain.length > 0 : s.shots.length > 1));
    {
      // Always replace the manifest from this plan; never reuse an old chained topology.
      fs.writeFileSync(
        segmentsFile,
        JSON.stringify(
          {
            policy: "ALIGN-LOCK: solo C-form; separate multishot takes uncut identity sheets only",
            segments: segments.map((s) => {
              const ids = s.kind === "cform" ? [s.anchor, ...s.chain] : s.shots;
              const budget = s.kind === "multishot" ? segmentFrameBudget(ids.map((id) => ctx.cutPlan!.shots.find((c) => c.id === id)?.duration_s ?? 0)) : undefined;
              return {
                kind: s.kind,
                shots: ids,
                segId: ids.join("-"),
                ...(budget ? { frames: budget.total, perShot: budget.perShot } : {}),
              };
            }),
          },
          null,
          2,
        ) + "\n",
      );
    }
    const segManifest = fs.existsSync(segmentsFile)
      ? (JSON.parse(fs.readFileSync(segmentsFile, "utf8")) as { segments: { kind: string; shots: string[]; frames?: number; perShot?: number }[] }).segments
      : null;
    await speak(
      "motion",
      hasMulti
        ? `跨shot接駁：${segments.length} 個 render段（${segments.filter((s) => s.kind === "cform" && s.chain.length).length} 段C形+multishot鏈、${segments.filter((s) => s.kind === "multishot" && s.shots.length > 1).length} 段純multishot）→ segments.json。`
        : `跨shot接駁：${segments.length} 鏡全部單鏡render（冇鏈）。`,
    );
    for (const shot of motionShots) {
      // §8.2：placement-gap blocked 鏡唔燒（world 段 gap 對照後已 emit blocked）
      if ((ctx.job.blockedShots ?? []).some((b) => b.shot === shot.id && b.reason.startsWith("placement-gap"))) {
        continue;
      }
  try {
        if (!pinQcAccepted(ctx.stillDir!, shot.id)) {
          throw new Error(`${shot.id}: photo_qc 未 GREEN（sha 或 schema 唔吻合）— 唔准燒 H3`);
        }
        if (followerOf.has(shot.id)) {
          // chained/simple follower: its motion rides the segment's one render
          emit(jobId, {
            agent: "motion",
            level: "info",
            message: `${shot.id} 行跨shot段（跟 ${followerOf.get(shot.id)} 一齊 render）— 唔單獨燒。`,
            data: { shot: shot.id, stage: "motion", segment: followerOf.get(shot.id) },
          });
          continue;
        }
        const segList = segShotsOf.get(shot.id) ?? [shot.id];
        const segId = segList.join("-");
        const segIsMultishot = segments.find(
          (s) => (s.kind === "cform" ? s.anchor : s.shots[0]) === shot.id && s.kind === "multishot",
        );
        const variant = h3GraphVariant(input);
        const stillPng = path.join(ctx.stillDir!, `${shot.id}.png`);
        const prev = prevShotOf(ctx.timed!, shot);
        const blockoutMp4 = path.join(ctx.blockoutDir!, `${shot.id}.mp4`);
        // §5b routing field: the Video 1 asset on disk decides the form
        // 0927 fix ②：motion gap（kf_driven）嘅鏡唔食 blockout——舊跑留低嘅
        // 假 bake 都唔用，hasVideo1=false 行 A-form KF 驅動。
        const hasVideo1 = fs.existsSync(blockoutMp4) && ctx.motionSelections.get(shot.id)?.gap?.remedy !== "kf_driven";
        // KF×Video1 共存回填（Sol 0926 E）：pack 揀 ref_image_0 要知道 KF 在唔在盤
        const { positions, cutFiles } = kfRideFor(jobId, ctx.timed!, shot, ctx.stillDir!);
        const coexistKf = Boolean(positions) && cutFiles.length >= 1;
        // MULTISHOT_WIRE: this shot's segment — solo keeps the single-shot path;
        // a multishot segment renders the whole run inside H3MultishotSampler
        const segShots = segList; // [first, ...rest] of the segment
        const chained = segShots.slice(1);
        const isMsSegment = Boolean(segIsMultishot);
        const framesPerShot = chained.length
          ? snapFramesPerShot(Math.max(...chained.map((id) =>
              ctx.cutPlan!.shots.find((c) => c.id === id)?.duration_s ?? ctx.timed!.shots.find((s) => s.id === id)?.durationSec ?? 0,
            )))
          : 0;
        const msLine = (id: string) => {
          const s = ctx.timed!.shots.find((x) => x.id === id)!;
          const cast = [...new Set(s.marks.map((m) => m.characterId))]
            .map((cid) => ctx.timed!.characters.find((c) => c.id === cid)?.name ?? cid)
            .join("、");
          return `${s.heading}. ${cast}：${s.action} Same person and wardrobe as <Picture 1>. No new people.`;
        };
        const msScript = (isMsSegment ? segShots : chained).map(msLine).join("\n---\n");
        const msPortraitFile = (() => {
          const first = ctx.timed!.shots.find((x) => x.id === segShots[0])!;
          try {
            return uncutIdentityFiles(first, ctx.portraits!.sheets, [
              path.join(jobDir(jobId), "ctx.portraits!"),
              input.portraitsDir ?? "",
            ])[0];
          } catch {
            return undefined;
          }
        })();
        const pack = isMsSegment
          ? null
          : h3MotionPack(ctx.timed!, shot, variant, stillPng, ctx.portraits!.files, prev, {
              hasVideo1,
              portraitDir: path.join(jobDir(jobId), "ctx.portraits!"),
              plugDir: input.portraitsDir,
              sheets: ctx.portraits!.sheets,
              ...(coexistKf ? { cformStillRef: cutFiles[0] } : {}),
            });
        const prose = isMsSegment ? msScript : pack!.prose;
        if (variant === "a" && !isMsSegment) {
          validateProse(`${SCRIPT_HEADER}\n${prose}`, {
            requireQuote: Boolean(shot.dialogue.trim()),
            wardrobe: wardrobeClauses(ctx.timed!),
          });
        }
        if ((chained.length || isMsSegment) && !msPortraitFile) {
          throw new Error(`${segId}: multishot段要一張未切成張（<Picture 1>）`);
        }
        const doneMp4 = path.join(motionDir, `${segId}.mp4`);
        const doneReceipt = path.join(motionDir, `${segId}.h3_submit.json`);
        const segFrames = (id: string) =>
          isMsSegment
            ? snapFramesPerShot(ctx.cutPlan!.shots.find((c) => c.id === id)?.duration_s ?? 0)
            : Math.round((ctx.cutPlan!.shots.find((c) => c.id === id)?.duration_s ?? -1) * 24);
        // the multishot node DELIVERS on H3's 17k+5 grid (a 119 request lands
        // as 124) — actuals: r2v anchor snap + one grid-snapped count per
        // chained shot (run5 live: 124 + 124 = 248, ffprobe-verified)
        const segBudget = isMsSegment
          ? segmentFrameBudget(segShots.map((id) => ctx.cutPlan!.shots.find((c) => c.id === id)?.duration_s ?? 0))
          : null;
        const wantFrames = isMsSegment
          ? segBudget!.total
          : snapDurationToFrames(shot.durationSec)
            + (chained.length ? msGridFrames(framesPerShot) * chained.length : 0);
        const frameSnap = fs.existsSync(doneMp4)
          && Math.round((await mediaSeconds(doneMp4)) * 24) === wantFrames;
        // per-shot QC pins: a multi-shot segment slices per shot so each shot
        // judges against its OWN require (the anchor's require over the whole
        // take punished the chained shots' frames — run5 live lesson)
        const qcIds = segShots; // slice pins are per shot id, solo = the shot itself
        const allPinned = qcIds.every((id) => pinVideoQcAccepted(motionDir, id));
        // V2c（PLAN-v2 0928）§8：motion 材料指紋——receipt 內容（提交參數整體）
        // ＋幀數＋上游 wav/blockout/still 嘅 stat signature。層層咬合：上游
        // fingerprint 閘（blockout setKey／still dep）過期會重做→mtime 變→
        // 呢度 signature 跟住變→mp4 唔 keep 重燒。receipt 變（prose/refs 參數
        // 變）同樣觸發。冇 stamp＝provenance-unknown 唔 keep。
        const statSig = (f?: string): string => {
          try { const st = fs.statSync(f!); return st.size + ":" + Math.round(st.mtimeMs); } catch { return "none"; }
        };
        const hashHead = (f?: string): string => {
          try { return createHash("sha256").update(fs.readFileSync(f!)).digest("hex").slice(0, 12); } catch { return "none"; }
        };
        const motionStampFile = path.join(motionDir, segId + ".dep.json");
        const motionStampParts = () => depStampOf({
          receiptHash: hashHead(doneReceipt),
          frames: wantFrames,
          wavSig: statSig(ctx.h3WavByShot.get(shot.id)),
          blockoutSig: statSig(hasVideo1 && !isMsSegment ? blockoutMp4 : undefined),
          stillSig: statSig(stillPng),
        });
        const motionStampOk = () => {
          try {
            return (JSON.parse(fs.readFileSync(motionStampFile, "utf8")) as { dep?: string }).dep === motionStampParts();
          } catch {
            return false;
          }
        };
        // resume keeps an mp4 only when frame clock matches AND blind MARS video_qc is GREEN
        const kept =
          input.resume
          && !qcIds.some((id) => forcesRedo(motionIds, id, input.shot))
          && fs.existsSync(doneMp4)
          && fs.existsSync(doneReceipt)
          && frameSnap
          && allPinned
          && motionStampOk();
        if (kept) {
          shotVideos.push(doneMp4);
          receipts.push(relInJob(jobId, doneReceipt));
          await speak("motion", `${segId} 照舊，唔重燒 H3（video_qc GREEN）。`);
          continue;
        }
        // clock-correct render with missing/stale pins → QC-only resume: re-judge
        // the take, never re-burn the same seed for a QC reason
        const qcOnly =
          input.resume && fs.existsSync(doneMp4) && fs.existsSync(doneReceipt) && frameSnap && !allPinned;
        if (qcOnly) {
          await speak("motion", `${segId} mp4 時鐘啱但 pin 未齊 — 只重判QC，唔重燒。`, "warn");
        } else if (input.resume && fs.existsSync(doneMp4)) {
          await speak("motion", `${segId} mp4 時鐘唔啱 — 重燒。`, "warn");
        }
        const motionStarted = Date.now();
        if (!qcOnly) {
          const singleShot = !isMsSegment && chained.length === 0;
          const rideKf = singleShot && coexistKf;
          if (singleShot && !hasVideo1 && !positions) {
            throw new Error(`keyframe_positions_missing: ${shot.id}`);
          }
          if (singleShot && !hasVideo1 && cutFiles.length < 1) {
            throw new Error(`keyframe_positions_missing: ${shot.id} 鍵格檔未切`);
          }
          if (singleShot) {
            assertIdentitySheets(shot, ctx.portraits!, path.join(jobDir(jobId), "ctx.portraits!"), input.portraitsDir);
          }
          // Sol 0926 E：KF 兩幅備成 544×960 同一構圖策略（inject node 對 2304
          // 方圖首 stretch 尾 crop 會打架）；derived receipt 隨圖落盤。淨 start
          // 冇 end 嘅共存行返 H3Keyframes 舊路，唔備圖。
          let kfStartWired: string = cutFiles[0]!;
          let kfEndWired: string | undefined = cutFiles[1];
          if (rideKf && hasVideo1 && !isMsSegment && kfEndWired) {
            kfStartWired = await prepR2v544(kfStartWired);
            kfEndWired = await prepR2v544(kfEndWired);
          }
          if (!isMsSegment) {
            writeH3Plan(jobId, ctx.timed!, shot, {
              wav: ctx.h3WavByShot.get(shot.id)!,
              blockout: hasVideo1 ? blockoutMp4 : undefined,
              still: rideKf && hasVideo1 && kfEndWired ? kfStartWired : stillPng,
              kfStart: rideKf ? kfStartWired : (hasVideo1 ? undefined : stillPng),
              kfEnd: rideKf ? kfEndWired : (hasVideo1 ? undefined : pack!.kfEnd),
              refImageFiles: pack!.refImageFiles,
              anglePortraits: pack!.anglePortraits,
            });
          }
          const { receiptFile } = await submitH3Shot({
            prose,
            wavFile: ctx.h3WavByShot.get(shot.id)!,
            durationSec: shot.durationSec,
            blockoutMp4: hasVideo1 && !isMsSegment ? blockoutMp4 : undefined,
            keyframePositions: rideKf ? positions : undefined,
            kfStart: rideKf ? kfStartWired : (hasVideo1 || isMsSegment ? undefined : stillPng),
            kfEnd: rideKf ? kfEndWired : (hasVideo1 ? undefined : pack?.kfEnd),
            kfExtraFiles: rideKf ? cutFiles.slice(2) : undefined,
            refImageFiles: pack?.refImageFiles,
            uiPhotoFiles: pack?.uiPhotoFiles,
            ...(chained.length && !isMsSegment
              ? {
                  chain: {
                    script: msScript,
                    shots: chained,
                    framesPerShot,
                    referenceImageFile: msPortraitFile!,
                  },
                }
              : {}),
            ...(isMsSegment
              ? {
                  multishot: {
                    script: msScript,
                    shots: segShots,
                    framesPerShot: segBudget!.perShot,
                    referenceImageFile: msPortraitFile!,
                  },
                }
              : {}),
            outMp4: doneMp4,
            receiptJson: doneReceipt,
            dryRun: false,
            shot: segId,
            requireQuote: Boolean(shot.dialogue.trim()),
            wardrobe: wardrobeClauses(ctx.timed!),
            aspect: ctx.timed!.aspect,
            graphVariant: variant,
            stepsOverride: input.steps,
          });
          receipts.push(relInJob(jobId, receiptFile));
        }
        // V2c §8：submit 完成後寫材料指紋（receipt 已落盤，hash 先準）
        fs.writeFileSync(motionStampFile, JSON.stringify({ dep: motionStampParts(), ts: new Date().toISOString() }, null, 2));
        const mp4 = doneMp4;
        shotVideos.push(mp4);
        upsertDoc({
          id: `video:${segId}`,
          slate: jobId,
          modality: "video",
          shotId: segId,
          text: prose,
          absPath: mp4,
        });
        await think("pictureQc");
        // per-shot QC over the take: a multi-shot segment slices per shot so
        // each shot's require judges its OWN frames (the anchor's require over
        // the whole take punished the chained shots — run5 live lesson); a solo
        // take judges whole
        const anchorLen = isMsSegment
          ? snapFramesPerShot(ctx.cutPlan!.shots.find((c) => c.id === shot.id)?.duration_s ?? 0)
          : snapDurationToFrames(shot.durationSec);
        const sliceBounds: { id: string; start: number; len: number }[] = [];
        let cursor = 0;
        for (const id of segShots) {
          const len = isMsSegment ? segBudget!.perShot : id === shot.id ? anchorLen : msGridFrames(framesPerShot);
          sliceBounds.push({ id, start: cursor, len });
          cursor += len;
        }
        const prevShot = ctx.stillPlans!.map((p) => p.shot).find((s, i, arr) => arr[i + 1]?.id === shot.id);
        for (const b of sliceBounds) {
          const reqPath = path.join(ctx.stillDir!, `${b.id}.require.json`);
          // CFORM7: the slice's require keeps the keyframe keys but its action is
          // the clip's temporal script, not the freeze line (motionClipRequire)
          const shotRequire: QcRequire = motionClipRequire(
            JSON.parse(fs.readFileSync(reqPath, "utf8")) as QcRequire,
            ctx.timed!.shots.find((s) => s.id === b.id),
          );
          const sliceJson = path.join(motionDir, `${b.id}.video_qc.json`);
          let sliceMp4 = mp4;
          if (segShots.length > 1) {
            sliceMp4 = path.join(motionDir, `${b.id}.qc.mp4`);
            await ffmpeg([
              "-i", mp4,
              "-vf", `trim=start_frame=${b.start}:end_frame=${b.start + b.len},setpts=PTS-STARTPTS`,
              "-an", "-c:v", "libx264", "-pix_fmt", "yuv420p",
              sliceMp4,
            ]);
          }
          let videoQc = await runVideoQc({
            mp4: sliceMp4,
            outJson: sliceJson,
            require: shotRequire,
            shotId: b.id,
            ...(segShots.length > 1
              ? { parent: { file: mp4, shotId: b.id, start: b.start, len: b.len } }
              : {}),
          });
          if (b.id === shot.id) {
            videoQc = await attachMemoryDistances(videoQc, {
              ep: ctx.job.slate,
              shot: b.id,
              outJson: sliceJson,
              character: shot.marks[0]?.characterId,
              prevStill: prevShot ? path.join(ctx.stillDir!, `${prevShot.id}.png`) : undefined,
              blockoutF0: path.join(ctx.blockoutDir!, `${shot.id}.f0.png`),
              midFrame: videoQc.frames[Math.floor(videoQc.frames.length / 2)]?.file,
            });
          }
          if (videoQc.status !== "GREEN") {
            const reasons = videoQc.checks.fail_reasons.join("; ") || "not GREEN";
            const redoRel = `seats/${b.id}.motion-redo.json`;
            fs.mkdirSync(path.join(jobDir(jobId), "seats"), { recursive: true });
            fs.writeFileSync(jobFile(jobId, redoRel), JSON.stringify({
              owner: "motion",
              shot: b.id,
              reasons: videoQc.checks.fail_reasons,
            }, null, 2));
            await speak("motion", `${b.id} motion 眼 FAIL（${reasons}）— clip 留低，未交付。`, "fail");
          } else {
            await speak("motion", `${b.id} motion 眼 GREEN`, "pass");
          }
          emit(jobId, {
            agent: "motion",
            level: "info",
            message: `${b.id} motion 完成${segShots.length > 1 ? `（跨shot段 ${segId} 切片 ${b.start}+${b.len}f）` : ""}`,
            data: {
              shot: b.id, stage: "motion", eye: "motion", verdict: videoQc.status === "GREEN" ? "pass" : "fail",
              proof: `motion/${segId}.mp4`, ms: Date.now() - motionStarted,
            },
            step_id: "motion",
            parent_steps: ["require"],
            seat: "motion",
          });
        }
  } catch (err) {
    // 0927 停法手術（照 ViMax REPL 唔死）：呢鏡材料／閘缺＝blocked skip，繼續其他鏡。
    // 淨認呢啲已知材料缺 signature；基建錯（HTTP/ffmpeg/schema crash）照舊向上拋，
    // 唔可以靜靜食埋。
    const msg = err instanceof Error ? err.message : String(err);
    const materialMissing = /photo_qc 未 GREEN|keyframe_positions_missing|identity_sheet_missing|C-form 冇|angle_portrait_missing|身份成張未齊|multishot段要一張未切成張/.test(msg);
    if (!materialMissing) throw err;
    emit(jobId, {
      agent: "motion", level: "warn",
      message: `${shot.id} blocked（${msg}）——繼續其他鏡`,
      data: { shot: shot.id, stage: "motion", blocked: msg },
    });
    continue;
  }
    }
    ctx.job = patch(ctx.job, {
      providers: trace,
      vault: vaultStats(jobId),
      progress: 70,
      outputs: {
        ...ctx.job.outputs,
        shots: shotVideos.map((f) => relInJob(jobId, f)),
        receipts,
      },
    });
    // --scene/--only hop: mux 該範圍 only → preview mp4；唔走全 slate concat
    if (input.scene || input.only) {
      const previewDir = path.join(jobDir(jobId), "preview");
      ensureDir(previewDir);
      const muxed: string[] = [];
      const concatWavHop = async (wavs: string[], out: string): Promise<string> => {
        const list = out.replace(/\.wav$/, ".wavlist.txt");
        fs.writeFileSync(list, wavs.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
        return out;
      };
      // hop targets: manifest segments touching this scene, then solo shots
      const hopSet = new Set(motionShots.map((s) => s.id));
      const targets: { id: string; shots: string[] }[] = [];
      for (const seg of segManifest ?? []) {
        if (seg.shots.some((id) => hopSet.has(id))) targets.push({ id: seg.shots.join("-"), shots: seg.shots });
      }
      for (const id of motionShots.map((s) => s.id)) {
        if (!(segManifest ?? []).some((seg) => seg.shots.includes(id))) targets.push({ id, shots: [id] });
      }
      for (const t of targets) {
        const mp4 = shotVideos.find((v) => path.basename(v, ".mp4") === t.id);
        // 0927 停法手術：motion 段 blocked（per-shot skip 落嚟冇 mp4）→呢段 mux
        // blocked skip 繼續其他段；wav 缺同罪。收據落 events，唔殺 hop。
        const wavs = t.shots.map((sid) => ctx.h3WavByShot.get(sid));
        if (!mp4 || wavs.some((w) => !w)) {
          emit(jobId, {
            agent: "motion", level: "warn",
            message: `hop ${input.scene ?? input.only}: ${!mp4 ? `motion 缺 ${t.id}` : `${t.id} wav 缺`}——呢段 blocked，繼續其他段`,
            data: { stage: "mux", blocked: !mp4 ? `motion-missing:${t.id}` : `wav-missing:${t.id}` },
          });
          continue;
        }
        const wav = t.shots.length === 1
          ? wavs[0]!
          : await concatWavHop(wavs as string[], path.join(motionDir, `${t.id}.wav`));
        const out = path.join(motionDir, `${t.id}.muxed.mp4`);
        await ffmpeg(muxArgs(mp4, wav, out));
        muxed.push(out);
      }
      const muxList = path.join(previewDir, "mux-list.txt");
      fs.writeFileSync(muxList, muxed.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));
      const previewMp4 = path.join(previewDir, `${input.scene ?? input.only}.preview.mp4`);
      await ffmpeg(concatCopyArgs(muxList, previewMp4));
      ctx.job = patch(ctx.job, {
        status: "motion-ready",
        currentAgent: "motion",
        progress: 75,
        outputs: {
          ...ctx.job.outputs,
          shots: shotVideos.map((f) => relInJob(jobId, f)),
          receipts,
          scenePreview: relInJob(jobId, previewMp4),
        },
      });
      emit(jobId, {
        agent: "motion",
        level: "pass",
        message: `--scene ${input.scene ?? input.only} hop 完：${motionShots.length} 鏡已 mux → preview/${input.scene ?? input.only}.preview.mp4。下一場再 --scene。`,
        data: { scene: input.scene ?? input.only, shots: motionShots.map((s) => s.id), preview: `preview/${input.scene ?? input.only}.preview.mp4` },
      });
      return;
    }

    // voice: spine given, or concat slices with gap silence; plugs may be AuK takes
    await think("voice");
    const aukShots = ctx.plugged!.filter((p) => p.source === "auk" || p.source === "event");
    await speak(
      "voice",
      ctx.locked!.audioEvents?.length
        ? `聲音事件 ${ctx.locked!.audioEvents.length} 句（各一條連續 take，切片播過 ${aukShots.length} 鏡；clone 跟 ${ctx.cloneRef! ? "job ref" : "tts.promptWav"}）——切鏡唔重播、講者唔改成聽者。`
        : aukShots.length
          ? `聲軌 wav plug＋AuK 出 ${aukShots.length} 鏡 VO（對白跟 continuity，clone 跟 ${ctx.cloneRef! ? "job ref" : "tts.promptWav"}）：${aukShots.map((s) => s.shotId).join("、")}`
          : "聲軌係 wav plug：spine.wav 或者逐鏡切片加 gap。",
    );
    let spineFile = ctx.spineWav;
    if (!spineFile) {
      spineFile = path.join(ctx.audioDir!, "spine.wav");
      const orderedWavs = ctx.cutPlan!.shots.map((s) => s.wav);
      if (ctx.gapSec! > 0 && orderedWavs.length > 1) {
        const fmt = await runCommand("ffprobe", [
          "-v", "error", "-select_streams", "a:0",
          "-show_entries", "stream=sample_rate,channels", "-of", "json", orderedWavs[0]!,
        ]);
        if (fmt.code !== 0) throw new Error(fmt.stderr || "ffprobe wav fmt failed");
        const st = (JSON.parse(fmt.stdout).streams ?? [])[0] as { sample_rate?: string; channels?: string };
        const gapWav = path.join(ctx.audioDir!, "gap.wav");
        await ffmpeg([
          "-f", "lavfi", "-i", `anullsrc=r=${st.sample_rate ?? 24000}:cl=${st.channels ?? 1}`,
          "-t", String(ctx.gapSec!), "-c:a", "pcm_s16le", gapWav,
        ]);
        const list2 = [orderedWavs[0]!];
        for (const w of orderedWavs.slice(1)) list2.push(gapWav, w);
        const concatGap = path.join(ctx.audioDir!, "spine-list.txt");
        fs.writeFileSync(concatGap, list2.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", concatGap, "-c", "copy", spineFile]);
      } else {
        const concatList = path.join(ctx.audioDir!, "spine-list.txt");
        fs.writeFileSync(concatList, orderedWavs.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", spineFile]);
      }
    }
    const spokenRows = ctx.plugged!.filter((p) => p.source === "auk" || p.source === "event");
    trace.tts = ctx.locked!.audioEvents?.length
      ? `audio events ×${ctx.locked!.audioEvents.length}（一句一 take 切片）${spokenRows.length ? `，播過 ${spokenRows.length} 鏡` : ""}`
      : spokenRows.some((p) => p.source === "auk")
        ? `AuK auto VO ×${spokenRows.length}${input.wavDir && fs.existsSync(path.join(input.wavDir, "sentences.json")) ? " + plug slices" : ""}`
        : input.wavDir && fs.existsSync(path.join(input.wavDir, "sentences.json"))
          ? "wav plug (AuK slices, natural pace)"
          : "wav plug";
    ctx.job = patch(ctx.job, { providers: trace, progress: 76, outputs: { ...ctx.job.outputs, voice: "audio/spine.wav" } });
    upsertDoc({
      id: "audio:vo",
      slate: jobId,
      modality: "audio",
      text: ctx.timed!.voiceover,
      absPath: spineFile,
    });

    // sound QC on the DELIVERED audio: concat of the padded per-shot wavs —
    // this is the track actually muxed into the lock, spine only feeds the gate
    const lockAudio = jobFile(jobId, "delivery", "lock-audio.wav");
    const lockList = path.join(ctx.audioDir!, "lock-list.txt");
    fs.writeFileSync(
      lockList,
      ctx.cutPlan!.shots.map((s) => `file '${ctx.h3WavByShot.get(s.id)!.replaceAll("'", "'\\''")}'`).join("\n"),
    );
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", lockList, "-c:a", "pcm_s16le", lockAudio]);
    await think("soundQc");
    await speak("soundQc", "SenseVoice 對稿（delivery/lock-audio.wav）：ASR、情緒、事件、WER、Clipping。");
    // A3 fail-loud: no endpoint, or an unreachable ear = FAIL "unconfigured".
    // Never a schema stand-in for the SenseVoice verdict.
    const earConfigured = cfg.soundQc.endpoint.trim().length > 0;
    const wavCheck = earConfigured ? wavPrecheck({ audioFile: lockAudio }) : null;
    const remoteSv = earConfigured ? await senseVoiceHttp(lockAudio).catch(() => null) : null;
    // PROVENANCE_0927：期望稿對「聲音事件序」——一句跨鏡只計一次（衍生欄
    // 喺兩鏡都見到成句，直接 join 會重複）；舊 callsheet 冇事件先 join 鏡序。
    const expectedSpeech = ctx.timed!.audioEvents?.length
      ? ctx.timed!.audioEvents.map((e) => e.text).join(" ")
      : ctx.timed!.shots.map((s) => s.dialogue.trim()).filter(Boolean).join(" ");
    const sound = !earConfigured
      ? soundQcUnconfigured()
      : remoteSv && wavCheck
        ? soundQcFromRemote({
            remote: remoteSv,
            expectedText: expectedSpeech,
            // 裁決 0928 §4：方案冇 emotion 指定→唔傳（標未指定）；
            // cloneSimilarity 冇量度→null＋note（soundQcFromRemote 內處理）
            wav: wavCheck,
          })
        : soundQcUnconfigured(`sensevoice ${cfg.soundQc.endpoint} unreachable or unparseable`);
    trace.senseVoice = earConfigured && remoteSv ? "SenseVoice HTTP" : "SenseVoice FAIL (unconfigured)";
    fs.writeFileSync(jobFile(jobId, "delivery", "sound-qc.json"), JSON.stringify({
      scope: "delivered-dialogue", expectedText: expectedSpeech,
      audio: "delivery/lock-audio.wav", result: sound,
    }, null, 2));
    ctx.job = patch(ctx.job, { soundQc: sound, providers: trace, progress: 82 });
    await speak("soundQc", `Sound QC ${sound.pass ? "PASS" : "FAIL"}  peak ${sound.peak.toFixed(2)}  silence ${sound.silenceRatio.toFixed(2)}`, sound.pass ? "pass" : "fail");

    // §8.3：revision guard——cut_plan/audio-timeline 兩份收據同源比對（同 world
    // 段生成時點鎖定）；唔夾＝半寫入/人手改過，具名邊份過期，唔准混做交付。
    {
      const cutPlanReceipt = JSON.parse(fs.readFileSync(jobFile(jobId, "cut_plan.json"), "utf8")) as { callsheetDigest?: string };
      // §9⑥：三比＋缺檔/缺欄即 throw（聲音時間線路徑必須存在且有效；兩份同舊
      // 版本互相等都過唔到——要對得上本輪凍結 ctx.callsheetDigest）
      const tlFile = path.join(jobDir(jobId), "creative", "audio-timeline.json");
      if (!fs.existsSync(tlFile) || !cutPlanReceipt.callsheetDigest) {
        throw new Error("revision_guard: audio-timeline.json 缺檔或 cut_plan 收據缺 callsheetDigest——聲音路徑收據必須存在且有效");
      }
      const tlReceipt = JSON.parse(fs.readFileSync(tlFile, "utf8")) as { callsheetDigest?: string };
      if (!tlReceipt.callsheetDigest || !ctx.callsheetDigest) {
        throw new Error("revision_guard: 收據缺 callsheetDigest（audio-timeline 或本輪凍結快照）——無效收據唔准過");
      }
      if (cutPlanReceipt.callsheetDigest !== tlReceipt.callsheetDigest || cutPlanReceipt.callsheetDigest !== ctx.callsheetDigest) {
        throw new Error(
          `revision_mismatch: cut_plan.json（digest ${(cutPlanReceipt.callsheetDigest ?? "missing").slice(0, 12)}）與 audio-timeline.json（digest ${(tlReceipt.callsheetDigest ?? "missing").slice(0, 12)}）唔同源——邊份過期見 callsheetDigest，唔准混做最終交付`,
        );
      }
    }
    // editor: machine gate, per-shot mux (own wav, drop H3 audio), concat only after gate
    // MULTISHOT_WIRE: a multi-shot segment muxes ONCE against its concatenated
    // wav — the segment is one continuous take
    await think("editor");
    const toEditor = seal({
      slate: jobId,
      from: "boards",
      to: "editor",
      payload: { cut: ctx.continuity!.cut },
    });
    const { cut } = open(toEditor, { slate: jobId, to: "editor" });
    await speak("editor", `${packetLine(toEditor)} · 照分鏡接：${cut.join(" → ")}。唔重排。`);
    const segGateSegments = segManifest?.length ? segManifest : undefined;
    const gate = await checkGate({
      plan: ctx.cutPlan!,
      motionDir,
      spineWav: fs.existsSync(spineFile) ? spineFile : undefined,
      outFile: jobFile(jobId, "concat_gate.json"),
      ...(segGateSegments ? { segments: segGateSegments.map((s) => ({ shots: s.shots, frames: s.frames, perShot: s.perShot, kind: s.kind })) } : {}),
    });
    if (!gate.ok) {
      throw new Error(`concat gate FAIL: ${gate.reason}`);
    }
    const concatWav = async (wavs: string[], out: string): Promise<string> => {
      const list = out.replace(/\.wav$/, ".wavlist.txt");
      fs.writeFileSync(list, wavs.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
      return out;
    };
    // mux targets in cut order: manifest segments first, then legacy solo files
    const inManifest = new Set((segManifest ?? []).flatMap((s) => s.shots));
    const muxTargets = [
      ...(segManifest ?? []).map((s) => ({ id: s.shots.join("-"), shots: s.shots })),
      ...cut.filter((id) => !inManifest.has(id)).map((id) => ({ id, shots: [id] })),
    ].sort((a, b) => cut.indexOf(a.shots[0]!) - cut.indexOf(b.shots[0]!));
    const muxed: string[] = [];
    for (const t of muxTargets) {
      const mp4 = shotVideos.find((v) => path.basename(v, ".mp4") === t.id)
        ?? path.join(motionDir, `${t.id}.mp4`);
      // 0927 停法手術：motion 段 blocked（per-shot skip 落嚟冇 mp4）→呢段 mux
      // blocked skip 繼續其他段；wav 缺同罪。成片少嗰段係事實，events 有列明。
      const wavs = t.shots.map((id) => ctx.h3WavByShot.get(id));
      if (!fs.existsSync(mp4) || wavs.some((w) => !w)) {
        emit(jobId, {
          agent: "motion", level: "warn",
          message: `${!fs.existsSync(mp4) ? `cut ${t.id} missing from motion` : `${t.id} wav 缺`}——呢段 blocked，繼續其他段`,
          data: { stage: "mux", blocked: !fs.existsSync(mp4) ? `motion-missing:${t.id}` : `wav-missing:${t.id}` },
        });
        continue;
      }
      const wav = t.shots.length === 1
        ? wavs[0]!
        : await concatWav(wavs as string[], path.join(motionDir, `${t.id}.wav`));
      const marked = segManifest?.find((s) => s.shots.join("-") === t.id);
      const clockWav = marked?.frames
        ? path.join(motionDir, `${t.id}.clock.wav`)
        : wav;
      if (marked?.frames) await padH3Wav(wav, clockWav, marked.frames);
      const out = path.join(motionDir, `${t.id}.muxed.mp4`);
      await ffmpeg(muxArgs(mp4, clockWav, out));
      muxed.push(out);
    }
    const muxList = jobFile(jobId, "motion", "mux-list.txt");
    fs.writeFileSync(muxList, muxed.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));
    const pictureLock = jobFile(jobId, "delivery", "picture-lock.mp4");
    await ffmpeg(concatCopyArgs(muxList, pictureLock));

    const markGeometry = localPictureQc({
      stills: ctx.stills,
      sheet: input.scene ? { ...ctx.timed!, shots: shotsForScene(ctx.timed!.shots, input.scene) } : ctx.timed!,
      target: "video",
    });
    // video_qc pins are per SHOT (segment slices pin under their own ids)
    const videoQcPass = cut.every((id) => pinVideoQcAccepted(motionDir, id));
    ctx.job = patch(ctx.job, {
      pictureQcVideo: markGeometry,
      progress: 92,
      outputs: { ...ctx.job.outputs, concatGate: "concat_gate.json", pictureLock: "delivery/picture-lock.mp4" },
    });

    await think("delivery");
    await speak("delivery", "交片包：mp4 + continuity + QC + Blender。故事＝分鏡＝剪接。");
    const deliveredSec = await mediaSeconds(pictureLock);
    const report = {
      slate: ctx.job.slate,
      title: ctx.timed!.title,
      cut: ctx.continuity!.cut,
      providers: trace,
      // measured off the delivered mp4, not the planned sum
      delivered_s: deliveredSec,
      planned_s: ctx.timed!.durationSec,
      provenance: ctx.timed!.provenance,
      soundQc: sound,
      pictureQcStills: ctx.geometry!,
      markGeometry,
      // the padded tail per shot IS the delivered speech gap
      gap_delivered_s: Object.fromEntries(ctx.gapDelivered),
      locked: Boolean(sound.pass && videoQcPass),
    };
    // §9⑤：統一 completion verdict——所有必要條件先合成一個答案，report/job/
    // 交付事件食同一個（placementGaps＋必要 blockedShots 都入；preview 可以
    // 存在但對外驗收欄位一致，唔准 job blocked 而 delivery locked）
    const completeVerdict = report.locked
      && !(ctx.job.placementGaps ?? []).length
      && !(ctx.job.blockedShots ?? []).length;
    report.locked = completeVerdict;
    fs.writeFileSync(jobFile(jobId, "delivery", "qc.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(jobFile(jobId, "delivery", "callsheet.md"), markdownCallSheet(ctx.timed!, ctx.job.slate));
    // §8.2：placementGaps 未清（額度耗盡或未修）＝唔准 locked——preview 可以
    // 存在但 job/delivery 唔冒充已驗收（照 §7/§8「blocked 唔係 failed」）
    const pictureLocked = report.locked && !(ctx.job.placementGaps ?? []).length;
    ctx.job = patch(ctx.job, {
      status: pictureLocked ? "locked" : "blocked",
      progress: 100,
      currentAgent: "delivery",
      providers: trace,
      vault: vaultStats(jobId),
      outputs: {
        ...ctx.job.outputs,
        pictureLock: "delivery/picture-lock.mp4",
        qcReport: "delivery/qc.json",
        callSheet: "delivery/callsheet.md",
        continuity: "delivery/continuity.md",
        narrativePlan: "narrative-plan.json",
        vault: "vault.json",
        blenderScript: "blender/blocking.py",
      },
    });
    emit(jobId, {
      agent: "delivery",
      level: pictureLocked ? "pass" : "warn",
      message: pictureLocked ? "Picture lock. 故事＝分鏡＝剪接。" : "成片已出，但 QC 未全過，狀態係 blocked。",
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ctx.job = patch(ctx.job, { status: "failed", error: message });
    // D1a: the throw site also lands a hard row (zod / pipeline) — the soft
    // rows written earlier in topological order already sit above it
    appendViolation(jobDir(jobId), hardErrorRow(error));
    emit(jobId, { agent: "system", level: "error", message });
    // V1（PLAN-v2 0928）：runReflector 自動調用已移除——判斷唔升格做規則（讀側
    // 0927 §11 已斷，寫側呢度斬埋；seats/*.primitive.md 留做 job 收據）。
    // 失敗真相全保：error message／violations 硬行／events 已寫齊。
  } finally {
    // V2a：執行權交返（正常完／fail／blocked 都 release；owner.json 留底）
    setActiveOwner(undefined);
    releaseJob(jobId);
  }
}

function markdownCallSheet(sheet: CallSheet, slate: string) {
  return `# ${slate}  ${sheet.title}

${sheet.logline}

- Location: ${sheet.location}
- Time: ${sheet.timeOfDay} / ${sheet.weather}
- Mood: ${sheet.mood}
- Duration: ${sheet.durationSec}s ${sheet.aspect}
- Stills: ${sheet.styleBible.stillModel}
- Motion: ${sheet.styleBible.motionModel}
- Grade: ${sheet.styleBible.grade}

## Cast
${sheet.characters.map((c) => `- ${c.name} (${c.role}) — ${c.wardrobe}`).join("\n")}

## Shots
${sheet.shots
  .map(
    (s) => `### ${s.id}  ${s.size}  ${s.camera.lensMm}mm
${s.action}
${s.dialogue ? `> ${s.dialogue}` : ""}
Marks: ${s.marks.map((m) => `${m.characterId} ${m.gait}`).join(", ")}`,
  )
  .join("\n\n")}
`;
}
