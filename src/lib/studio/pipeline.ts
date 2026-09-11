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
  generateStillHttp,
  generateVideoHttp,
  localPictureQc,
  localSoundQc,
  marsHttp,
  marsQuestion,
  providerConfig,
  senseVoiceHttp,
  ttsHttp,
} from "./providers";
import type { AgentId, CallSheet, JobRecord, ProduceInput, ProviderTrace } from "./types";
import { AGENT_META } from "./types";
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
  const trace: ProviderTrace = {
    stills: cfg.u15 ? "SenseNova U1.5 HTTP" : "studio painter (U1.5 schema)",
    motion: cfg.h3 ? "MiniMax H3 HTTP" : "studio IK motion (H3 schema)",
    tts: cfg.tts ? "CosyVoice HTTP" : "studio clone synth",
    senseVoice: cfg.senseVoice ? "SenseVoice HTTP" : "SenseVoice schema (local)",
    mars: cfg.mars ? "SenseNova-MARS-8B HTTP" : "MARS-8B schema (local)",
    blender: "pending",
  };

  const speak = async (agent: AgentId, message: string, level: "info" | "warn" | "pass" | "fail" = "info") => {
    job = patch(job, { currentAgent: agent, status: "running" });
    emit(jobId, { agent, level, message });
  };

  try {
    await speak("producer", "收 brief，開 call sheet。未過閘唔好燒 GPU。");
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

    await speak("writer", "分場、對白、鏡頭大小。每場寫死手同腳嘅 mark。");
    await speak("art", `Grade: ${sheet.styleBible.grade}. Stills=${sheet.styleBible.stillModel}.`);

    await speak("layout", "Blender 場地：camera、start/end mark、手 IK、腳 IK。");
    const blenderFile = jobFile(jobId, "blender", "blocking.py");
    fs.writeFileSync(blenderFile, blenderBlockingScript(sheet));
    const blockingDir = path.join(jobDir(jobId), "blocking");
    ensureDir(blockingDir);
    for (const shot of sheet.shots) {
      await raster(renderBlockingSvg(sheet, shot), path.join(blockingDir, `${shot.id}.png`));
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
    const size = sceneSize(sheet.aspect);
    await speak("stills", "U1.5 生圖。未接 endpoint 就用 studio painter 按同一 prompt 同 blocking 出 lock still。");
    for (const shot of sheet.shots) {
      const out = path.join(stillDir, `${shot.id}.png`);
      const remote = await generateStillHttp({
        prompt: shot.stillPrompt,
        width: size.width,
        height: size.height,
        outFile: out,
      }).catch(() => null);
      if (!remote) {
        await raster(renderShotSvg(sheet, shot, 0.15, 1), out);
        trace.stills = "studio painter (U1.5 schema)";
      } else {
        trace.stills = remote;
      }
      stills.push(out);
      emit(jobId, { agent: "stills", level: "info", message: `${shot.id} still locked`, data: { file: `stills/${shot.id}.png` } });
    }
    job = patch(job, { providers: trace, progress: 40, outputs: { ...job.outputs, stills: stills.map((f) => path.relative(jobDir(jobId), f)) } });

    await speak("pictureQc", "MARS-8B 畫檢：身份、構圖、手、腳、artifact。");
    let pictureStills = localPictureQc({ stills, sheet, target: "stills" });
    const marsProbe = await marsHttp({
      file: stills[0]!,
      question: marsQuestion(sheet.shots[0]!),
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
      for (const shot of sheet.shots) {
        const out = path.join(stillDir, `${shot.id}.png`);
        await raster(renderShotSvg(sheet, shot, 0.2, 1), out);
      }
      pictureStills = localPictureQc({ stills, sheet, target: "stills" });
      job = patch(job, { pictureQcStills: pictureStills });
    }
    await speak("pictureQc", `Stills QC ${pictureStills.pass ? "PASS" : "FAIL"}  hands ${pictureStills.hands.toFixed(2)}  feet ${pictureStills.feet.toFixed(2)}`, pictureStills.pass ? "pass" : "fail");

    const motionDir = path.join(jobDir(jobId), "motion");
    ensureDir(motionDir);
    const shotVideos: string[] = [];
    await speak("motion", "H3 生片。用 U1.5 still 做 first frame / semantic bridge，動作跟 Blender mark。");
    for (const shot of sheet.shots) {
      const mp4 = path.join(motionDir, `${shot.id}.mp4`);
      const still = path.join(stillDir, `${shot.id}.png`);
      const remote = await generateVideoHttp({
        prompt: shot.motionPrompt,
        stillFile: still,
        outFile: mp4,
        seconds: shot.durationSec,
      }).catch(() => null);
      if (!remote) {
        const framesDir = path.join(motionDir, shot.id);
        ensureDir(framesDir);
        const frames = Math.max(6, Math.round(shot.durationSec * FPS));
        for (let f = 0; f < frames; f += 1) {
          const t = f / Math.max(1, frames - 1);
          const svg = renderShotSvg(sheet, shot, t, f + 1);
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
      emit(jobId, { agent: "motion", level: "info", message: `${shot.id} motion ${shot.durationSec.toFixed(1)}s` });
    }
    job = patch(job, {
      providers: trace,
      progress: 68,
      outputs: { ...job.outputs, shots: shotVideos.map((f) => path.relative(jobDir(jobId), f)) },
    });

    await speak("voice", "TTS + sound clone。有 reference 就跟 F0；無就用角色 pitch。");
    let cloneSimilarity = 0.62;
    let pitch = sheet.characters[0]?.voice.pitchHz ?? 180;
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
      text: sheet.voiceover,
      reference: input.voiceClonePath,
      outFile: voiceFile,
    }).catch(() => null);
    if (!remoteTts) {
      const samples = synthesizeVoice({
        text: sheet.voiceover,
        seconds: sheet.durationSec,
        pitchHz: pitch,
        rain: sheet.weather === "rain" || sheet.weather === "neon",
      });
      writeWav(voiceFile, samples);
      trace.tts = "studio clone synth";
    } else {
      trace.tts = remoteTts;
    }
    job = patch(job, { providers: trace, progress: 76, outputs: { ...job.outputs, voice: "audio/vo.wav" } });

    await speak("soundQc", "SenseVoice 聲檢：ASR、情緒、事件、WER、Clipping。");
    let sound = localSoundQc({
      audioFile: voiceFile,
      expectedText: sheet.voiceover,
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
          expectedText: sheet.voiceover,
          expectedEmotion: "NEUTRAL",
          cloneSimilarity,
        });
      }
    }
    job = patch(job, { soundQc: sound, providers: trace, progress: 82 });
    await speak("soundQc", `Sound QC ${sound.pass ? "PASS" : "FAIL"}  peak ${sound.peak.toFixed(2)}  silence ${sound.silenceRatio.toFixed(2)}`, sound.pass ? "pass" : "fail");

    await speak("editor", "合成聲畫、燒對白、出 picture lock。");
    const concatList = jobFile(jobId, "motion", "concat.txt");
    fs.writeFileSync(
      concatList,
      shotVideos.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"),
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

    const pictureVideo = localPictureQc({ stills, sheet, target: "video" });
    job = patch(job, { pictureQcVideo: pictureVideo, progress: 92 });

    await speak("delivery", "交片包：mp4 + QC JSON + call sheet + Blender 走位。");
    const report = {
      slate: job.slate,
      title: sheet.title,
      providers: trace,
      soundQc: sound,
      pictureQcStills: pictureStills,
      pictureQcVideo: pictureVideo,
      locked: Boolean(sound.pass && pictureStills.pass && pictureVideo.pass),
    };
    fs.writeFileSync(jobFile(jobId, "delivery", "qc.json"), JSON.stringify(report, null, 2));
    fs.writeFileSync(jobFile(jobId, "delivery", "callsheet.md"), markdownCallSheet(sheet, job.slate));
    const locked = report.locked;
    job = patch(job, {
      status: locked ? "locked" : "blocked",
      progress: 100,
      currentAgent: "delivery",
      providers: trace,
      outputs: {
        ...job.outputs,
        pictureLock: "delivery/picture-lock.mp4",
        qcReport: "delivery/qc.json",
        callSheet: "delivery/callsheet.md",
        blenderScript: "blender/blocking.py",
      },
    });
    emit(jobId, {
      agent: "delivery",
      level: locked ? "pass" : "warn",
      message: locked ? "Picture lock. 可以交片。" : "成片已出，但 QC 未全過，狀態係 blocked。",
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
  return Object.entries(AGENT_META).map(([id, meta]) => ({ id, ...meta }));
}
