/** PR-2：Voice 席（阿聲／配音）——從 pipeline.ts :794-855 抽出
 * AuK TTS + wav plug → spine.wav；順手 concat lock-audio 畀下一席 soundQc。 */

import fs from "node:fs";
import path from "node:path";
import { runCommand as defaultRunCommand } from "../audio";
import type { AgentId, CallSheet, JobRecord, ProviderTrace } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import type { CutPlan } from "../cut-plan";
import type { PluggedShotWav } from "../shot-wav-plug";
import { loadCallSheet } from "../writer";
import { jobDir, jobFile } from "../paths";
import { ffmpeg as defaultFfmpeg, patch as defaultPatch } from "../pipeline/shared";
import { upsertDoc as defaultUpsertDoc } from "../vault";

/** 上游 world 產物——legacy pipeline Ctx 字段；SeatContext 未擴充前用 binder／碟讀。 */
export type VoiceBag = {
  plugged: PluggedShotWav[];
  locked: CallSheet;
  timed: CallSheet;
  cloneRef?: string;
  spineWav?: string;
  audioDir: string;
  cutPlan: CutPlan;
  gapSec: number;
  h3WavByShot: Map<string, string>;
};

export type VoiceDeps = {
  ffmpeg: (args: string[]) => Promise<void>;
  runCommand: (
    cmd: string,
    args: string[],
  ) => Promise<{ code: number; stdout: string; stderr: string }>;
  patch: (job: JobRecord, partial: Partial<JobRecord>) => JobRecord;
  upsertDoc: typeof defaultUpsertDoc;
};

const bags = new Map<string, VoiceBag>();

function defaultVoiceDeps(): VoiceDeps {
  return {
    ffmpeg: defaultFfmpeg,
    runCommand: defaultRunCommand,
    patch: defaultPatch,
    upsertDoc: defaultUpsertDoc,
  };
}

let deps: VoiceDeps = defaultVoiceDeps();

/** Dual-run：legacy pipeline 喺 run 前綁上游 Ctx 字段。 */
export function bindVoiceBag(jobId: string, bag: VoiceBag): void {
  bags.set(jobId, bag);
}

export function unbindVoiceBag(jobId: string): void {
  bags.delete(jobId);
}

/** 測試用：替換 ffmpeg／patch 等副作用。 */
export function _setVoiceDepsForTest(partial: Partial<VoiceDeps>): void {
  deps = { ...deps, ...partial };
}

export function _resetVoiceDepsForTest(): void {
  deps = defaultVoiceDeps();
}

function spokenPlugged(plugged: PluggedShotWav[]): PluggedShotWav[] {
  return plugged.filter((p) => p.source === "auk" || p.source === "event");
}

function plugSourceForShot(
  text: string,
  hasEvents: boolean,
  hasWavDir: boolean,
): PluggedShotWav["source"] {
  if (hasEvents && text) return "event";
  if (!hasWavDir && text) return "auk";
  if (!text) return "silent";
  return "copied";
}

function loadVoiceBagFromDisk(ctx: SeatContext): VoiceBag {
  const audioDir = path.join(jobDir(ctx.jobId), "audio");
  const cutPlan = JSON.parse(
    fs.readFileSync(jobFile(ctx.jobId, "cut_plan.json"), "utf8"),
  ) as CutPlan;
  const locked = loadCallSheet(jobFile(ctx.jobId, "callsheet.json"));
  const spinePath = path.join(audioDir, "spine.wav");
  const spineFromPlug =
    Boolean(ctx.input.wavDir) &&
    fs.existsSync(path.join(ctx.input.wavDir, "spine.wav")) &&
    fs.existsSync(spinePath);
  const hasEvents = fs.existsSync(path.join(audioDir, "events"));
  const hasWavDir = Boolean(ctx.input.wavDir);
  const h3WavByShot = new Map<string, string>();
  const plugged: PluggedShotWav[] = [];

  for (const s of cutPlan.shots) {
    const h3 = path.join(audioDir, `${s.id}.h3.wav`);
    if (fs.existsSync(h3)) h3WavByShot.set(s.id, h3);
    const text = locked.shots.find((x) => x.id === s.id)?.dialogue?.trim() ?? "";
    plugged.push({
      shotId: s.id,
      file: path.join(audioDir, `${s.id}.wav`),
      source: plugSourceForShot(text, hasEvents, hasWavDir),
      text,
    });
  }

  return {
    plugged,
    locked,
    timed: locked,
    cloneRef: ctx.input.voiceClonePath,
    spineWav: spineFromPlug ? spinePath : undefined,
    audioDir,
    cutPlan,
    gapSec: ctx.input.gapSec ?? cutPlan.gap_s ?? 0,
    h3WavByShot,
  };
}

function emptyResult(partial: Partial<SeatResult> & Pick<SeatResult, "status">): SeatResult {
  return {
    stopped: false,
    artifacts: [],
    receipts: [],
    gaps: [],
    violations: [],
    ...partial,
  };
}

function concatFileLine(filePath: string): string {
  return `file '${filePath.replaceAll("'", "'\\''")}'`;
}

function writeConcatList(listPath: string, files: string[]): void {
  fs.writeFileSync(listPath, files.map(concatFileLine).join("\n"));
}

async function concatCopy(listPath: string, outPath: string): Promise<void> {
  await deps.ffmpeg(["-f", "concat", "-safe", "0", "-i", listPath, "-c", "copy", outPath]);
}

