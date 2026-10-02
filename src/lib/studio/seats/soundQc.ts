/** PR-2：SoundQc 席（阿耳／聲檢）——從 pipeline.ts :857-886 抽出
 * SenseVoice ASR + peak/silence；對稿 delivery/lock-audio.wav（voice 席已 concat）。 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import { loadConfig as defaultLoadConfig, type SlateConfig } from "../config";
import type { AgentId, CallSheet, JobRecord, ProviderTrace, SoundQc } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import type { ArtifactRef } from "../shared/artifact-ref";
import type { ReceiptRef } from "../shared/receipt";
import { loadCallSheet } from "../writer";
import { jobFile } from "../paths";
import { patch as defaultPatch } from "../pipeline/shared";
import {
  senseVoiceHttp as defaultSenseVoiceHttp,
  soundQcFromRemote as defaultSoundQcFromRemote,
  soundQcUnconfigured as defaultSoundQcUnconfigured,
  wavPrecheck as defaultWavPrecheck,
} from "../providers";

/** 上游 voice／timed 產物——legacy pipeline Ctx 字段；SeatContext 未擴充前用 binder／碟讀。 */
export type SoundQcBag = {
  timed: CallSheet;
  /** 已 concat 嘅交付聲軌；缺＝碟上 delivery/lock-audio.wav */
  lockAudio?: string;
};

export type SoundQcDeps = {
  loadConfig: () => Pick<SlateConfig, "soundQc">;
  senseVoiceHttp: (audioFile: string) => Promise<Partial<SoundQc> | null>;
  wavPrecheck: typeof defaultWavPrecheck;
  soundQcFromRemote: typeof defaultSoundQcFromRemote;
  soundQcUnconfigured: typeof defaultSoundQcUnconfigured;
  patch: (job: JobRecord, partial: Partial<JobRecord>) => JobRecord;
};

const bags = new Map<string, SoundQcBag>();
let deps: SoundQcDeps = {
  loadConfig: defaultLoadConfig,
  senseVoiceHttp: defaultSenseVoiceHttp,
  wavPrecheck: defaultWavPrecheck,
  soundQcFromRemote: defaultSoundQcFromRemote,
  soundQcUnconfigured: defaultSoundQcUnconfigured,
  patch: defaultPatch,
};

/** Dual-run：legacy pipeline 喺 run 前綁上游 Ctx 字段。 */
export function bindSoundQcBag(jobId: string, bag: SoundQcBag): void {
  bags.set(jobId, bag);
}

export function unbindSoundQcBag(jobId: string): void {
  bags.delete(jobId);
}

/** 測試用：替換 SenseVoice／patch 等副作用。 */
export function _setSoundQcDepsForTest(partial: Partial<SoundQcDeps>): void {
  deps = { ...deps, ...partial };
}

export function _resetSoundQcDepsForTest(): void {
  deps = {
    loadConfig: defaultLoadConfig,
    senseVoiceHttp: defaultSenseVoiceHttp,
    wavPrecheck: defaultWavPrecheck,
    soundQcFromRemote: defaultSoundQcFromRemote,
    soundQcUnconfigured: defaultSoundQcUnconfigured,
    patch: defaultPatch,
  };
}

