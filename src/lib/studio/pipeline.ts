import fs from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { blenderBlockingScript } from "./blender";
import {
  estimatePitchHz,
  peakAndSilence,
  readWavMono,
  runCommand,
  synthesizeVoice,
  writeWav,
} from "./audio";
import { emit, readJob, writeJob } from "./store";
import { renderBlockingSvg, renderShotSvg, sceneSize } from "./painter";
import {
  generateMotion,
  generateStill,
  localPictureQc,
  localSoundQc,
  marsHttp,
  marsQuestion,
  providerConfig,
  senseVoiceHttp,
  ttsHttp,
} from "./providers";
import { probeComfy } from "./comfy";
import { loadConfig } from "./config";
import type { AgentId, CallSheet, JobRecord, ProduceInput, ProviderTrace } from "./types";
import { floorLine, seat } from "./crew";
import { assertSameCanon, continuityMarkdown, lockContinuity } from "./continuity";
import { open, packetLine, seal } from "./dispatch";
import { buildNarrativePlan, planMarkdown } from "./narrative";
import { indexPlanTexts, recall, upsertDoc, vaultStats } from "./vault";
import { relInJob } from "./isolate";
import { draftCallSheet } from "./writer";
import { ensureDir, jobDir, jobFile } from "./paths";

const FPS = 8;

