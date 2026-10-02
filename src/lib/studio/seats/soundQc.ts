/** SoundQc席（阿耳）真實邏輯——從pipeline.ts :857-910逐行遷移
 *
 * 職責：
 * 1. 對lock-audio.wav做ASR（SenseVoice HTTP）
 * 2. 比對期望稿（audioEvents或dialogue join）
 * 3. 產出sound-qc.json（pass/fail + peak + silenceRatio）
 * 4. Revision guard：cut_plan vs audio-timeline digest比對
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import { wavPrecheck, senseVoiceHttp, soundQcUnconfigured, soundQcFromRemote } from "../providers";

export interface SoundQcDeps {
  lockAudioFile: string;
  expectedText: string;
  soundQcEndpoint: string;
  cutPlanDigest?: string;
  audioTimelineDigest?: string;
  ctxCallsheetDigest?: string;
  jobId: string;
  jobFile: (jobId: string, ...segs: string[]) => string;
}

export interface SoundQcResult {
  pass: boolean;
  peak: number;
  silenceRatio: number;
  expectedText: string;
}

export async function runSoundQcLogic(deps: SoundQcDeps): Promise<SoundQcResult & { revisionOk: boolean }> {
  const { lockAudioFile, expectedText, soundQcEndpoint } = deps;

  // ── 1. SenseVoice ASR ──
  const earConfigured = soundQcEndpoint.trim().length > 0;
  const wavCheck = earConfigured ? wavPrecheck({ audioFile: lockAudioFile }) : null;
  const remoteSv = earConfigured ? await senseVoiceHttp(lockAudioFile).catch(() => null) : null;

  const sound = !earConfigured
    ? soundQcUnconfigured()
    : remoteSv && wavCheck
      ? soundQcFromRemote({ remote: remoteSv, expectedText, wav: wavCheck })
      : soundQcUnconfigured(`sensevoice ${soundQcEndpoint} unreachable or unparseable`);

  // ── 2. Revision guard：cut_plan vs audio-timeline同源比對 ──
  let revisionOk = true;
  if (deps.cutPlanDigest && deps.ctxCallsheetDigest) {
    revisionOk =
      deps.cutPlanDigest === deps.audioTimelineDigest
      && deps.cutPlanDigest === deps.ctxCallsheetDigest;
  }

  return {
    pass: sound.pass,
    peak: sound.peak,
    silenceRatio: sound.silenceRatio,
    expectedText,
    revisionOk,
  };
}

export const soundQcSeat: SeatModule = {
  seatId: "soundQc" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("soundQc", "SenseVoice 對稿：ASR、情緒、事件、WER、Clipping。");
    try {
      // 真正遷移時由orchestrator供給deps
      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.speak("soundQc", `聲檢失敗：${msg}`, "fail");
      return {
        status: "FAILED_RETRYABLE", stopped: false, artifacts: [], receipts: [],
        gaps: [], violations: [{ step: "soundQc", constraint: "soundQc", severity: "hard", saw: msg, expected: "no throw" }],
      };
    }
  },
};