function loadSoundQcBagFromDisk(ctx: SeatContext): SoundQcBag {
  return {
    timed: loadCallSheet(jobFile(ctx.jobId, "callsheet.json")),
    lockAudio: jobFile(ctx.jobId, "delivery", "lock-audio.wav"),
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

function baseTrace(job: JobRecord): ProviderTrace {
  return job.providers ?? {
    stills: "",
    motion: "",
    tts: "",
    senseVoice: "",
    mars: "",
    blender: "",
    lipSync: "",
  };
}

/** 核心邏輯（可測）；SeatModule.run 同 dual-run 共用。 */
export async function runSoundQc(ctx: SeatContext, bag: SoundQcBag): Promise<SeatResult> {
  const { jobId } = ctx;

  try {
    ctx.think("soundQc");
    ctx.speak("soundQc", "SenseVoice 對稿（delivery/lock-audio.wav）：ASR、情緒、事件、WER、Clipping。");

    const cfg = deps.loadConfig();
    const lockAudio = bag.lockAudio ?? jobFile(jobId, "delivery", "lock-audio.wav");
    // A3 fail-loud: no endpoint, or an unreachable ear = FAIL "unconfigured".
    // Never a schema stand-in for the SenseVoice verdict.
    const earConfigured = cfg.soundQc.endpoint.trim().length > 0;
    const wavCheck = earConfigured ? deps.wavPrecheck({ audioFile: lockAudio }) : null;
    const remoteSv = earConfigured ? await deps.senseVoiceHttp(lockAudio).catch(() => null) : null;
    // PROVENANCE_0927：期望稿對「聲音事件序」——一句跨鏡只計一次（衍生欄
    // 喺兩鏡都見到成句，直接 join 會重複）；舊 callsheet 冇事件先 join 鏡序。
    const expectedSpeech = bag.timed.audioEvents?.length
      ? bag.timed.audioEvents.map((e) => e.text).join(" ")
      : bag.timed.shots.map((s) => s.dialogue.trim()).filter(Boolean).join(" ");
    const sound = !earConfigured
      ? deps.soundQcUnconfigured()
      : remoteSv && wavCheck
        ? deps.soundQcFromRemote({
            remote: remoteSv,
            expectedText: expectedSpeech,
            // 裁決 0928 §4：方案冇 emotion 指定→唔傳（標未指定）；
            // cloneSimilarity 冇量度→null＋note（soundQcFromRemote 內處理）
            wav: wavCheck,
          })
        : deps.soundQcUnconfigured(`sensevoice ${cfg.soundQc.endpoint} unreachable or unparseable`);

    const trace: ProviderTrace = { ...baseTrace(ctx.job) };
    trace.senseVoice = earConfigured && remoteSv ? "SenseVoice HTTP" : "SenseVoice FAIL (unconfigured)";

    const qcRel = "delivery/sound-qc.json";
    const qcPath = jobFile(jobId, "delivery", "sound-qc.json");
    fs.writeFileSync(qcPath, JSON.stringify({
      scope: "delivered-dialogue", expectedText: expectedSpeech,
      audio: "delivery/lock-audio.wav", result: sound,
    }, null, 2));

    ctx.job = deps.patch(ctx.job, { soundQc: sound, providers: trace, progress: 82 });
    ctx.speak(
      "soundQc",
      `Sound QC ${sound.pass ? "PASS" : "FAIL"}  peak ${sound.peak.toFixed(2)}  silence ${sound.silenceRatio.toFixed(2)}`,
      sound.pass ? "pass" : "fail",
    );

    const sha256 = createHash("sha256").update(fs.readFileSync(qcPath)).digest("hex");
    const now = new Date().toISOString();
    const artifact: ArtifactRef = {
      artifactId: `soundQc:${jobId}:qc`,
      kind: "qc_report",
      uri: qcRel,
      mediaType: "application/json",
      sizeBytes: fs.statSync(qcPath).size,
      sha256,
      schemaVersion: 1,
      createdAt: now,
      availability: "committed",
      producer: {
        seat: "soundQc",
        capability: "sensevoice-asr",
        provider: sound.provider,
      },
      lineage: {
        jobId,
        attemptId: "seat-extract",
        buildBase: "",
        inputArtifactIds: ["delivery/lock-audio.wav"],
      },
    };
    const receipt: ReceiptRef = {
      receiptId: `soundQc:${jobId}:gate`,
      kind: "gate_evaluation",
      schemaVersion: 1,
      artifactId: artifact.artifactId,
      producerAttemptId: "seat-extract",
      sha256,
      createdAt: now,
      payload: {
        pass: sound.pass,
        peak: sound.peak,
        silenceRatio: sound.silenceRatio,
        wer: sound.wer,
        issues: sound.issues,
      },
    };

    // QC FAIL 唔截 pipeline（legacy 照行 editor）——記 violations／PARTIAL。
    return emptyResult({
      status: sound.pass ? "PASSED" : "PARTIAL",
      artifacts: [artifact],
      receipts: [receipt],
      violations: sound.pass
        ? []
        : sound.issues.map((i) => ({
            step: "soundQc",
            constraint: i.code,
            severity: i.severity === "block" ? "hard" as const : "soft" as const,
            saw: i.detail,
            expected: "pass",
          })),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    ctx.speak("soundQc", `聲檢失敗：${message}`, "fail");
    return emptyResult({
      status: "FAILED_TERMINAL",
      stopped: true,
      violations: [{
        step: "soundQc",
        constraint: "soundQc",
        severity: "hard",
        saw: message,
        expected: "no throw",
      }],
    });
  }
}

export const soundQcSeat: SeatModule = {
  seatId: "soundQc" as AgentId,

  async run(ctx: SeatContext): Promise<SeatResult> {
    const bag = bags.get(ctx.jobId) ?? loadSoundQcBagFromDisk(ctx);
    return runSoundQc(ctx, bag);
  },
};
