import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { blenderBlockingScript } from "./blender";
import { readWavMono, runCommand } from "./audio";
import { emit, readJob, writeJob } from "./store";
import { renderBlockingSvg, sceneSize } from "./painter";
import { localPictureQc, senseVoiceHttp, soundQcFromRemote, soundQcUnconfigured, wavPrecheck } from "./providers";
import { shouldWaitEarnLock, waitEarnGpuLock } from "./earn-gpu-lock";import { loadConfig, type SlateConfig } from "./config";
import type { AgentId, CallSheet, JobRecord, ProduceInput, ProviderTrace, Shot } from "./types";
import { floorLine, seat } from "./crew";
import { assertSameCanon, continuityMarkdown, lockContinuity } from "./continuity";
import { open, packetLine, seal } from "./dispatch";
import { buildNarrativePlan, planMarkdown } from "./narrative";
import { indexPlanTexts, recall, upsertDoc, vaultStats } from "./vault";
import { relInJob } from "./isolate";
import { loadCallSheet } from "./writer";
import { runWriter } from "./seat-writer";
import { runBoards } from "./seat-boards";
import { chatJson, SchemaMismatchError } from "./crew-llm";
import { BOARDS_CHARTER } from "./seat-charters";
import { ensurePortraits } from "./portraits";
import { ensureDir, jobDir, jobFile, projectsDir, seatsDir } from "./paths";
import { runReflector } from "./reflector";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { buildCutPlan, type CutPlan } from "./cut-plan";
import { checkGate } from "./concat-gate";
import { writeAnchors } from "./dhash-anchors";
import { assertFiguresVisible, blockoutFromPlug, extractFrame0, renderBlockout, stillFrameFor } from "./blockout";
import { isLocationFail, keyframeEditPrompt, keyframeRequire, loadBaseCast, needsShotFacts, sceneRetryNormalize, sceneRetrySchema, sceneRetryUser } from "./keyframe-prompt";
import { runPeStep } from "./pe-step";
import { buildProse, buildProsePositive, validateProse, wardrobeClauses, SCRIPT_HEADER } from "./h3-prose";
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
  motionSegments,
  parseCombatSweepRanking,
  selectMotions,
  snapFramesPerShot,
  writeSelections,
  type MotionSelection,
  type MotionShotLine,
} from "./motion-select";
import { assertNativeFfmpeg, concatCopyArgs } from "./native-cut";
import { checkHealth, buildEditPayload, u15Edit, MAX_IMAGES, type EditPayload, type U15EditRecord } from "./u15-edit";
import { scpToHost, u15RefPath } from "./scp-upload";
import { runPhotoQc, pinQcAccepted, photoQcEyesFromEnv, type QcRequire } from "./photo-qc";
import { buildQcSheet, buildQcSheetHtml, readQcReceipt } from "./qc-sheet";
import { pinVideoQcAccepted, runVideoQc } from "./video-qc";
import { attachMemoryDistances, ingestStill, queryRefs } from "./memory";
import { appendViolation, checkBoardsToKeyframe, checkKeyframeToStills, hardErrorRow, hardPhotoQcRow } from "./trace";
import { rangesFor } from "./script-contract";

function patch(job: JobRecord, partial: Partial<JobRecord>) {
  const next = { ...job, ...partial };
  writeJob(next);
  return next;
}

function h3GraphVariant(input: ProduceInput): H3GraphVariant {
  return input.graphVariant ?? "a";
}

function prevShotOf(sheet: CallSheet, shot: Shot): Shot | undefined {
  const i = sheet.shots.findIndex((s) => s.id === shot.id);
  return i > 0 ? sheet.shots[i - 1] : undefined;
}

function writeH3Plan(
  jobId: string,
  timed: CallSheet,
  shot: Shot,
  wiring: {
    wav: string;
    blockout?: string;
    still: string;
    kfStart?: string;
    kfEnd?: string;
    refImageFiles?: string[];
    anglePortraits?: AnglePortrait[];
  },
) {
  const prev = prevShotOf(timed, shot);
  // plugged portraits live outside the slate — keep their absolute path
  const relOrAbs = (p: string) => {
    try {
      return relInJob(jobId, p);
    } catch {
      return p;
    }
  };
  const plan = planH3Shot({
    shot,
    prev,
    wav: relInJob(jobId, wiring.wav),
    blockout: wiring.blockout ? relInJob(jobId, wiring.blockout) : undefined,
    ourStill: relInJob(jobId, wiring.still),
    anglePortraits: wiring.anglePortraits?.map((p) => ({ ...p, file: relOrAbs(p.file) })),
  });
  assertH3Plan(plan);
  assertH3SubmitWiring(plan, {
    kfStart: wiring.kfStart,
    kfEnd: wiring.kfEnd,
    wav: wiring.wav,
    blockout: wiring.blockout,
    refImageFiles: wiring.refImageFiles,
    prevShotId: prev?.id,
  });
  fs.mkdirSync(path.dirname(jobFile(jobId, "motion", `${shot.id}.h3_plan.json`)), { recursive: true });
  fs.writeFileSync(jobFile(jobId, "motion", `${shot.id}.h3_plan.json`), JSON.stringify(plan, null, 2));
  return plan;
}

/** §5b C-form identity refs: one angle-version portrait per marked character,
 *  left-to-right, the refAngle column picking front/45°. The 45° version
 *  comes from the job portraits dir or a plug dir ({id}_45.png, WR1Q shape);
 *  a 45° shot without it fails loud — the frontal version drags the face back
 *  to camera (the B-lane regression). */
export function anglePortraitsFor(
  shot: Shot,
  portraitFiles: Record<string, string>,
  portraitDir?: string,
  plugDir?: string,
): AnglePortrait[] {
  const ordered = [...new Set([...shot.marks].sort((a, b) => a.start.x - b.start.x).map((m) => m.characterId))];
  const find = (name: string) =>
    [portraitDir, plugDir].map((d) => (d ? path.join(d, name) : "")).find((p) => p && fs.existsSync(p));
  return ordered.map((id) => {
    const angle: "front" | "45" = shot.refAngle === "45" ? "45" : "front";
    if (angle === "45") {
      const angled = find(`${id}_45.png`);
      if (angled) return { characterId: id, angle, file: angled };
      throw new Error(
        `angle_portrait_missing: ${shot.id} refAngle=45 需要 ${id}_45.png（45°角度版肖像）— 正面版會將個面拉返向鏡頭（B-lane regression），唔准頂`,
      );
    }
    const fromMap = portraitFiles[id];
    if (fromMap && fs.existsSync(fromMap)) return { characterId: id, angle, file: fromMap };
    const onDisk = find(`${id}.png`);
    if (onDisk) return { characterId: id, angle, file: onDisk };
    throw new Error(`${shot.id}: C-form 冇${id}肖像 — ref_image_0 身份ref缺件（首次出場要有肖像）`);
  });
}

export function h3MotionPack(
  timed: CallSheet,
  shot: Shot,
  variant: H3GraphVariant,
  stillPng: string,
  portraitFiles: Record<string, string>,
  prev?: Shot,
  opts?: { hasVideo1?: boolean; portraitDir?: string; plugDir?: string },
) {
  // §5b: the Video 1 asset routes the form. Motion shots carry a blockout
  // (the blockout lane renders one per shot) → C-form; a shot with no Video 1
  // asset stays A-form still-to-video (H3Keyframes 0%/100%).
  const hasVideo1 = opts?.hasVideo1 !== false;
  if (variant === "a") {
    if (!shot.uiShot) {
      if (hasVideo1) {
        // story motion shot, C-form: identity = angle portraits on ref_images
        const anglePortraits = anglePortraitsFor(shot, portraitFiles, opts?.portraitDir, opts?.plugDir);
        return {
          prose: buildProse(timed, shot, { prevLocation: prev?.location, form: "c" }),
          refImageFiles: anglePortraits.map((p) => p.file),
          anglePortraits,
          uiPhotoFiles: undefined as string[] | undefined,
          kfEnd: undefined as string | undefined,
        };
      }
      // no Video 1 asset: still-to-video — keyframes two ends, zero refs
      return {
        prose: buildProse(timed, shot, { prevLocation: prev?.location, form: "a" }),
        refImageFiles: undefined as string[] | undefined,
        anglePortraits: [] as AnglePortrait[],
        uiPhotoFiles: undefined as string[] | undefined,
        kfEnd: stillPng,
      };
    }
    // card ③b: UI/infographic shot — photo refs ride ref_images (law: 文字圖／
    // 手機畫面等 UI 反而可以俾 H3 ref) and the prose carries the mapping
    // table. uiShot is the only gate: story shots with stray uiRefs stay
    // ref-free. On the C-form the ui board keeps <Picture 1>; no keyframes.
    return {
      prose: buildProse(timed, shot, { ui: shot.uiSpec ?? {}, form: hasVideo1 ? "c" : "a" }),
      refImageFiles: undefined as string[] | undefined,
      anglePortraits: [] as AnglePortrait[],
      uiPhotoFiles: shot.uiRefs ?? [] as string[],
      kfEnd: hasVideo1 ? undefined : stillPng,
    };
  }
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const portraits = ids
    .map((id) => {
      const c = timed.characters.find((ch) => ch.id === id);
      return c ? { id, name: c.name } : null;
    })
    .filter((p): p is { id: string; name: string } => Boolean(p));
  const refImageFiles =
    variant === "b" || variant === "bkf"
      ? [stillPng, ...ids.map((id) => portraitFiles[id]).filter((p) => p && fs.existsSync(p))]
      : undefined;
  return {
    prose: buildProsePositive(timed, shot, { motionOnly: variant === "c", portraits }),
    refImageFiles,
    anglePortraits: [] as AnglePortrait[],
    uiPhotoFiles: undefined as string[] | undefined,
    kfEnd: undefined as string | undefined,
  };
}

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