function voiceSpeakMessage(bag: VoiceBag, aukShots: PluggedShotWav[]): string {
  const cloneLabel = bag.cloneRef ? "job ref" : "tts.promptWav";
  const eventCount = bag.locked.audioEvents?.length ?? 0;
  if (eventCount > 0) {
    return `聲音事件 ${eventCount} 句（各一條連續 take，切片播過 ${aukShots.length} 鏡；clone 跟 ${cloneLabel}）——切鏡唔重播、講者唔改成聽者。`;
  }
  if (aukShots.length > 0) {
    return `聲軌 wav plug＋AuK 出 ${aukShots.length} 鏡 VO（對白跟 continuity，clone 跟 ${cloneLabel}）：${aukShots.map((s) => s.shotId).join("、")}`;
  }
  return "聲軌係 wav plug：spine.wav 或者逐鏡切片加 gap。";
}

function hasPlugSentences(wavDir: string | undefined): boolean {
  return Boolean(wavDir && fs.existsSync(path.join(wavDir, "sentences.json")));
}

function ttsTraceLabel(
  bag: VoiceBag,
  spokenRows: PluggedShotWav[],
  wavDir: string | undefined,
): string {
  const eventCount = bag.locked.audioEvents?.length ?? 0;
  if (eventCount > 0) {
    const played = spokenRows.length ? `，播過 ${spokenRows.length} 鏡` : "";
    return `audio events ×${eventCount}（一句一 take 切片）${played}`;
  }
  if (spokenRows.some((p) => p.source === "auk")) {
    const plug = hasPlugSentences(wavDir) ? " + plug slices" : "";
    return `AuK auto VO ×${spokenRows.length}${plug}`;
  }
  if (hasPlugSentences(wavDir)) return "wav plug (AuK slices, natural pace)";
  return "wav plug";
}

async function ensureSpineWav(bag: VoiceBag): Promise<string> {
  if (bag.spineWav) return bag.spineWav;

  const spineFile = path.join(bag.audioDir, "spine.wav");
  const orderedWavs = bag.cutPlan.shots.map((s) => s.wav);
  const listPath = path.join(bag.audioDir, "spine-list.txt");

  if (bag.gapSec > 0 && orderedWavs.length > 1) {
    const fmt = await deps.runCommand("ffprobe", [
      "-v", "error", "-select_streams", "a:0",
      "-show_entries", "stream=sample_rate,channels", "-of", "json", orderedWavs[0]!,
    ]);
    if (fmt.code !== 0) throw new Error(fmt.stderr || "ffprobe wav fmt failed");
    const st = (JSON.parse(fmt.stdout).streams ?? [])[0] as {
      sample_rate?: string;
      channels?: string;
    };
    const gapWav = path.join(bag.audioDir, "gap.wav");
    await deps.ffmpeg([
      "-f", "lavfi", "-i", `anullsrc=r=${st.sample_rate ?? 24000}:cl=${st.channels ?? 1}`,
      "-t", String(bag.gapSec), "-c:a", "pcm_s16le", gapWav,
    ]);
    const withGaps = [orderedWavs[0]!];
    for (const w of orderedWavs.slice(1)) withGaps.push(gapWav, w);
    writeConcatList(listPath, withGaps);
  } else {
    writeConcatList(listPath, orderedWavs);
  }

  await concatCopy(listPath, spineFile);
  return spineFile;
}

/** 核心邏輯（可測）；SeatModule.run 同 dual-run 共用。 */
export async function runVoice(ctx: SeatContext, bag: VoiceBag): Promise<SeatResult> {
  const { jobId, input } = ctx;

  try {
    ctx.think("voice");
    const aukShots = spokenPlugged(bag.plugged);
    ctx.speak("voice", voiceSpeakMessage(bag, aukShots));

    const spineFile = await ensureSpineWav(bag);

    const baseTrace: ProviderTrace = ctx.job.providers ?? {
      stills: "",
      motion: "",
      tts: "wav plug",
      senseVoice: "",
      mars: "",
      blender: "",
      lipSync: "",
    };
    const trace: ProviderTrace = {
      ...baseTrace,
      tts: ttsTraceLabel(bag, aukShots, input.wavDir),
    };

    ctx.job = deps.patch(ctx.job, {
      providers: trace,
      progress: 76,
      outputs: { ...ctx.job.outputs, voice: "audio/spine.wav" },
    });
    deps.upsertDoc({
      id: "audio:vo",
      slate: jobId,
      modality: "audio",
      text: bag.timed.voiceover,
      absPath: spineFile,
    });

    // sound QC 前置：concat padded per-shot wavs → delivery/lock-audio.wav
    const lockAudio = jobFile(jobId, "delivery", "lock-audio.wav");
    const lockList = path.join(bag.audioDir, "lock-list.txt");
    writeConcatList(
      lockList,
      bag.cutPlan.shots.map((s) => bag.h3WavByShot.get(s.id)!),
    );
    await deps.ffmpeg(["-f", "concat", "-safe", "0", "-i", lockList, "-c:a", "pcm_s16le", lockAudio]);

    return emptyResult({ status: "PASSED" });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.speak("voice", `配音失敗：${message}`, "fail");
    return emptyResult({
      status: "FAILED_TERMINAL",
      stopped: true,
      violations: [{
        step: "voice",
        constraint: "voice",
        severity: "hard",
        saw: message,
        expected: "no throw",
      }],
    });
  }
}

export const voiceSeat: SeatModule = {
  seatId: "voice" as AgentId,

  async run(ctx: SeatContext): Promise<SeatResult> {
    const bag = bags.get(ctx.jobId) ?? loadVoiceBagFromDisk(ctx);
    return runVoice(ctx, bag);
  },
};