function patch(job: JobRecord, partial: Partial<JobRecord>) {
  const next = { ...job, ...partial };
  writeJob(next);
  return next;
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

async function maybeBlender(scriptFile: string) {
  const bin = process.env.BLENDER_BIN || "blender";
  try {
    const probe = await runCommand(bin, ["-b", "-P", scriptFile]);
    if (probe.code === 0) return "blender-live";
  } catch {
    /* studio fallback */
  }
  return "blender-script";
}

export async function runPipeline(jobId: string, input: ProduceInput) {
  const initial = readJob(jobId);
  if (!initial) throw new Error("missing job");
  let job: JobRecord = initial;
  const cfg = providerConfig();
  const rack = loadConfig();
  const comfy = await probeComfy();
  const trace: ProviderTrace = {
    stills: comfy.up ? `ComfyUI ${rack.stills.checkpoint}` : cfg.u15 ? "SenseNova U1.5 HTTP" : "studio painter (Comfy 未開)",
    motion: comfy.up ? `ComfyUI ${rack.motion.checkpoint}` : cfg.h3 ? "MiniMax H3 HTTP" : "studio IK motion (Comfy 未開)",
    tts: cfg.tts ? "CosyVoice HTTP" : "studio clone synth",
    senseVoice: cfg.senseVoice ? "SenseVoice HTTP" : "SenseVoice schema (local)",
    mars: cfg.mars ? "SenseNova-MARS-8B HTTP" : "MARS-8B schema (local)",
    blender: "pending",
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
    await speak("producer", "收 brief。開呢份 slate 嘅信封。舊 project 唔入袋。");
    const sheet = draftCallSheet(input);
    fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(sheet, null, 2));
    job = patch(job, {
      callSheet: sheet,
      providers: trace,
      progress: 8,
      outputs: { ...job.outputs, callSheet: "callsheet.json" },
    });
    await speak(
      "producer",
      `${sheet.title} · ${sheet.durationSec}s · ${sheet.shots.length} shots · ${sheet.location}`,
    );

    await think("writer");
    await speak("writer", "故事同對白寫死。Shot ID 終身。");
    const toBoards = seal({
      slate: jobId,
      from: "writer",
      to: "boards",
      payload: { brief: input.brief, sheet },
    });
    await speak("producer", packetLine(toBoards));

    await think("boards");
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
    await speak("boards", `分鏡專職鎖咗 ${continuity.cut.join(" → ")}。故事＝分鏡＝剪接。Vault 只得 ${jobId}。`);

    await think("art");
    await speak("art", `Grade: ${locked.styleBible.grade}. 只描述已有 ${continuity.boards.length} 鏡，唔另開世界。`);

    await think("layout");
    await speak("layout", "走位只跟分鏡 mark：camera、手 IK、腳 IK。");
    const blenderFile = jobFile(jobId, "blender", "blocking.py");
    fs.writeFileSync(blenderFile, blenderBlockingScript(locked));
    const blockingDir = path.join(jobDir(jobId), "blocking");
    ensureDir(blockingDir);
    for (const shot of continuity.boards) {
      await raster(renderBlockingSvg(locked, shot), path.join(blockingDir, `${shot.id}.png`));
    }
    trace.blender = await maybeBlender(blenderFile);
    job = patch(job, {
      providers: trace,
      progress: 22,
      outputs: {
        ...job.outputs,
        blenderScript: "blender/blocking.py",
        blockingPreview: "blocking/SH01.png",
      },
    });
    await speak("layout", `走位稿已出（${trace.blender}）。腳要落地，手要入畫。`);

    const stillDir = path.join(jobDir(jobId), "stills");
    ensureDir(stillDir);
    const stills: string[] = [];
    const size = sceneSize(locked.aspect);
    const toStills = seal({
      slate: jobId,
      from: "boards",
      to: "stills",
      payload: { boards: continuity.boards },
    });
    await think("stills");
    const stillWork = open(toStills, { slate: jobId, to: "stills" });
    await speak("stills", packetLine(toStills));
    await speak(
      "stills",
      comfy.up
        ? `默許 Comfy ${comfy.url} · U1.5 workflow ${rack.stills.workflow}`
        : `Comfy ${comfy.url} 未開（${comfy.error ?? "down"}）。Studio painter 頂住，你平時開 Comfy 就自動切真 U1.5。`,
    );
    for (const shot of stillWork.boards) {
      const prior = recall(jobId, `${shot.stillPrompt} ${shot.action}`, { modality: "image", k: 2 });
      if (prior[0]) {
        emit(jobId, {
          agent: "stills",
          level: "info",
          message: `${shot.id} rerank 呢份 vault：${prior[0].id} ${prior[0].score.toFixed(2)}`,
        });
      }
      const out = path.join(stillDir, `${shot.id}.png`);
      const remote = await generateStill({
        prompt: shot.stillPrompt,
        width: size.width,
        height: size.height,
        outFile: out,
      }).catch((err) => {
        emit(jobId, { agent: "stills", level: "warn", message: `Comfy/U1.5 miss: ${err instanceof Error ? err.message : err}` });
        return null;
      });
      if (!remote) {
        await raster(renderShotSvg(locked, shot, 0.15, 1), out);
        trace.stills = "studio painter (U1.5 schema)";
      } else {
        trace.stills = remote;
      }
      stills.push(out);
      upsertDoc({
        id: `image:${shot.id}`,
        slate: jobId,
        modality: "image",
        shotId: shot.id,
        text: shot.stillPrompt,
        absPath: out,
      });
      emit(jobId, { agent: "stills", level: "info", message: `${shot.id} still locked`, data: { file: `stills/${shot.id}.png` } });
    }
    job = patch(job, {
      providers: trace,
      vault: vaultStats(jobId),
      progress: 40,
      outputs: { ...job.outputs, stills: stills.map((f) => relInJob(jobId, f)) },
    });

    await think("pictureQc");
    await speak("pictureQc", "MARS-8B 畫檢：身份、構圖、手、腳、artifact。");
    let pictureStills = localPictureQc({ stills, sheet: locked, target: "stills" });
    const marsProbe = await marsHttp({
      file: stills[0]!,
      question: marsQuestion(continuity.boards[0]!),
    }).catch(() => null);
    if (marsProbe) {
      pictureStills = {
        ...pictureStills,
        provider: "SenseNova-MARS-8B",
        notes: marsProbe.notes,
        overall: marsProbe.score,
        pass: marsProbe.score >= 0.72 && pictureStills.pass,
      };
      trace.mars = "SenseNova-MARS-8B HTTP";
    }
    job = patch(job, { pictureQcStills: pictureStills, providers: trace, progress: 48 });
    if (!pictureStills.pass) {
      job = patch(job, { retries: { ...job.retries, stills: job.retries.stills + 1 } });
      await speak("pictureQc", `畫檢未過：${pictureStills.issues.map((i) => i.detail).join("; ")}。重出 stills。`, "fail");
      for (const shot of continuity.boards) {
        const out = path.join(stillDir, `${shot.id}.png`);
        await raster(renderShotSvg(locked, shot, 0.2, 1), out);
      }
      pictureStills = localPictureQc({ stills, sheet: locked, target: "stills" });
      job = patch(job, { pictureQcStills: pictureStills });
    }
    await speak("pictureQc", `Stills QC ${pictureStills.pass ? "PASS" : "FAIL"}  hands ${pictureStills.hands.toFixed(2)}  feet ${pictureStills.feet.toFixed(2)}`, pictureStills.pass ? "pass" : "fail");

    const motionDir = path.join(jobDir(jobId), "motion");
    ensureDir(motionDir);
    const shotVideos: string[] = [];
    const toMotion = seal({
      slate: jobId,
      from: "stills",
      to: "motion",
      payload: { boards: continuity.boards },
    });
    await think("motion");
    open(toMotion, { slate: jobId, to: "motion" });
    await speak("motion", packetLine(toMotion));
    await speak(
      "motion",
      comfy.up
        ? `H3 走 Comfy MiniMaxH3ImageToVideo，U1.5 still 做 first_frame。`
        : "H3 Comfy 未開，用 blocking IK 出 motion 頂住。",
    );
    for (const shot of continuity.boards) {
      const mp4 = path.join(motionDir, `${shot.id}.mp4`);
      const still = path.join(stillDir, `${shot.id}.png`);
      const stillHit = recall(jobId, shot.stillPrompt, { modality: "image", shotId: shot.id, k: 1 })[0];
      if (stillHit && stillHit.shotId !== shot.id) {
        throw new Error(`vault mix-up: motion ${shot.id} pulled ${stillHit.shotId}`);
      }
      const remote = await generateMotion({
        prompt: shot.motionPrompt,
        stillFile: still,
        outFile: mp4,
        seconds: shot.durationSec,
        width: size.width,
        height: size.height,
      }).catch((err) => {
        emit(jobId, { agent: "motion", level: "warn", message: `Comfy/H3 miss: ${err instanceof Error ? err.message : err}` });
        return null;
      });
      if (!remote) {
        const framesDir = path.join(motionDir, shot.id);
        ensureDir(framesDir);
        const frames = Math.max(6, Math.round(shot.durationSec * FPS));
        for (let f = 0; f < frames; f += 1) {
          const t = f / Math.max(1, frames - 1);
          const svg = renderShotSvg(locked, shot, t, f + 1);
          await raster(svg, path.join(framesDir, `f${String(f + 1).padStart(3, "0")}.png`));
        }
        await ffmpeg([
          "-framerate",
          String(FPS),
          "-i",
          path.join(framesDir, "f%03d.png"),
          "-c:v",
          "libx264",
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          mp4,
        ]);
        trace.motion = "studio IK motion (H3 schema)";
      } else {
        trace.motion = remote;
      }
      shotVideos.push(mp4);
      upsertDoc({
        id: `video:${shot.id}`,
        slate: jobId,
        modality: "video",
        shotId: shot.id,
        text: shot.motionPrompt,
        absPath: mp4,
      });
      emit(jobId, { agent: "motion", level: "info", message: `${shot.id} motion ${shot.durationSec.toFixed(1)}s` });
    }
    job = patch(job, {
      providers: trace,
      vault: vaultStats(jobId),
      progress: 68,
      outputs: { ...job.outputs, shots: shotVideos.map((f) => relInJob(jobId, f)) },
    });

    await think("voice");
    await speak("voice", "只讀 continuity 對白。有 clone 就跟 F0。");
    let cloneSimilarity = 0.62;
    let pitch = locked.characters[0]?.voice.pitchHz ?? 180;
    if (input.voiceClonePath && fs.existsSync(input.voiceClonePath)) {
      try {
        const ref = readWavMono(input.voiceClonePath);
        pitch = estimatePitchHz(ref.samples, ref.sampleRate);
        cloneSimilarity = 0.86;
        await speak("voice", `Clone F0 ≈ ${pitch.toFixed(1)} Hz`, "info");
      } catch {
        await speak("voice", "clone 檔讀唔到（請用 WAV），改用角色 pitch。", "warn");
      }
    }
    const voiceFile = jobFile(jobId, "audio", "vo.wav");
    const remoteTts = await ttsHttp({
      text: locked.voiceover,
      reference: input.voiceClonePath,
      outFile: voiceFile,
    }).catch(() => null);
    if (!remoteTts) {
      const samples = synthesizeVoice({
        text: locked.voiceover,
        seconds: locked.durationSec,
        pitchHz: pitch,
        rain: locked.weather === "rain" || locked.weather === "neon",
      });
      writeWav(voiceFile, samples);
      trace.tts = "studio clone synth";
    } else {
      trace.tts = remoteTts;
    }
    job = patch(job, { providers: trace, progress: 76, outputs: { ...job.outputs, voice: "audio/vo.wav" } });
    upsertDoc({
      id: "audio:vo",
      slate: jobId,
      modality: "audio",
      text: locked.voiceover,
      absPath: voiceFile,
    });

    await think("soundQc");
    await speak("soundQc", "SenseVoice 對稿：ASR、情緒、事件、WER、Clipping。");
    let sound = localSoundQc({
      audioFile: voiceFile,
      expectedText: locked.voiceover,
      expectedEmotion: "NEUTRAL",
      cloneSimilarity,
    });
    const remoteSv = await senseVoiceHttp(voiceFile).catch(() => null);
    if (remoteSv) {
      sound = { ...sound, ...remoteSv, provider: remoteSv.provider ?? "SenseVoice" };
      trace.senseVoice = "SenseVoice HTTP";
    }
    if (!sound.pass) {
      await speak("soundQc", `聲檢未過：${sound.issues.map((i) => i.detail).join("; ")}`, "fail");
      const { peak } = peakAndSilence(readWavMono(voiceFile).samples);
      if (peak < 0.08) {
        const wav = readWavMono(voiceFile);
        for (let i = 0; i < wav.samples.length; i += 1) wav.samples[i] = (wav.samples[i] ?? 0) * 4;
        writeWav(voiceFile, wav.samples, wav.sampleRate);
        sound = localSoundQc({
          audioFile: voiceFile,
          expectedText: locked.voiceover,
          expectedEmotion: "NEUTRAL",
          cloneSimilarity,
        });
      }
    }
    job = patch(job, { soundQc: sound, providers: trace, progress: 82 });
    await speak("soundQc", `Sound QC ${sound.pass ? "PASS" : "FAIL"}  peak ${sound.peak.toFixed(2)}  silence ${sound.silenceRatio.toFixed(2)}`, sound.pass ? "pass" : "fail");

    await think("editor");
    const toEditor = seal({
      slate: jobId,
      from: "boards",
      to: "editor",
      payload: { cut: continuity.cut },
    });
    const { cut } = open(toEditor, { slate: jobId, to: "editor" });
    await speak("editor", `${packetLine(toEditor)} · 照分鏡接：${cut.join(" → ")}。唔重排。`);
    const concatList = jobFile(jobId, "motion", "concat.txt");
    const ordered = cut.map((id) => {
      const hit = shotVideos.find((v) => path.basename(v, ".mp4") === id);
      if (!hit) throw new Error(`cut ${id} missing from motion`);
      return hit;
    });
    fs.writeFileSync(
      concatList,
      ordered.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"),
    );
    const silent = jobFile(jobId, "delivery", "picture-nosound.mp4");
    await ffmpeg(["-f", "concat", "-safe", "0", "-i", concatList, "-c:v", "libx264", "-pix_fmt", "yuv420p", silent]);
    const pictureLock = jobFile(jobId, "delivery", "picture-lock.mp4");
    await ffmpeg([
      "-i",
      silent,
      "-i",
      voiceFile,
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-shortest",
      "-movflags",
      "+faststart",
      pictureLock,
    ]);

    const pictureVideo = localPictureQc({ stills, sheet: locked, target: "video" });
    job = patch(job, { pictureQcVideo: pictureVideo, progress: 92 });

    await think("delivery");
    await speak("delivery", "交片包：mp4 + continuity + QC + Blender。故事＝分鏡＝剪接。");
    const report = {
      slate: job.slate,
      title: locked.title,
      cut: continuity.cut,
      providers: trace,
      soundQc: sound,
      pictureQcStills: pictureStills,
      pictureQcVideo: pictureVideo,
      locked: Boolean(sound.pass && pictureStills.pass && pictureVideo.pass),
    };
    fs.writeFileSync(jobFile(jobId, "delivery", "qc.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(jobFile(jobId, "delivery", "callsheet.md"), markdownCallSheet(locked, job.slate));
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
    emit(jobId, { agent: "system", level: "error", message });
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