async function ffmpeg(args: string[]) {
  const result = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "ffmpeg failed");
  }
}

/** Runtime of a delivered file as the container reports it. */
async function mediaSeconds(file: string): Promise<number> {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", file,
  ]);
  if (r.code !== 0) throw new Error(r.stderr || `ffprobe failed on ${file}`);
  const d = Number((JSON.parse(r.stdout).format ?? {}).duration);
  if (!Number.isFinite(d)) throw new Error(`ffprobe: no duration for ${file}`);
  return Number(d.toFixed(3));
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

/** C-scene-hop: `--scene SCxx` narrows the stills/picture-QC lanes and the H3
 *  lane to one scene's shots (scene field, else beatId prefix `SCxx.`).
 *  Omitted = every shot, the existing whole-slate path. Zero matches throws —
 *  never silently fall back to burning the full slate. */
export function shotsForScene(shots: Shot[], scene?: string): Shot[] {
  if (!scene) return shots;
  const kept = shots.filter(
    (s) => s.scene === scene || (s.beatId ?? "").startsWith(`${scene}.`),
  );
  if (!kept.length) {
    throw new Error(`--scene ${scene}：一鏡都對唔上（冇 shot 嘅 scene／beatId 係 ${scene}）— 唔靜靜哋燒成個 slate`);
  }
  return kept;
}

/** g6 hop geometry: a `--scene` hop's stills + picture-QC lanes only make the
 *  hop's shots, so the plan-geometry pre-check must score the hop's shots —
 *  never the full slate's list, which cried "Missing stills vs shot list" on a
 *  healthy SC01 hop (LD0F). Same no-match throw as the H3 crop. */
export function hopGeometrySheet(sheet: CallSheet, scene?: string): CallSheet {
  return scene ? { ...sheet, shots: shotsForScene(sheet.shots, scene) } : sheet;
}

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

/** Speaking parts must be castable, so the roster is read from a data file the
 *  operator points at — never from a list living in src. */
function readCastRoster(file?: string): string[] {
  if (!file) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { cast?: { name?: string }[] };
  const names = (raw.cast ?? []).map((c) => c.name).filter((n): n is string => Boolean(n));
  if (!names.length) throw new Error(`--cast-roster ${file} lists no names`);
  return names;
}

type SeatVoice = {
  speak: (agent: AgentId, message: string, level?: "info" | "warn" | "pass" | "fail") => Promise<void>;
  think: (agent: AgentId) => Promise<void>;
};

/** Where the callsheet comes from: a resumed slate, the plug (factory tests
 *  only), or — by default now — 阿文 and 阿圖 actually writing it. */
async function authorCallSheet(
  jobId: string,
  input: ProduceInput,
  cfg: SlateConfig,
  io: SeatVoice,
): Promise<CallSheet> {
  const existing = path.join(jobDir(jobId), "callsheet.json");
  if (input.resume && fs.existsSync(existing)) {
    const sheet = loadCallSheet(existing);
    await io.speak("producer", `resume：照返 callsheet.json（${sheet.shots.length} 鏡），唔重開檯。`);
    return sheet;
  }
  if (input.callSheetPath) {
    const sheet = loadCallSheet(input.callSheetPath);
    await io.speak("producer", `callsheet plug 載入：${sheet.shots.length} 鏡。`);
    return sheet;
  }
  const targetSec = input.durationSec ?? 600;
  const receiptDir = path.join(jobDir(jobId), "seats");
  const index = (doc: { id: string; text: string; shotId?: string }) => {
    upsertDoc({ id: doc.id, slate: jobId, modality: "text", shotId: doc.shotId, text: doc.text });
  };

  await io.think("writer");
  await io.speak("writer", `寫故事同對白。${cfg.crew.writerModel} · 目標 ${targetSec}s。`);
  const writer = await runWriter(
    {
      brief: input.brief,
      targetSec,
      language: input.language,
      castRoster: readCastRoster(input.castRosterPath),
    },
    {
      crew: cfg.crew,
      model: cfg.crew.writerModel,
      receiptDir,
      speak: (thinking) => io.speak("writer", thinking),
      index,
      playbookDir: seatsDir(),
    },
    rangesFor(targetSec),
  );

  await io.think("boards");
  await io.speak("boards", `拆鏡。${cfg.crew.boardsModel} · ${writer.script.outline.scenes.length} 場。`);
  const boards = await runBoards(
    {
      script: writer.script,
      targetSec,
      aspect: input.aspect,
      writer: { model: writer.model, receipts: writer.receipts },
    },
    {
      crew: cfg.crew,
      model: cfg.crew.boardsModel,
      receiptDir,
      speak: (thinking) => io.speak("boards", thinking),
      index,
      playbookDir: seatsDir(),
    },
  );
  return boards.sheet;
}

