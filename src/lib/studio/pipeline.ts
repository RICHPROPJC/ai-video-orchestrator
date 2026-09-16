import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { blenderBlockingScript } from "./blender";
import { readWavMono, runCommand } from "./audio";
import { emit, readJob, writeJob } from "./store";
import { renderBlockingSvg, sceneSize } from "./painter";
import { localPictureQc, localSoundQc, senseVoiceHttp } from "./providers";
import { loadConfig, type SlateConfig } from "./config";
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
import { ensurePortraits } from "./portraits";
import { ensureDir, jobDir, jobFile, projectsDir, seatsDir } from "./paths";
import { runReflector } from "./reflector";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { buildCutPlan, type CutPlan } from "./cut-plan";
import { checkGate } from "./concat-gate";
import { writeAnchors } from "./dhash-anchors";
import { assertFiguresVisible, blockoutFromPlug, extractFrame0, renderBlockout, stillFrameFor } from "./blockout";
import { keyframeEditPrompt, keyframeRequire, loadBaseCast } from "./keyframe-prompt";
import { buildProse, buildProsePositive, validateProse, wardrobeClauses, SCRIPT_HEADER } from "./h3-prose";
import { submitH3Shot } from "./h3-submit";
import type { H3GraphVariant } from "./h3-r2v-graph";
import { checkHealth, buildEditPayload, u15Edit, type EditPayload, type U15EditRecord } from "./u15-edit";
import { scpToHost, u15RefPath } from "./scp-upload";
import { runPhotoQc, pinQcAccepted, type QcRequire } from "./photo-qc";
import { pinVideoQcAccepted, runVideoQc } from "./video-qc";
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