export async function runPipeline(jobId: string, input: ProduceInput) {
  const initial = readJob(jobId);
  if (!initial) throw new Error("missing job");
  if (!input.wavDir && input.until !== "boards") {
    throw new Error("--wav-dir <dir> is required (one SHxx.wav per shot)");
  }
  let job: JobRecord = initial;
  const cfg = loadConfig();
  const trace: ProviderTrace = {
    stills: `U1.5 /edit ${cfg.stills.url}`,
    motion: `H3 R2V ${cfg.motion.comfyUrl}`,
    tts: "wav plug",
    senseVoice: cfg.soundQc.endpoint ? "SenseVoice HTTP" : "SenseVoice unconfigured",
    mars: `qwen38 ${cfg.pictureQc.endpoint}`,    blender: "pending",
    lipSync: "none — H3 audio dropped; own wav muxed",
  };

  const speak = async (agent: AgentId, message: string, level: "info" | "warn" | "pass" | "fail" = "info") => {
    const who = seat(agent);
    job = patch(job, { currentAgent: agent, status: "running" });
    emit(jobId, {
      agent,
      level,
      message: `${who.name}／${who.job} · ${message}`,
      data: { name: who.name, job: who.job, thinking: who.thinking },
    });
  };

  const think = async (agent: AgentId) => {
    const who = seat(agent);
    emit(jobId, {
      agent,
      level: "info",
      message: `想：${who.thinking}`,
      data: { name: who.name, thinking: who.thinking },
    });
  };

  try {
    await think("producer");
    // L1b: the producer is the only writer of the lifetime ids — a job that
    // names its drama runs in that drama's base layer, its episode's surface
    // playbooks, and its base cast wardrobe facts
    if (input.drama || input.episode) {
      job = patch(job, {
        ...(input.drama ? { drama: input.drama } : {}),
        ...(input.episode ? { episode: input.episode } : {}),
      });
    }
    await speak(
      "producer",
      `收 brief。開呢份 slate 嘅信封。舊 project 唔入袋。${input.drama ? `劇目 ${input.drama}${input.episode ? `・${input.episode}` : ""}。` : ""}`,
    );
    const sheet = await authorCallSheet(jobId, input, cfg, { speak, think });
    fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(sheet, null, 2));
    job = patch(job, {
      callSheet: sheet,
      providers: trace,
      progress: 8,
      outputs: { ...job.outputs, callSheet: "callsheet.json" },
    });
    await speak(
      "producer",
      `${sheet.title} · ${sheet.durationSec.toFixed(1)}s · ${sheet.shots.length} shots · ${sheet.location}`,
    );

    const toBoards = seal({
      slate: jobId,
      from: "writer",
      to: "boards",
      payload: { brief: input.brief, sheet },
    });
    await speak("producer", packetLine(toBoards));

    const boarded = open(toBoards, { slate: jobId, to: "boards" });
    const continuity = assertSameCanon(lockContinuity(boarded.sheet));
    const locked: CallSheet = { ...boarded.sheet, shots: continuity.boards };
    const plan = buildNarrativePlan({
      slate: jobId,
      brief: boarded.brief,
      sheet: locked,
      continuity,
    });
    fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(locked, null, 2));
    fs.writeFileSync(jobFile(jobId, "continuity.json"), JSON.stringify(continuity, null, 2));
    fs.writeFileSync(jobFile(jobId, "narrative-plan.json"), JSON.stringify(plan, null, 2));
    fs.writeFileSync(jobFile(jobId, "delivery", "continuity.md"), continuityMarkdown(continuity));
    fs.writeFileSync(jobFile(jobId, "delivery", "narrative-plan.md"), planMarkdown(plan));
    indexPlanTexts(jobId, plan.nodes);
    job = patch(job, {
      continuity,
      callSheet: locked,
      narrativePlan: plan,
      vault: vaultStats(jobId),
      progress: 14,
      outputs: {
        ...job.outputs,
        continuity: "delivery/continuity.md",
        narrativePlan: "narrative-plan.json",
        vault: "vault.json",
      },
    });
    await speak("boards", `分鏡專職鎖咗 ${continuity.cut.length} 鏡。故事＝分鏡＝剪接。Vault 只得 ${jobId}。`);

    if (input.until === "boards") {
      job = patch(job, {
        status: "boarded",
        progress: 20,
        currentAgent: "boards",
        providers: trace,
        outputs: { ...job.outputs, callSheet: "callsheet.json" },
      });
      emit(jobId, {
        agent: "boards",
        level: "pass",
        message: `--until boards：${continuity.boards.length} 鏡、${locked.durationSec.toFixed(1)}s 已寫好。落 wav 之後 --resume ${jobId}。`,
        data: { shots: continuity.boards.length, durationSec: locked.durationSec, provenance: locked.provenance },
      });
      return;
    }

    // portraits before any keyframe: a first appearance needs a face to anchor on
    // --until blockout stops before U1.5/QC — skip the eye (pictureQc may be DOWN)
    const stillDir = path.join(jobDir(jobId), "stills");
    const skipPortraits =
      input.until === "blockout" ||
      (input.resume && continuity.boards.every((shot) => pinQcAccepted(stillDir, shot.id)));
    let portraits: Awaited<ReturnType<typeof ensurePortraits>>;
    if (skipPortraits) {
      emit(jobId, {
        agent: "stills",
        level: "info",
        message:
          input.until === "blockout"
            ? "blockout gate: skip portraits (no pictureQc eye this hop)"
            : "repair: portraits saw ensurePortraits became skip (all stills pinned GREEN on resume)",
      });
      await speak(
        "stills",
        input.until === "blockout" ? "肖像跳過：--until blockout，唔叫畫檢眼" : "肖像跳過：stills 已全 GREEN，肖像唔再守門",
      );
      portraits = { files: {}, made: [], plugged: [], kept: [] };
    } else {
      await think("stills");
      const hopCast = input.scene
        ? [...new Set(shotsForScene(locked.shots, input.scene).flatMap((s) => s.marks.map((m) => m.characterId)))]
        : undefined;
      portraits = await ensurePortraits({
        sheet: locked,
        outDir: path.join(jobDir(jobId), "portraits"),
        plugDir: input.portraitsDir,
        server: cfg.stills.url,
        seed: cfg.motion.seed,
        onlyIds: hopCast,
        onEvent: (message, data) => emit(jobId, { agent: "stills", level: "info", message, data }),
      });
      await speak("stills", `肖像齊：plug ${portraits.plugged.length}、新做 ${portraits.made.length}${hopCast ? `（hop ${hopCast.join(",")}）` : ""}。`);
    }

    await think("art");
    await speak("art", `Grade: ${locked.styleBible.grade}. 只描述已有 ${continuity.boards.length} 鏡，唔另開世界。`);

    await think("layout");
    await speak("layout", "走位只跟分鏡 mark：camera、手 IK、腳 IK。wav 係時鐘。");
    const blenderFile = jobFile(jobId, "blender", "blocking.py");
    fs.writeFileSync(blenderFile, blenderBlockingScript(locked));
    const blockingDir = path.join(jobDir(jobId), "blocking");
    ensureDir(blockingDir);
    for (const shot of continuity.boards) {
      await raster(renderBlockingSvg(locked, shot), path.join(blockingDir, `${shot.id}.png`));
    }

    // wav plug: copy SHxx.wav (+ optional spine.wav) into the job, cut plan from real clocks
    const gapSec = input.gapSec ?? 0;
    const audioDir = path.join(jobDir(jobId), "audio");
    ensureDir(audioDir);
    const wavByShot = new Map<string, string>();
    const h3WavByShot = new Map<string, string>();
    const gapDelivered = new Map<string, number>();
    for (const shot of continuity.boards) {
      const src = path.join(input.wavDir, `${shot.id}.wav`);
      if (!fs.existsSync(src)) throw new Error(`--wav-dir 缺 ${shot.id}.wav（${src}）`);
      const dst = path.join(audioDir, `${shot.id}.wav`);
      fs.copyFileSync(src, dst);
      wavByShot.set(shot.id, dst);
      const frames = snapDurationToFrames(await wavSeconds(dst));
      const h3Wav = path.join(audioDir, `${shot.id}.h3.wav`);
      await padH3Wav(dst, h3Wav, frames);
      h3WavByShot.set(shot.id, h3Wav);
      gapDelivered.set(shot.id, Math.round((frames / 24 - (await wavSeconds(dst))) * 1e4) / 1e4);
    }
    const spineGiven = path.join(input.wavDir, "spine.wav");
    const spineWav = fs.existsSync(spineGiven) ? path.join(audioDir, "spine.wav") : undefined;
    if (spineWav) fs.copyFileSync(spineGiven, spineWav);
    const cutPlan = await buildCutPlan({
      cut: continuity.cut,
      wavDir: audioDir,
      gapSec,
      spineWav,
      outFile: jobFile(jobId, "cut_plan.json"),
    });
    // h3_clock_s is data for the report (the gate still snaps the ORIGINAL wav)
    const cutPlanFile = jobFile(jobId, "cut_plan.json");
    const cutPlanOnDisk = JSON.parse(fs.readFileSync(cutPlanFile, "utf8")) as { shots: { id: string; h3_clock_s?: number }[] };
    for (const s of cutPlanOnDisk.shots ?? []) {
      const h3 = h3WavByShot.get(s.id);
      if (h3) s.h3_clock_s = Math.round((await wavSeconds(h3)) * 1e4) / 1e4;
    }
    fs.writeFileSync(cutPlanFile, JSON.stringify(cutPlanOnDisk, null, 2));
    const timed: CallSheet = {
      ...locked,
      durationSec: cutPlan.shots.reduce((a, s) => a + s.duration_s, 0) + gapSec * Math.max(0, cutPlan.shots.length - 1),
      shots: locked.shots.map((s) => ({
        ...s,
        durationSec: cutPlan.shots.find((c) => c.id === s.id)?.duration_s ?? s.durationSec,
      })),
    };

    // MULTISHOT_WIRE_0921: motion-select — ONE decider call casts every shot's
    // motion from the CMU library; the baked mocap blockouts then override the
    // workbench grey puppets wherever a selection lands (§5b C-form supply:
    // selection.json → bake → blockout/{shot}.mp4 → the C-form router)
    const motionSelections = new Map<string, MotionSelection>();
    {
      const idxFile = path.join(MOTION_LIB_ROOT, "cmu-mocap/cmu-mocap-index-text.txt");
      if (!fs.existsSync(idxFile)) {
        await speak("layout", "motion-select 跳過：motion library index 唔在盤（workbench 灰模照舊）。", "warn");
      } else if (input.noMotionSelect) {
        await speak("layout", "motion-select 關咗（--no-motion-select）：workbench 灰模照舊。");
      } else if (input.dryRun) {
        // --dry-run promises zero sockets — the decider POST waits for a live run
        await speak("layout", "motion-select 跳過：--dry-run 零 socket（decider call 留畀 live run）。");
      } else {
        await think("layout");
        const idx = buildCmuIndex(MOTION_LIB_ROOT);
        const rankFile = path.join(MOTION_LIB_ROOT, "out/combat_sweep_ranking.txt");
        const rank = fs.existsSync(rankFile)
          ? parseCombatSweepRanking(fs.readFileSync(rankFile, "utf8"))
          : new Map();
        const selShots = shotsForScene(locked.shots, input.scene);
        const shortlist = buildShortlist(idx, rank, selShots.map((s) => s.action));
        const lines: MotionShotLine[] = selShots.map((s) => ({
          id: s.id,
          heading: s.heading,
          action: s.action,
          durationSec: s.durationSec,
          gait: s.marks[0]?.gait,
          stance: s.marks[0]?.stance,
        }));
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
        for (const sel of sels) motionSelections.set(sel.shot, sel);
        const auto = sels.filter((s) => s.auto).length;
        const human = sels.filter((s) => s.needs_human).length;
        await speak(
          "layout",
          `motion-select：${calls} 個 decider call 揀齊 ${sels.length} 鏡 → motion/selection.json（${auto} auto${human ? `、${human} needs_human` : ""}；120候選）。`,
        );
      }
    }

    // per-shot grey blockout (plug, mocap bake, or WORKBENCH render), frame 0, dHash anchors
    // --scene hop: only render that scene's blockouts (rest wait for their hop)
    const blockoutDir = path.join(jobDir(jobId), "blockout");
    ensureDir(blockoutDir);
    const blockouts: string[] = [];
    const hopBoards = shotsForScene(continuity.boards, input.scene);
    if (input.scene) {
      await speak("layout", `--scene ${input.scene} hop：blockout ${hopBoards.length}/${continuity.boards.length} 鏡。`);
    }
    for (const shot of hopBoards) {
      const outMp4 = path.join(blockoutDir, `${shot.id}.mp4`);
      const wav = wavByShot.get(shot.id)!;
      const frames = snapDurationToFrames(await wavSeconds(wav));
      const kept = input.resume && fs.existsSync(outMp4)
        && Math.round((await mediaSeconds(outMp4)) * 24) === frames;
      if (kept) {
        trace.blender = "resume (kept)";
        await speak("layout", `${shot.id} blockout 照舊 ${frames}f，唔重 render。`);
      } else if (input.blockoutDir) {
        const plugged = await blockoutFromPlug(input.blockoutDir, shot.id, wav);
        fs.copyFileSync(plugged, outMp4);
        trace.blender = "blockout plug";
      } else {
        const sel = motionSelections.get(shot.id);
        if (sel) {
          // MULTISHOT_WIRE: the selected mocap clip IS the blockout — a grey
          // bake of the real motion, the §5b C-form's Video 1
          const { framesDir, frames: baked } = await bakeSelectionFrames(sel, outMp4);
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
        } else {
          const done = await renderBlockout({
            sheet: timed,
            shot,
            frames,
            outMp4,
          });
          trace.blender = `blender-workbench ${done.frames}f`;
        }
      }
      const f0png = path.join(blockoutDir, `${shot.id}.f0.png`);
      await extractFrame0(outMp4, f0png, stillFrameFor(shot, frames));
      await assertFiguresVisible(f0png, shot);
      await writeAnchors(outMp4, path.join(blockoutDir, `${shot.id}.anchors.json`));
      blockouts.push(outMp4);
      if (!kept) await speak("layout", `${shot.id} blockout ${frames}f（wav 時鐘）`);
    }
    job = patch(job, {
      providers: trace,
      progress: 30,
      outputs: {
        ...job.outputs,
        blenderScript: "blender/blocking.py",
        blockingPreview: "blocking/SH01.png",
        cutPlan: "cut_plan.json",
        blockout: blockouts.map((f) => relInJob(jobId, f)),
      },
    });
    await speak("layout", `cut_plan ${cutPlan.shots.length} 鏡 · gap ${gapSec}s · 走位稿已出。`);

    if (input.until === "blockout") {
      job = patch(job, {
        status: "blockout-ready",
        progress: 30,
        currentAgent: "layout",
        providers: trace,
      });
      emit(jobId, {
        agent: "layout",
        level: "pass",
        message: `--until blockout：${blockouts.length} 鏡灰塊+f0 已出。pictureQc UP 之後 --resume ${jobId} --scene ${input.scene ?? "SCxx"}。`,
        data: { blockouts: blockouts.length, scene: input.scene ?? null },
      });
      return;
    }

    // stills lane prompts + require (built in both live and dry run)
    ensureDir(stillDir);
    // T44 §1: `first` tracks unseen faces only — a size change no longer
    // re-portraits a cast the viewer already knows
    const firstFlags = stillFirstFlags(continuity.boards);
    // --scene hop composes only its own shots: an out-of-scene prompt_too_thin
    // throw must not fail the hop (WR1Q SC01 died on SH06)
    const planBoards = input.scene ? shotsForScene(continuity.boards, input.scene) : continuity.boards;
    const baseCast = job.drama ? loadBaseCast(projectsDir(), job.drama) : undefined;
    // Card D 掣3: search-first PE runs BEFORE the packet is fed to /edit —
    // every facts-needing shot without packet facts goes wigolo evidence →
    // PE brain (nex :8017, qwen38 :8015 backup) → the rows land in
    // require.facts and the Render JSON rides along as the screen spec.
    // dry-run never POSTs a machine, so it skips the PE step and lets the
    // facts_missing refuse-to-emit gate speak instead.
    const peRenders = new Map<string, string>();
    if (!input.dryRun) {
      const needsFacts = timed.shots.filter((s) => needsShotFacts(s) && !(s.require?.facts?.length));
      for (const shot of needsFacts) {
        const started = Date.now();
        const res = await runPeStep({
          shotId: shot.id,
          action: shot.action,
          context: `${timed.title}｜${timed.location}｜${timed.timeOfDay}｜${timed.mood}`,
          config: cfg.pe,
          receiptFile: path.join(stillDir, `${shot.id}.pe_step.json`),
        });
        shot.require = { ...shot.require, facts: res.facts };
        peRenders.set(shot.id, res.render);
        await speak("stills", `${shot.id} search-first PE：wigolo＋${res.brain} 出 ${res.facts.length} 條 facts（${res.wigoloMs}ms 搜證，${Date.now() - started}ms 全程）。`);
      }
    }
    const stillPlans = planBoards.map((boardShot) => {
      const shot = timed.shots.find((s) => s.id === boardShot.id)!;
      const first = firstFlags[continuity.boards.indexOf(boardShot)]!;
      const prompt = keyframeEditPrompt(timed, shot, { first, ...(baseCast ? { cast: baseCast } : {}) });
      const peRender = peRenders.get(shot.id);
      const editPrompt = peRender ? `${prompt}\n\n【螢幕畫面 Render】\n${peRender}` : prompt;
      const require = keyframeRequire(shot);
      // D1a trace: soft edge invariants (boards→keyframe, keyframe→stills),
      // written for pass and fail alike, always before any QC gate can fail
      const softRows = [...checkBoardsToKeyframe(timed.characters, shot, editPrompt), ...checkKeyframeToStills(shot, require)];
      for (const row of softRows) appendViolation(jobDir(jobId), row);
      fs.writeFileSync(path.join(stillDir, `${shot.id}.require.json`), JSON.stringify(require, null, 2));
      return { shot, first, prompt: editPrompt, require };
    });

    if (input.dryRun) {
      const variant = h3GraphVariant(input);
      const receipts: string[] = [];
      for (const { shot } of stillPlans) {
        const stillPng = path.join(stillDir, `${shot.id}.png`);
        const prev = prevShotOf(timed, shot);
        const blockoutMp4 = path.join(blockoutDir, `${shot.id}.mp4`);
        // §5b routing field: the Video 1 asset on disk decides the form
        const hasVideo1 = fs.existsSync(blockoutMp4);
        const pack = h3MotionPack(timed, shot, variant, stillPng, portraits.files, prev, {
          hasVideo1,
          portraitDir: path.join(jobDir(jobId), "portraits"),
          plugDir: input.portraitsDir,
        });
        writeH3Plan(jobId, timed, shot, {
          wav: h3WavByShot.get(shot.id)!,
          blockout: hasVideo1 ? blockoutMp4 : undefined,
          still: stillPng,
          kfStart: hasVideo1 ? undefined : stillPng,
          kfEnd: pack.kfEnd,
          refImageFiles: pack.refImageFiles,
          anglePortraits: pack.anglePortraits,
        });
        const { receiptFile } = await submitH3Shot({
          prose: pack.prose,
          wavFile: h3WavByShot.get(shot.id)!,
          blockoutMp4: hasVideo1 ? blockoutMp4 : undefined,
          kfStart: hasVideo1 ? undefined : stillPng,
          kfEnd: pack.kfEnd,
          refImageFiles: pack.refImageFiles,
          uiPhotoFiles: pack.uiPhotoFiles,
          outMp4: path.join(jobDir(jobId), "motion", `${shot.id}.mp4`),
          receiptJson: jobFile(jobId, "motion", `${shot.id}.h3_submit_dryrun.json`),
          dryRun: true,
          shot: shot.id,
          requireQuote: Boolean(shot.dialogue.trim()),
          wardrobe: wardrobeClauses(timed),
          graphVariant: variant,
          stepsOverride: input.steps,
        });
        receipts.push(relInJob(jobId, receiptFile));
      }
      job = patch(job, {
        status: "dry-run",
        progress: 55,
        currentAgent: "motion",
        providers: trace,
        outputs: { ...job.outputs, receipts },
      });
      emit(jobId, {
        agent: "motion",
        level: "warn",
        message: `dry-run：${receipts.length} 份 H3 receipt 已出，冇 POST 過任何機。`,
      });
      return;
    }

    // stills: U1.5 /edit on node0 (fail-loud — any throw fails the job)
    const stillsHost = new URL(cfg.stills.url).hostname;
    const stills: string[] = [];
    const size = sceneSize(timed.aspect);
    const toStills = seal({
      slate: jobId,
      from: "boards",
      to: "stills",
      payload: { boards: continuity.boards },
    });
    await think("stills");
    const stillWork = open(toStills, { slate: jobId, to: "stills" });
    await speak("stills", packetLine(toStills));
    await speak("stills", `U1.5 /edit ${cfg.stills.url} · ${cfg.stills.width}×${cfg.stills.height} · Image-1＝自己 f0，Image-2＋＝肖像（首次）或上一鏡定格。`);
    const hopStillIds = new Set(shotsForScene(timed.shots, input.scene).map((s) => s.id));
    const hopStillPlans = input.scene ? stillPlans.filter((p) => hopStillIds.has(p.shot.id)) : stillPlans;
    if (input.scene) {
      await speak("stills", `--scene ${input.scene} hop：stills/QC ${hopStillPlans.length}/${stillPlans.length} 鏡。`);
    }
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
        const receipt = readQcReceipt(path.join(stillDir, `${shotId}.photo_qc.json`));
        const f0File = path.join(blockoutDir, `${shotId}.f0.png`);
        await buildQcSheet(
          {
            shotId,
            f0File: fs.existsSync(f0File) ? f0File : path.join(stillDir, `${shotId}.png`),
            stillFile: path.join(stillDir, `${shotId}.png`),
            status: receipt.status,
            failReasons: receipt.failReasons,
            requireLocation: require_.location,
            blind: receipt.blind,
            prompt,
          },
          path.join(stillDir, `${shotId}.qc-sheet.png`),
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
        buildQcSheetHtml(qcSheetRows, path.join(stillDir, `${jobId}.qc-sheet.html`));
      } catch (error) {
        void (error instanceof Error ? error.message : error);
      }
    };

    for (const { shot, first, prompt, require } of hopStillPlans) {
      const out = path.join(stillDir, `${shot.id}.png`);
      const recordJson = path.join(stillDir, `${shot.id}.u15_edit.json`);
      const base = path.join(blockoutDir, `${shot.id}.f0.png`);
      const refIds = [...new Set(shot.marks.map((m) => m.characterId))];
      // T44 §5/R5: memory refs rank by real WeMM cosine against the previous
      // keyframe — no query file (first shot) or a down embed eye means no
      // memory refs this pass; the GREEN gate below still vets what returns
      const memHits = !first && prevKeyframe && cfg.embed.endpoint.trim()
        ? await queryRefs(job.slate, {
            queryFile: prevKeyframe,
            characters: refIds,
            scene: shot.location || timed.location,
            k: 3,
          }).catch(() => [])
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
      if (input.resume && pinQcAccepted(stillDir, shot.id)) {
        prevKeyframe = out;
        stills.push(out);
        await speak("stills", `${shot.id} keyframe 照舊（QC 已 GREEN），唔重出。`);
        continue;
      }
      // resume：已有 png 但未 QC — 照用，唔重 /edit（唔再 scp node0）。
      // T44 §3：FAIL 唔算未 QC — FAIL png 要重行 /edit；T35b PASS_WITH_WARN
      // 照舊照用（warn-pass 係出貨態，唔係 FAIL）
      const qcVerdictJson = path.join(stillDir, `${shot.id}.photo_qc.json`);
      const qcSaysFail = (() => {
        if (!fs.existsSync(qcVerdictJson)) return false;
        try {
          return (JSON.parse(fs.readFileSync(qcVerdictJson, "utf8")) as { status?: string }).status === "FAIL";
        } catch {
          return false;
        }
      })();
      if (input.resume && !qcSaysFail && fs.existsSync(out) && fs.statSync(out).size >= 8_000) {
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
            const p = Object.values(portraits.files).find((f) => path.basename(f) === r);
            return p ?? path.join(stillDir, r);
          };
          if ((rec.prompt || prompt) && nodePaths.length) {
            editInputs.set(shot.id, {
              prompt: rec.prompt || prompt,
              nodePaths,
              base: rec.base ? (path.isAbsolute(rec.base) ? rec.base : path.join(blockoutDir, rec.base)) : base,
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
      const memFiles = memHits
        .map((h) => path.join(jobDir(jobId), h.rel))
        .filter((p) => fs.existsSync(p) && p !== prevKeyframe && path.basename(p) !== `${shot.id}.png`);
      const portraitFor = (id: string) => {
        const p = portraits.files[id];
        if (!p || !fs.existsSync(p)) throw new Error(`${shot.id}: 首次出場冇肖像（${id}）`);
        return p;
      };
      // T44 §2/§4: every /edit ref passes the GREEN gate first — a FAILed
      // prior still is rejected (ref_rejected) and the cast's GREEN portraits
      // stand in; the shot's own failed still never rides back in (memory
      // hits are refs too, so they pass the same gate)
      const candidates = first
        ? refIds.map(portraitFor)
        : [...(prevKeyframe ? [prevKeyframe] : []), ...memFiles];
      if (!candidates.length) throw new Error(`${shot.id}: no ref for /edit (first=${first}, no previous keyframe)`);
      const gate = refsGreenOnly(candidates);
      for (const r of gate.rejected) refRejected(shot.id, r);
      let refFiles = gate.kept;
      if (gate.rejected.length && !refFiles.length) {
        const fallback = refsGreenOnly(refIds.map(portraitFor));
        for (const r of fallback.rejected) refRejected(shot.id, r);
        refFiles = fallback.kept;
      }
      if (!refFiles.length) throw new Error(`${shot.id}: refs 冇一張 photo_qc GREEN — 唔准 /edit`);
      const images = [base, ...refFiles].slice(0, MAX_IMAGES);
      const health = await checkHealth(cfg.stills.url, images.length);
      const nodePaths: string[] = [];
      for (const img of images) {
        const rpath = u15RefPath(img);
        await scpToHost(stillsHost, cfg.ssh.user, img, path.dirname(rpath), path.basename(rpath));
        nodePaths.push(rpath);
      }
      const payload = buildEditPayload({
        prompt,
        images: nodePaths,
        width: cfg.stills.width || size.width,
        height: cfg.stills.height || size.height,
      });
      await u15Edit({
        server: cfg.stills.url,
        payload,
        nodePaths,
        outFile: out,
        recordJson,
        health,
        record: sealEditRecord({ prompt, first, base, refs: refFiles }, payload),
      });
      editInputs.set(shot.id, { prompt, nodePaths, base, refs: refFiles, first });
      prevKeyframe = out;
      stills.push(out);
      upsertDoc({
        id: `image:${shot.id}`,
        slate: jobId,
        modality: "image",
        shotId: shot.id,
        text: prompt,
        absPath: out,
      });
      emit(jobId, {
        agent: "stills",
        level: "info",
        message: `${shot.id} keyframe /edit 完成`,
        data: {
          file: `stills/${shot.id}.png`,
          shot: shot.id, stage: "keyframe", eye: "stills", verdict: "pass",
          proof: `stills/${shot.id}.png`, ms: Date.now() - stillStarted,
        },
        step_id: "keyframe-prompt",
        parent_steps: ["boards"],
        seat: "stills",
        constraints_checked: ["prop-drift", "cast-drift", "require-keys"],
      });
      } // else: /edit this shot

      // bug4: picture QC judges THIS still inside the same loop, immediately
      // after /edit (or a reused un-QC png) — GREEN pin exists before the next
      // shot asks for Image-2. T44 GREEN-only gate unchanged. Retry stays FAIL-only
      // (PASS_UNCONFIRMED 唔自動當 FAIL 重出 — 報 SlateLead，唔自決).
      const png = out;
      const geometryShot = localPictureQc({ stills: [out], sheet: { ...timed, shots: [shot] }, target: "stills" });
      if (!geometryShot.pass) {
        const detail = geometryShot.issues.map((i) => i.detail).join("; ");
        appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc-geometry", geometryShot.issues.map((i) => i.detail)));
        throw new Error(`picture QC plan-geometry pre-check failed: ${detail}`);
      }
      const qcStarted = Date.now();
      const qcJson = path.join(stillDir, `${shot.id}.photo_qc.json`);
      let result = await runPhotoQc(png, qcJson, require, {}, photoQcEyesFromEnv());
      let promptShot = shot;
      if (result.status === "FAIL" && isLocationFail(result.checks.fail_reasons)) {
        // T32 rev2: location FAIL 退返阿圖重寫場景 slot 一次（自動，唔係人手改 prompt）
        const inputs0 = editInputs.get(shot.id);
        if (!inputs0) throw new Error(`picture QC ${shot.id}: no /edit inputs for the 阿圖 retry`);
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
          promptShot = {
            ...shot,
            require: {
              location: next.location,
              angle: next.angle ?? shot.require?.angle,
              ...(next.negatives?.length ? { negatives: next.negatives } : {}),
            },
          };
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
          editInputs.set(shot.id, { ...inputs0, prompt: keyframeEditPrompt(timed, promptShot, { first, ...(baseCast ? { cast: baseCast } : {}) }) });
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
        await speak("pictureQc", `${shot.id} 唔過（${reasons}）— 原封重出同一 packet 一次。`, "warn");
        let inputs = editInputs.get(shot.id);
        const plan = hopStillPlans.find((p) => p.shot.id === shot.id);
        if (!inputs || !inputs.nodePaths.length) {
          // T44 §2: the rebuild may not ride the shot's own FAILed still back
          // in — a non-first rebuild refs the previous shot's still instead
          // (the GREEN gate below drops it if that one is not GREEN either)
          const base = path.join(blockoutDir, `${shot.id}.f0.png`);
          const refIds = [...new Set(shot.marks.map((m) => m.characterId))];
          const planIdx = hopStillPlans.findIndex((p) => p.shot.id === shot.id);
          const prevPlan = planIdx > 0 ? hopStillPlans[planIdx - 1] : undefined;
          const firstAppearance = Boolean(plan?.first);
          const refFiles = firstAppearance
            ? refIds.map((id) => {
                const p = portraits.files[id];
                if (!p || !fs.existsSync(p)) throw new Error(`${shot.id}: retry 冇肖像（${id}）`);
                return p;
              })
            : prevPlan
              ? [path.join(stillDir, `${prevPlan.shot.id}.png`)]
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
        if (!inputs.prompt) throw new Error(`picture QC ${shot.id}: no /edit prompt to retry with`);
        // T44 §2/§4: the retry re-derives refs through the GREEN gate — the
        // shot's own failed still is structurally never among the candidates,
        // and any ref that lost its GREEN since the first attempt drops out
        // with a ref_rejected event, portraits standing in
        const regate = refsGreenOnly(inputs.refs);
        for (const r of regate.rejected) refRejected(shot.id, r);
        let retryRefs = regate.kept;
        if (regate.rejected.length && !retryRefs.length) {
          const ids = [...new Set(shot.marks.map((m) => m.characterId))];
          const portraitOf = (id: string) => {
            const p = portraits.files[id];
            if (!p || !fs.existsSync(p)) throw new Error(`${shot.id}: retry 冇肖像 fallback（${id}）`);
            return p;
          };
          const fallback = refsGreenOnly(ids.map(portraitOf));
          for (const r of fallback.rejected) refRejected(shot.id, r);
          retryRefs = fallback.kept;
        }
        if (!retryRefs.length) throw new Error(`picture QC ${shot.id}: retry refs 冇一張 GREEN — 唔准再 /edit`);
        const retryImages = [inputs.base, ...retryRefs].slice(0, MAX_IMAGES);
        const retryNodePaths: string[] = [];
        for (const img of retryImages) {
          const rpath = u15RefPath(img);
          await scpToHost(stillsHost, cfg.ssh.user, img, path.dirname(rpath), path.basename(rpath));
          retryNodePaths.push(rpath);
        }
        editInputs.set(shot.id, { ...inputs, nodePaths: retryNodePaths, refs: retryRefs });
        const payload = buildEditPayload({
          prompt: inputs.prompt,
          images: retryNodePaths,
          width: cfg.stills.width || size.width,
          height: cfg.stills.height || size.height,
        });
        await u15Edit({
          server: cfg.stills.url,
          payload,
          nodePaths: retryNodePaths,
          outFile: png,
          recordJson: path.join(stillDir, `${shot.id}.u15_edit.retry.json`),
          health: await checkHealth(cfg.stills.url, retryNodePaths.length),
          record: sealEditRecord({ ...inputs, refs: retryRefs }, payload),
        });
        result = await runPhotoQc(png, qcJson, require, {}, photoQcEyesFromEnv());
      }
      if (result.status === "FAIL") {
        const reasons = result.checks.fail_reasons.join("; ") || "not GREEN";
        appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc", result.checks.fail_reasons));
        await buildShotSheet(shot.id, require, editInputs.get(shot.id)?.prompt ?? shot.stillPrompt ?? "");
        writeSceneSheetHtml();
        job = patch(job, {
          status: "blocked",
          currentAgent: "pictureQc",
          providers: trace,
          error: `picture QC ${shot.id} 連續兩次唔過：${reasons}`,
        });
        emit(jobId, {
          agent: "pictureQc",
          level: "fail",
          message: `${shot.id} 兩次都唔過（${reasons}）。停手，唔硬出。修 prompt 或者換 plug 之後 --resume ${jobId}。`,
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
        return;
      }
      const warns = (result.checks.warns as string[] | undefined) ?? [];
      if (result.status === "PASS_WITH_WARN") {
        emit(jobId, {
          agent: "pictureQc",
          level: "warn",
          message: `${shot.id} PASS_WITH_WARN（${warns.join("; ")}）— 照出，警示留底。`,
          data: { shot: shot.id, warns },
          step_id: "require",
          parent_steps: ["keyframe-prompt"],
          seat: "pictureQc",
          constraints_checked: ["photo-qc"],
        });
      }
      if (result.status === "PASS_WITH_WARN") {
        // T35b-cache: a warned still never speaks GREEN/pass — the warn is the headline.
        await speak("pictureQc", `${shot.id} PASS_WITH_WARN（${warns.join("; ")}）`, "warn");
      } else {
        await speak("pictureQc", `${shot.id} GREEN（人數 ${require.people_count}）`, "pass");
      }
      emit(jobId, {
        agent: "pictureQc",
        level: "pass",
        message: `${shot.id} photo QC GREEN（人數 ${require.people_count}）`,
        data: {
          shot: shot.id, stage: "require", eye: "pictureQc", verdict: "pass",
          proof: `stills/${shot.id}.photo_qc.json`, ms: Date.now() - qcStarted,
        },
        step_id: "require",
        parent_steps: ["keyframe-prompt"],
        seat: "pictureQc",
        constraints_checked: ["photo-qc"],
      });
      if (cfg.embed.endpoint.trim()) {
        await ingestStill({
          ep: job.slate,
          shot: shot.id,
          character: shot.marks[0]?.characterId ?? "",
          scene: shot.location || timed.location,
          file: png,
          rel: `stills/${shot.id}.png`,
        });
      }
      await buildShotSheet(shot.id, require, editInputs.get(shot.id)?.prompt ?? shot.stillPrompt ?? "");
    }
    writeSceneSheetHtml();
    // picture QC slate record: every hop still above is already GREEN-pinned
    // in-loop (bug4). Whole-slate (or hop) plan-geometry is the receipt.
    const qcSheet = input.scene
      ? { ...timed, shots: shotsForScene(timed.shots, input.scene) }
      : timed;
    const geometry = localPictureQc({ stills, sheet: qcSheet, target: "stills" });
    if (!geometry.pass) {
      const detail = geometry.issues.map((i) => i.detail).join("; ");
      appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc-geometry", geometry.issues.map((i) => i.detail)));
      throw new Error(`picture QC plan-geometry pre-check failed: ${detail}`);
    }
    trace.mars = `qwen38 ${cfg.pictureQc.endpoint} (${cfg.pictureQc.model})`;
    job = patch(job, { pictureQcStills: geometry, providers: trace, progress: 55 });
    if (input.until === "stills") {
      job = patch(job, {
        status: "stills-ready",
        currentAgent: "pictureQc",
        outputs: {
          ...job.outputs,
          stills: stills.map((f) => relInJob(jobId, f)),
          blockout: blockouts.map((f) => relInJob(jobId, f)),
        },
      });
      emit(jobId, {
        agent: "pictureQc",
        level: "pass",
        message: "--until stills：photo QC 全 GREEN，H3 未燒。stills + f0 + require 已出。",
      });
      return;
    }

    // motion: H3 R2V per shot — photo QC pin must be accepted before submit
    const motionDir = path.join(jobDir(jobId), "motion");
    ensureDir(motionDir);
    const shotVideos: string[] = [];
    const receipts: string[] = [];
    const toMotion = seal({
      slate: jobId,
      from: "stills",
      to: "motion",
      payload: { boards: continuity.boards },
    });
    await think("motion");
    open(toMotion, { slate: jobId, to: "motion" });
    await speak("motion", packetLine(toMotion));
    await speak("motion", `H3 R2V ${cfg.motion.comfyUrl} · §5b：有Video1→C形（零keyframes＋ref_image_0角度肖像）；冇Video1→A形（keyframes兩端）· 一鏡一 submit。`);
    // C-scene-hop: the scene flag crops the stills/QC lanes above and this
    // motion loop; a no-match scene throws before any H3 is burned
    const motionShots = shotsForScene(stillPlans.map((p) => p.shot), input.scene);
    if (input.scene) {
      await speak("motion", `--scene ${input.scene} hop：燒 ${motionShots.length}/${stillPlans.length} 鏡，其餘唔郁。`);
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
    const hasMulti = segments.some((s) => (s.kind === "cform" ? s.chain.length : s.shots.length) > 1);
    if (hasMulti) {
      fs.writeFileSync(
        segmentsFile,
        JSON.stringify(
          {
            policy: "martial/run anchors C-form; trailing simple shots chain (true-endframe multishot); leading simple runs = one multishot call",
            segments: segments.map((s) => ({
              kind: s.kind,
              shots: s.kind === "cform" ? [s.anchor, ...s.chain] : s.shots,
              segId: (s.kind === "cform" ? [s.anchor, ...s.chain] : s.shots).join("-"),
            })),
          },
          null,
          2,
        ) + "\n",
      );
    }
    const segManifest = fs.existsSync(segmentsFile)
      ? (JSON.parse(fs.readFileSync(segmentsFile, "utf8")) as { segments: { kind: string; shots: string[] }[] }).segments
      : null;
    await speak(
      "motion",
      hasMulti
        ? `跨shot接駁：${segments.length} 個 render段（${segments.filter((s) => s.kind === "cform" && s.chain.length).length} 段C形+multishot鏈、${segments.filter((s) => s.kind === "multishot" && s.shots.length > 1).length} 段純multishot）→ segments.json。`
        : `跨shot接駁：${segments.length} 鏡全部單鏡render（冇鏈）。`,
    );
    for (const shot of motionShots) {
      if (!pinQcAccepted(stillDir, shot.id)) {
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
      const stillPng = path.join(stillDir, `${shot.id}.png`);
      const prev = prevShotOf(timed, shot);
      const blockoutMp4 = path.join(blockoutDir, `${shot.id}.mp4`);
      // §5b routing field: the Video 1 asset on disk decides the form
      const hasVideo1 = fs.existsSync(blockoutMp4);
      // MULTISHOT_WIRE: this shot's segment — solo keeps the single-shot path;
      // a multishot segment renders the whole run inside H3MultishotSampler
      const segShots = segList; // [first, ...rest] of the segment
      const chained = segShots.slice(1);
      const isMsSegment = Boolean(segIsMultishot);
      const framesPerShot = chained.length
        ? snapFramesPerShot(Math.max(...chained.map((id) =>
            cutPlan.shots.find((c) => c.id === id)?.duration_s ?? timed.shots.find((s) => s.id === id)?.durationSec ?? 0,
          )))
        : 0;
      const msLine = (id: string) => {
        const s = timed.shots.find((x) => x.id === id)!;
        const cast = [...new Set(s.marks.map((m) => m.characterId))]
          .map((cid) => timed.characters.find((c) => c.id === cid)?.name ?? cid)
          .join("、");
        return `${s.heading}. ${cast}：${s.action} Same person and wardrobe as <Picture 1>. No new people.`;
      };
      const msScript = (isMsSegment ? segShots : chained).map(msLine).join("\n---\n");
      const msPortraitFile = (() => {
        const first = timed.shots.find((x) => x.id === segShots[0])!;
        try {
          return anglePortraitsFor(first, portraits.files, path.join(jobDir(jobId), "portraits"), input.portraitsDir)[0]?.file;
        } catch {
          return undefined;
        }
      })();
      const pack = isMsSegment
        ? null
        : h3MotionPack(timed, shot, variant, stillPng, portraits.files, prev, {
            hasVideo1,
            portraitDir: path.join(jobDir(jobId), "portraits"),
            plugDir: input.portraitsDir,
          });
      const prose = isMsSegment ? msScript : pack!.prose;
      if (variant === "a" && !isMsSegment) {
        validateProse(`${SCRIPT_HEADER}\n${prose}`, {
          requireQuote: Boolean(shot.dialogue.trim()),
          wardrobe: wardrobeClauses(timed),
        });
      }
      if ((chained.length || isMsSegment) && !msPortraitFile) {
        throw new Error(`${segId}: multishot段要一張身份肖像（<Picture 1>）— 角度肖像缺件`);
      }
      const doneMp4 = path.join(motionDir, `${segId}.mp4`);
      const doneReceipt = path.join(motionDir, `${segId}.h3_submit.json`);
      const requirePath = path.join(stillDir, `${shot.id}.require.json`);
      const require = JSON.parse(fs.readFileSync(requirePath, "utf8")) as QcRequire;
      const videoQcJson = path.join(motionDir, `${segId}.video_qc.json`);
      const segFrames = (id: string) =>
        isMsSegment
          ? snapFramesPerShot(cutPlan.shots.find((c) => c.id === id)?.duration_s ?? 0)
          : Math.round((cutPlan.shots.find((c) => c.id === id)?.duration_s ?? -1) * 24);
      const wantFrames = isMsSegment
        ? segShots.reduce((a, id) => a + segFrames(id), 0)
        : Math.round((cutPlan.shots.find((c) => c.id === shot.id)?.duration_s ?? -1) * 24)
          + (chained.length ? framesPerShot * chained.length : 0);
      const frameSnap = fs.existsSync(doneMp4)
        && Math.round((await mediaSeconds(doneMp4)) * 24) === wantFrames;
      // resume keeps an mp4 only when frame clock matches AND blind MARS video_qc is GREEN
      const kept =
        input.resume
        && fs.existsSync(doneMp4)
        && fs.existsSync(doneReceipt)
        && frameSnap
        && pinVideoQcAccepted(motionDir, segId);
      if (kept) {
        shotVideos.push(doneMp4);
        receipts.push(relInJob(jobId, doneReceipt));
        await speak("motion", `${segId} 照舊，唔重燒 H3（video_qc GREEN）。`);
        continue;
      }
      if (input.resume && fs.existsSync(doneMp4) && fs.existsSync(doneReceipt) && frameSnap) {
        await speak(
          "motion",
          `${segId} mp4 時鐘啱但 video_qc 未 GREEN — 下一跳重燒。`,
          "warn",
        );
      }
      const motionStarted = Date.now();
      if (!isMsSegment) {
        writeH3Plan(jobId, timed, shot, {
          wav: h3WavByShot.get(shot.id)!,
          blockout: hasVideo1 ? blockoutMp4 : undefined,
          still: stillPng,
          kfStart: hasVideo1 ? undefined : stillPng,
          kfEnd: pack!.kfEnd,
          refImageFiles: pack!.refImageFiles,
          anglePortraits: pack!.anglePortraits,
        });
      }
      const { receiptFile } = await submitH3Shot({
        prose,
        wavFile: h3WavByShot.get(shot.id)!,
        blockoutMp4: hasVideo1 && !isMsSegment ? blockoutMp4 : undefined,
        kfStart: hasVideo1 || isMsSegment ? undefined : stillPng,
        kfEnd: pack?.kfEnd,
        refImageFiles: pack?.refImageFiles,
        uiPhotoFiles: pack?.uiPhotoFiles,
        ...(chained.length
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
                framesPerShot: snapFramesPerShot(
                  Math.max(...segShots.map((id) =>
                    cutPlan.shots.find((c) => c.id === id)?.duration_s ?? 0,
                  )),
                ),
                referenceImageFile: msPortraitFile!,
              },
            }
          : {}),
        outMp4: doneMp4,
        receiptJson: doneReceipt,
        dryRun: false,
        shot: segId,
        requireQuote: Boolean(shot.dialogue.trim()),
        wardrobe: wardrobeClauses(timed),
        graphVariant: variant,
        stepsOverride: input.steps,
      });
      const mp4 = doneMp4;
      shotVideos.push(mp4);
      receipts.push(relInJob(jobId, receiptFile));
      upsertDoc({
        id: `video:${segId}`,
        slate: jobId,
        modality: "video",
        shotId: segId,
        text: prose,
        absPath: mp4,
      });
      await think("pictureQc");
      let videoQc = await runVideoQc({
        mp4,
        outJson: videoQcJson,
        require,
        shotId: segId,
      });
      const prevShot = stillPlans.map((p) => p.shot).find((s, i, arr) => arr[i + 1]?.id === shot.id);
      videoQc = await attachMemoryDistances(videoQc, {
        ep: job.slate,
        shot: segId,
        outJson: videoQcJson,
        character: shot.marks[0]?.characterId,
        prevStill: prevShot ? path.join(stillDir, `${prevShot.id}.png`) : undefined,
        blockoutF0: path.join(blockoutDir, `${shot.id}.f0.png`),
        midFrame: videoQc.frames[Math.floor(videoQc.frames.length / 2)]?.file,
      });
      if (videoQc.status !== "GREEN") {
        const reasons = videoQc.checks.fail_reasons.join("; ") || "not GREEN";
        await speak("motion", `${segId} motion 眼 FAIL（${reasons}）— clip 留低。`, "fail");
      } else {
        await speak("motion", `${segId} motion 眼 GREEN`, "pass");
      }
      emit(jobId, {
        agent: "motion",
        level: "info",
        message: `${segId} motion 完成`,
        data: {
          shot: segId, stage: "motion", eye: "motion", verdict: videoQc.status === "GREEN" ? "pass" : "fail",
          proof: `motion/${segId}.mp4`, ms: Date.now() - motionStarted,
        },
        step_id: "motion",
        parent_steps: ["require"],
        seat: "motion",
      });
    }
    job = patch(job, {
      providers: trace,
      vault: vaultStats(jobId),
      progress: 70,
      outputs: {
        ...job.outputs,
        shots: shotVideos.map((f) => relInJob(jobId, f)),
        receipts,
      },
    });
    if (input.until === "motion") {
      job = patch(job, { status: "motion-ready", currentAgent: "motion" });
      emit(jobId, {
        agent: "motion",
        level: "pass",
        message: "--until motion：H3 片已落，mux 之前停（stills/motion 閘已過）。",
      });
      return;
    }
    // --scene hop: mux this scene only → preview/SCxx.preview.mp4；唔走全 slate concat
    if (input.scene) {
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
        if (!mp4) throw new Error(`--scene ${input.scene}: motion 缺 ${t.id}`);
        const wav = t.shots.length === 1
          ? h3WavByShot.get(t.shots[0]!)!
          : await concatWavHop(t.shots.map((sid) => h3WavByShot.get(sid)!), path.join(motionDir, `${t.id}.wav`));
        const out = path.join(motionDir, `${t.id}.muxed.mp4`);
        await ffmpeg(muxArgs(mp4, wav, out));
        muxed.push(out);
      }
      const muxList = path.join(previewDir, "mux-list.txt");
      fs.writeFileSync(muxList, muxed.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));
      const previewMp4 = path.join(previewDir, `${input.scene}.preview.mp4`);
      await ffmpeg(concatCopyArgs(muxList, previewMp4));
      job = patch(job, {
        status: "motion-ready",
        currentAgent: "motion",
        progress: 75,
        outputs: {
          ...job.outputs,
          shots: shotVideos.map((f) => relInJob(jobId, f)),
          receipts,
          scenePreview: relInJob(jobId, previewMp4),
        },
      });
      emit(jobId, {
        agent: "motion",
        level: "pass",
        message: `--scene ${input.scene} hop 完：${motionShots.length} 鏡已 mux → preview/${input.scene}.preview.mp4。下一場再 --scene。`,
        data: { scene: input.scene, shots: motionShots.map((s) => s.id), preview: `preview/${input.scene}.preview.mp4` },
      });
      return;
    }

    // voice: wav plug only — spine given, or concat slices with gap silence
    await think("voice");
    await speak("voice", "聲軌係 wav plug：spine.wav 或者逐鏡切片加 gap。");
    let spineFile = spineWav;
    if (!spineFile) {
      spineFile = path.join(audioDir, "spine.wav");
      const orderedWavs = cutPlan.shots.map((s) => s.wav);
      if (gapSec > 0 && orderedWavs.length > 1) {
        const fmt = await runCommand("ffprobe", [
          "-v", "error", "-select_streams", "a:0",
          "-show_entries", "stream=sample_rate,channels", "-of", "json", orderedWavs[0]!,
        ]);
        if (fmt.code !== 0) throw new Error(fmt.stderr || "ffprobe wav fmt failed");
        const st = (JSON.parse(fmt.stdout).streams ?? [])[0] as { sample_rate?: string; channels?: string };
        const gapWav = path.join(audioDir, "gap.wav");
        await ffmpeg([
          "-f", "lavfi", "-i", `anullsrc=r=${st.sample_rate ?? 24000}:cl=${st.channels ?? 1}`,
          "-t", String(gapSec), "-c:a", "pcm_s16le", gapWav,
        ]);
        const list2 = [orderedWavs[0]!];
        for (const w of orderedWavs.slice(1)) list2.push(gapWav, w);
        const concatGap = path.join(audioDir, "spine-list.txt");
        fs.writeFileSync(concatGap, list2.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", concatGap, "-c", "copy", spineFile]);
      } else {
        const concatList = path.join(audioDir, "spine-list.txt");
        fs.writeFileSync(concatList, orderedWavs.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", concatList, "-c", "copy", spineFile]);
      }
    }
    trace.tts = fs.existsSync(path.join(input.wavDir, "sentences.json"))
      ? "wav plug (AuK slices, natural pace)"
      : "wav plug";
    job = patch(job, { providers: trace, progress: 76, outputs: { ...job.outputs, voice: "audio/spine.wav" } });
    upsertDoc({
      id: "audio:vo",
      slate: jobId,
      modality: "audio",
      text: timed.voiceover,
      absPath: spineFile,
    });

    // sound QC on the DELIVERED audio: concat of the padded per-shot wavs —
    // this is the track actually muxed into the lock, spine only feeds the gate
    const lockAudio = jobFile(jobId, "delivery", "lock-audio.wav");
    const lockList = path.join(audioDir, "lock-list.txt");
    fs.writeFileSync(
      lockList,
      cutPlan.shots.map((s) => `file '${h3WavByShot.get(s.id)!.replaceAll("'", "'\\''")}'`).join("\n"),
    );
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", lockList, "-c:a", "pcm_s16le", lockAudio]);
    await think("soundQc");
    await speak("soundQc", "SenseVoice 對稿（delivery/lock-audio.wav）：ASR、情緒、事件、WER、Clipping。");
    // A3 fail-loud: no endpoint, or an unreachable ear = FAIL "unconfigured".
    // Never a schema stand-in for the SenseVoice verdict.
    const earConfigured = cfg.soundQc.endpoint.trim().length > 0;
    const wavCheck = earConfigured ? wavPrecheck({ audioFile: lockAudio }) : null;
    const remoteSv = earConfigured ? await senseVoiceHttp(lockAudio).catch(() => null) : null;
    const sound = !earConfigured
      ? soundQcUnconfigured()
      : remoteSv && wavCheck
        ? soundQcFromRemote({
            remote: remoteSv,
            expectedText: timed.voiceover,
            expectedEmotion: "NEUTRAL",
            cloneSimilarity: 1,
            wav: wavCheck,
          })
        : soundQcUnconfigured(`sensevoice ${cfg.soundQc.endpoint} unreachable or unparseable`);
    trace.senseVoice = earConfigured && remoteSv ? "SenseVoice HTTP" : "SenseVoice FAIL (unconfigured)";
    job = patch(job, { soundQc: sound, providers: trace, progress: 82 });
    await speak("soundQc", `Sound QC ${sound.pass ? "PASS" : "FAIL"}  peak ${sound.peak.toFixed(2)}  silence ${sound.silenceRatio.toFixed(2)}`, sound.pass ? "pass" : "fail");

    // editor: machine gate, per-shot mux (own wav, drop H3 audio), concat only after gate
    // MULTISHOT_WIRE: a multi-shot segment muxes ONCE against its concatenated
    // wav — the segment is one continuous take
    await think("editor");
    const toEditor = seal({
      slate: jobId,
      from: "boards",
      to: "editor",
      payload: { cut: continuity.cut },
    });
    const { cut } = open(toEditor, { slate: jobId, to: "editor" });
    await speak("editor", `${packetLine(toEditor)} · 照分鏡接：${cut.join(" → ")}。唔重排。`);
    const segGateSegments = segManifest?.length ? segManifest : undefined;
    const gate = await checkGate({
      plan: cutPlan,
      motionDir,
      spineWav: fs.existsSync(spineFile) ? spineFile : undefined,
      outFile: jobFile(jobId, "concat_gate.json"),
      ...(segGateSegments ? { segments: segGateSegments.map((s) => ({ shots: s.shots })) } : {}),
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
      if (!fs.existsSync(mp4)) throw new Error(`cut ${t.id} missing from motion`);
      const wav = t.shots.length === 1
        ? h3WavByShot.get(t.shots[0]!)!
        : await concatWav(t.shots.map((id) => h3WavByShot.get(id)!), path.join(motionDir, `${t.id}.wav`));
      const out = path.join(motionDir, `${t.id}.muxed.mp4`);
      await ffmpeg(muxArgs(mp4, wav, out));
      muxed.push(out);
    }
    const muxList = jobFile(jobId, "motion", "mux-list.txt");
    fs.writeFileSync(muxList, muxed.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));
    const pictureLock = jobFile(jobId, "delivery", "picture-lock.mp4");
    await ffmpeg(concatCopyArgs(muxList, pictureLock));

    const markGeometry = localPictureQc({
      stills,
      sheet: input.scene ? { ...timed, shots: shotsForScene(timed.shots, input.scene) } : timed,
      target: "video",
    });
    // segment renders pin their video_qc under the segment id
    const videoQcPass = muxTargets.length
      ? muxTargets.every((t) => pinVideoQcAccepted(motionDir, t.id))
      : cut.every((id) => pinVideoQcAccepted(motionDir, id));
    job = patch(job, {
      pictureQcVideo: markGeometry,
      progress: 92,
      outputs: { ...job.outputs, concatGate: "concat_gate.json", pictureLock: "delivery/picture-lock.mp4" },
    });

    await think("delivery");
    await speak("delivery", "交片包：mp4 + continuity + QC + Blender。故事＝分鏡＝剪接。");
    const deliveredSec = await mediaSeconds(pictureLock);
    const report = {
      slate: job.slate,
      title: timed.title,
      cut: continuity.cut,
      providers: trace,
      // measured off the delivered mp4, not the planned sum
      delivered_s: deliveredSec,
      planned_s: timed.durationSec,
      provenance: timed.provenance,
      soundQc: sound,
      pictureQcStills: geometry,
      markGeometry,
      // the padded tail per shot IS the delivered speech gap
      gap_delivered_s: Object.fromEntries(gapDelivered),
      locked: Boolean(sound.pass && videoQcPass),
    };
    fs.writeFileSync(jobFile(jobId, "delivery", "qc.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(jobFile(jobId, "delivery", "callsheet.md"), markdownCallSheet(timed, job.slate));
    const pictureLocked = report.locked;
    job = patch(job, {
      status: pictureLocked ? "locked" : "blocked",
      progress: 100,
      currentAgent: "delivery",
      providers: trace,
      vault: vaultStats(jobId),
      outputs: {
        ...job.outputs,
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
    job = patch(job, { status: "failed", error: message });
    // D1a: the throw site also lands a hard row (zod / pipeline) — the soft
    // rows written earlier in topological order already sit above it
    appendViolation(jobDir(jobId), hardErrorRow(error));
    emit(jobId, { agent: "system", level: "error", message });
    // reflector: strictly after the job is marked failed, never inside a live
    // stage — the 27B reads this grave and curatePlaybook (code) writes lessons
    try {
      const lessons = await runReflector({ jobId, crew: cfg.crew });
      for (const line of lessons) emit(jobId, { agent: "system", level: "warn", message: line });
    } catch (err) {
      emit(jobId, {
        agent: "system",
        level: "warn",
        message: `Reflector 未行到：${err instanceof Error ? err.message : String(err)}`,
      });
    }
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

export function describeFloor() {
  return floorLine();
}