function h3MotionPack(
  timed: CallSheet,
  shot: Shot,
  variant: H3GraphVariant,
  stillPng: string,
  portraitFiles: Record<string, string>,
) {
  if (variant === "a") {
    return { prose: buildProse(timed, shot), refImageFiles: undefined as string[] | undefined, kfEnd: stillPng };
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
  return [
    "-i", mp4,
    "-i", h3Wav,
    "-map", "0:v", "-map", "1:a",
    "-af", "loudnorm=I=-18:TP=-1.5:LRA=11",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    out,
  ];
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
    senseVoice: cfg.soundQc.endpoint ? "SenseVoice HTTP" : "SenseVoice schema (local)",
    mars: `MARS ${cfg.pictureQc.endpoint}`,
    blender: "pending",
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
    const stillDir = path.join(jobDir(jobId), "stills");
    const skipPortraits =
      input.resume && continuity.boards.every((shot) => pinQcAccepted(stillDir, shot.id));
    let portraits: Awaited<ReturnType<typeof ensurePortraits>>;
    if (skipPortraits) {
      emit(jobId, {
        agent: "stills",
        level: "info",
        message: "repair: portraits saw ensurePortraits became skip (all stills pinned GREEN on resume)",
      });
      await speak("stills", "肖像跳過：stills 已全 GREEN，肖像唔再守門");
      portraits = { files: {}, made: [], plugged: [], kept: [] };
    } else {
      await think("stills");
      portraits = await ensurePortraits({
        sheet: locked,
        outDir: path.join(jobDir(jobId), "portraits"),
        plugDir: input.portraitsDir,
        server: cfg.stills.url,
        seed: cfg.motion.seed,
        onEvent: (message, data) => emit(jobId, { agent: "stills", level: "info", message, data }),
      });
      await speak("stills", `肖像齊：plug ${portraits.plugged.length}、新做 ${portraits.made.length}。`);
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

    // per-shot grey blockout (plug or WORKBENCH render), frame 0, dHash anchors
    const blockoutDir = path.join(jobDir(jobId), "blockout");
    ensureDir(blockoutDir);
    const blockouts: string[] = [];
    for (const shot of continuity.boards) {
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
        const done = await renderBlockout({
          sheet: timed,
          shot,
          frames,
          outMp4,
        });
        trace.blender = `blender-workbench ${done.frames}f`;
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

    // stills lane prompts + require (built in both live and dry run)
    ensureDir(stillDir);
    // base cast (L1b): a job with a drama reads its fixed wardrobe from
    // projects/<drama>/base/cast.json — a base fact, not a playbook bullet
    const baseCast = job.drama ? loadBaseCast(projectsDir(), job.drama) : undefined;
    const stillPlans = continuity.boards.map((boardShot, i) => {
      const shot = timed.shots.find((s) => s.id === boardShot.id)!;
      const prev = i > 0 ? continuity.boards[i - 1]! : null;
      const seenChars = new Set(continuity.boards.slice(0, i).flatMap((b) => b.marks.map((m) => m.characterId)));
      const newChar = shot.marks.some((m) => !seenChars.has(m.characterId));
      const first = i === 0 || (prev ? prev.size !== shot.size : false) || newChar;
      const prompt = keyframeEditPrompt(timed, shot, { first, ...(baseCast ? { cast: baseCast } : {}) });
      const require = keyframeRequire(shot);
      // D1a trace: soft edge invariants (boards→keyframe, keyframe→stills),
      // written for pass and fail alike, always before any QC gate can fail
      const softRows = [...checkBoardsToKeyframe(timed.characters, shot, prompt), ...checkKeyframeToStills(shot, require)];
      for (const row of softRows) appendViolation(jobDir(jobId), row);
      fs.writeFileSync(path.join(stillDir, `${shot.id}.require.json`), JSON.stringify(require, null, 2));
      return { shot, first, prompt, require };
    });

    if (input.dryRun) {
      const variant = h3GraphVariant(input);
      const receipts: string[] = [];
      for (const { shot } of stillPlans) {
        const stillPng = path.join(stillDir, `${shot.id}.png`);
        const pack = h3MotionPack(timed, shot, variant, stillPng, portraits.files);
        const { receiptFile } = await submitH3Shot({
          prose: pack.prose,
          wavFile: h3WavByShot.get(shot.id)!,
          blockoutMp4: path.join(blockoutDir, `${shot.id}.mp4`),
          kfStart: stillPng,
          kfEnd: pack.kfEnd,
          refImageFiles: pack.refImageFiles,
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
    let prevKeyframe: string | null = null;
    const editInputs = new Map<string, { prompt: string; nodePaths: string[]; base: string; refs: string[]; first: boolean }>();
    const greenAlready = new Set<string>();
    // g6 hop geometry: stills + picture QC run only the hop's shots; the rest
    // of the slate's stills land in other hops, so both lanes crop to the hop
    const hopStillIds = new Set(shotsForScene(timed.shots, input.scene).map((s) => s.id));
    const hopStillPlans = input.scene ? stillPlans.filter((p) => hopStillIds.has(p.shot.id)) : stillPlans;
    if (input.scene) {
      await speak("stills", `--scene ${input.scene} hop：stills/QC ${hopStillPlans.length}/${stillPlans.length} 鏡。`);
    }
    for (const { shot, first, prompt, require } of hopStillPlans) {
      const out = path.join(stillDir, `${shot.id}.png`);
      const recordJson = path.join(stillDir, `${shot.id}.u15_edit.json`);
      const base = path.join(blockoutDir, `${shot.id}.f0.png`);
      // a hash-matched GREEN keyframe is finished work; resume chains from it
      if (input.resume && pinQcAccepted(stillDir, shot.id)) {
        prevKeyframe = out;
        stills.push(out);
        greenAlready.add(shot.id);
        await speak("stills", `${shot.id} keyframe 照舊（QC 已 GREEN），唔重出。`);
        continue;
      }
      const stillStarted = Date.now();
      const refIds = [...new Set(shot.marks.map((m) => m.characterId))];
      const refFiles = first
        ? refIds.map((id) => {
            const p = portraits.files[id];
            if (!p || !fs.existsSync(p)) throw new Error(`${shot.id}: 首次出場冇肖像（${id}）`);
            return p;
          })
        : [prevKeyframe!];
      if (refFiles.some((r) => !r)) throw new Error(`${shot.id}: no ref for /edit (first=${first}, no previous keyframe)`);
      const images = [base, ...refFiles];
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
    }
    job = patch(job, {
      providers: trace,
      vault: vaultStats(jobId),
      progress: 45,
      outputs: { ...job.outputs, stills: stills.map((f) => relInJob(jobId, f)) },
    });

    // picture QC: plan geometry pre-check, then blind MARS per still — GREEN or fail
    await think("pictureQc");
    await speak("pictureQc", "MARS 盲測：人數、灰模、物件。本地 schema 只做走位預檢。");
    // --scene hop: geometry vs hop stills only (full slate stills land across hops)
    const geometry = localPictureQc({ stills, sheet: hopGeometrySheet(timed, input.scene), target: "stills" });
    if (!geometry.pass) {
      const detail = geometry.issues.map((i) => i.detail).join("; ");
      // D1a: a hard QC fail is also a violation row, upstream soft rows already on disk
      appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc-geometry", geometry.issues.map((i) => i.detail)));
      throw new Error(`picture QC plan-geometry pre-check failed: ${detail}`);
    }
    for (const { shot, require } of hopStillPlans) {
      if (greenAlready.has(shot.id)) continue;
      const png = path.join(stillDir, `${shot.id}.png`);
      const qcStarted = Date.now();
      const qcJson = path.join(stillDir, `${shot.id}.photo_qc.json`);
      let result = await runPhotoQc(png, qcJson, require);
      if (result.status !== "GREEN") {
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
        const inputs = editInputs.get(shot.id);
        if (!inputs) throw new Error(`picture QC ${shot.id}: no /edit inputs to retry with`);
        const payload = buildEditPayload({
          prompt: inputs.prompt,
          images: inputs.nodePaths,
          width: cfg.stills.width || size.width,
          height: cfg.stills.height || size.height,
        });
        await u15Edit({
          server: cfg.stills.url,
          payload,
          nodePaths: inputs.nodePaths,
          outFile: png,
          recordJson: path.join(stillDir, `${shot.id}.u15_edit.retry.json`),
          health: await checkHealth(cfg.stills.url, inputs.nodePaths.length),
          record: sealEditRecord(inputs, payload),
        });
        result = await runPhotoQc(png, qcJson, require);
      }
      if (result.status !== "GREEN") {
        const reasons = result.checks.fail_reasons.join("; ") || "not GREEN";
        appendViolation(jobDir(jobId), hardPhotoQcRow("photo-qc", result.checks.fail_reasons));
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
      await speak("pictureQc", `${shot.id} GREEN（人數 ${require.people_count}）`, "pass");
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
    }
    trace.mars = `MARS ${cfg.pictureQc.endpoint} (${cfg.pictureQc.model})`;
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
    await speak("motion", `H3 R2V ${cfg.motion.comfyUrl} · <Video 1> motion only · 零 ref_images · 一鏡一 submit。`);
    // C-scene-hop: the scene flag crops the stills/QC lanes above and this
    // motion loop; a no-match scene throws before any H3 is burned
    const motionShots = shotsForScene(stillPlans.map((p) => p.shot), input.scene);
    if (input.scene) {
      await speak("motion", `--scene ${input.scene} hop：燒 ${motionShots.length}/${stillPlans.length} 鏡，其餘唔郁。`);
    }
    for (const shot of motionShots) {
      if (!pinQcAccepted(stillDir, shot.id)) {
        throw new Error(`${shot.id}: photo_qc 未 GREEN（sha 或 schema 唔吻合）— 唔准燒 H3`);
      }
      const variant = h3GraphVariant(input);
      const stillPng = path.join(stillDir, `${shot.id}.png`);
      const pack = h3MotionPack(timed, shot, variant, stillPng, portraits.files);
      const prose = pack.prose;
      if (variant === "a") {
        validateProse(`${SCRIPT_HEADER}\n${prose}`, {
          requireQuote: Boolean(shot.dialogue.trim()),
          wardrobe: wardrobeClauses(timed),
        });
      }
      const doneMp4 = path.join(motionDir, `${shot.id}.mp4`);
      const doneReceipt = path.join(motionDir, `${shot.id}.h3_submit.json`);
      const requirePath = path.join(stillDir, `${shot.id}.require.json`);
      const require = JSON.parse(fs.readFileSync(requirePath, "utf8")) as QcRequire;
      const videoQcJson = path.join(motionDir, `${shot.id}.video_qc.json`);
      const wantFrames = Math.round(
        (cutPlan.shots.find((c) => c.id === shot.id)?.duration_s ?? -1) * 24,
      );
      const frameSnap = fs.existsSync(doneMp4)
        && Math.round((await mediaSeconds(doneMp4)) * 24) === wantFrames;
      // resume keeps an mp4 only when frame clock matches AND blind MARS video_qc is GREEN
      const kept =
        input.resume
        && fs.existsSync(doneMp4)
        && fs.existsSync(doneReceipt)
        && frameSnap
        && pinVideoQcAccepted(motionDir, shot.id);
      if (kept) {
        shotVideos.push(doneMp4);
        receipts.push(relInJob(jobId, doneReceipt));
        await speak("motion", `${shot.id} 照舊，唔重燒 H3（video_qc GREEN）。`);
        continue;
      }
      if (input.resume && fs.existsSync(doneMp4) && fs.existsSync(doneReceipt) && frameSnap) {
        await speak(
          "motion",
          `${shot.id} mp4 時鐘啱但 video_qc 未 GREEN — 下一跳重燒。`,
          "warn",
        );
      }
      const motionStarted = Date.now();
      const { receiptFile } = await submitH3Shot({
        prose,
        wavFile: h3WavByShot.get(shot.id)!,
        blockoutMp4: path.join(blockoutDir, `${shot.id}.mp4`),
        kfStart: stillPng,
        kfEnd: pack.kfEnd,
        refImageFiles: pack.refImageFiles,
        outMp4: path.join(motionDir, `${shot.id}.mp4`),
        receiptJson: path.join(motionDir, `${shot.id}.h3_submit.json`),
        dryRun: false,
        shot: shot.id,
        requireQuote: Boolean(shot.dialogue.trim()),
        wardrobe: wardrobeClauses(timed),
        graphVariant: variant,
        stepsOverride: input.steps,
      });
      const mp4 = path.join(motionDir, `${shot.id}.mp4`);
      shotVideos.push(mp4);
      receipts.push(relInJob(jobId, receiptFile));
      upsertDoc({
        id: `video:${shot.id}`,
        slate: jobId,
        modality: "video",
        shotId: shot.id,
        text: prose,
        absPath: mp4,
      });
      await think("pictureQc");
      const videoQc = await runVideoQc({
        mp4,
        outJson: videoQcJson,
        require,
        shotId: shot.id,
      });
      if (videoQc.status !== "GREEN") {
        const reasons = videoQc.checks.fail_reasons.join("; ") || "not GREEN";
        await speak("motion", `${shot.id} motion 眼 FAIL（${reasons}）— clip 留低。`, "fail");
      } else {
        await speak("motion", `${shot.id} motion 眼 GREEN`, "pass");
      }
      emit(jobId, {
        agent: "motion",
        level: "info",
        message: `${shot.id} motion 完成`,
        data: {
          shot: shot.id, stage: "motion", eye: "motion", verdict: videoQc.status === "GREEN" ? "pass" : "fail",
          proof: `motion/${shot.id}.mp4`, ms: Date.now() - motionStarted,
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
    let sound = localSoundQc({
      audioFile: lockAudio,
      expectedText: timed.voiceover,
      expectedEmotion: "NEUTRAL",
      cloneSimilarity: 1,
    });
    const remoteSv = await senseVoiceHttp(lockAudio).catch(() => null);
    if (remoteSv) {
      sound = { ...sound, ...remoteSv, provider: remoteSv.provider ?? "SenseVoice" };
      trace.senseVoice = "SenseVoice HTTP";
    }
    job = patch(job, { soundQc: sound, providers: trace, progress: 82 });
    await speak("soundQc", `Sound QC ${sound.pass ? "PASS" : "FAIL"}  peak ${sound.peak.toFixed(2)}  silence ${sound.silenceRatio.toFixed(2)}`, sound.pass ? "pass" : "fail");

    // editor: machine gate, per-shot mux (own wav, drop H3 audio), concat only after gate
    await think("editor");
    const toEditor = seal({
      slate: jobId,
      from: "boards",
      to: "editor",
      payload: { cut: continuity.cut },
    });
    const { cut } = open(toEditor, { slate: jobId, to: "editor" });
    await speak("editor", `${packetLine(toEditor)} · 照分鏡接：${cut.join(" → ")}。唔重排。`);
    const gate = await checkGate({
      plan: cutPlan,
      motionDir,
      spineWav: fs.existsSync(spineFile) ? spineFile : undefined,
      outFile: jobFile(jobId, "concat_gate.json"),
    });
    if (!gate.ok) {
      throw new Error(`concat gate FAIL: ${gate.reason}`);
    }
    const muxed: string[] = [];
    for (const shotId of cut) {
      const mp4 = shotVideos.find((v) => path.basename(v, ".mp4") === shotId);
      if (!mp4) throw new Error(`cut ${shotId} missing from motion`);
      const out = path.join(motionDir, `${shotId}.muxed.mp4`);
      await ffmpeg(muxArgs(mp4, h3WavByShot.get(shotId)!, out));
      muxed.push(out);
    }
    const muxList = jobFile(jobId, "motion", "mux-list.txt");
    fs.writeFileSync(muxList, muxed.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));
    const pictureLock = jobFile(jobId, "delivery", "picture-lock.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", muxList, "-c", "copy", pictureLock]);

    const markGeometry = localPictureQc({ stills, sheet: hopGeometrySheet(timed, input.scene), target: "video" });
    const videoQcPass = cut.every((id) => pinVideoQcAccepted(motionDir, id));
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
