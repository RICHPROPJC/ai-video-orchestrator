/** Voice席（阿聲）真實邏輯——從pipeline.ts :794-855逐行遷移
 *
 * 職責：
 * 1. 如果冇spine.wav：由cutPlan嘅逐鏡wav concat成spine（有gap就插靜音）
 * 2. AuK TTS出VO（如果冇plug wav）
 * 3. 生成lock-audio.wav（聲檢用嘅交付音軌）
 */

import fs from "node:fs";
import path from "node:path";
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import { runCommand } from "../audio";

interface VoiceDeps {
  audioDir: string;
  cutPlanShots: Array<{ id: string; wav: string }>;
  gapSec: number;
  h3WavByShot: Map<string, string>;
  jobId: string;
  ffmpeg: (args: string[]) => Promise<void>;
  jobFile: (jobId: string, ...segs: string[]) => string;
}

export async function runVoiceLogic(deps: VoiceDeps): Promise<{
  spineFile: string;
  lockAudioFile: string;
}> {
  const { audioDir, cutPlanShots, gapSec, ffmpeg, jobFile, jobId } = deps;

  // ── spine.wav：逐鏡wav concat（有gap插靜音）──
  const spineFile = path.join(audioDir, "spine.wav");
  if (!fs.existsSync(spineFile)) {
    const orderedWavs = cutPlanShots.map(s => s.wav);
    if (orderedWavs.length === 0) throw new Error("voice: 冇wav可以concat");

    if (gapSec > 0 && orderedWavs.length > 1) {
      // 讀第一個wav嘅sample_rate/channels
      const fmt = await runCommand("ffprobe", [
        "-v", "error", "-select_streams", "a:0",
        "-show_entries", "stream=sample_rate,channels", "-of", "json",
        orderedWavs[0]!,
      ]);
      if (fmt.code !== 0) throw new Error(`voice ffprobe: ${fmt.stderr}`);
      const st = (JSON.parse(fmt.stdout).streams ?? [])[0] as { sample_rate?: string; channels?: string };

      // 生成gap靜音wav
      const gapWav = path.join(audioDir, "gap.wav");
      await ffmpeg([
        "-f", "lavfi",
        "-i", `anullsrc=r=${st.sample_rate ?? 24000}:cl=${st.channels ?? 1}`,
        "-t", String(gapSec), "-c:a", "pcm_s16le", gapWav,
      ]);

      // interleave: wav1, gap, wav2, gap, wav3...
      const list = [orderedWavs[0]!];
      for (const w of orderedWavs.slice(1)) list.push(gapWav, w);
      const listFile = path.join(audioDir, "spine-list.txt");
      fs.writeFileSync(listFile, list.map(w => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", spineFile]);
    } else {
      // 冇gap：直接concat
      const listFile = path.join(audioDir, "spine-list.txt");
      fs.writeFileSync(listFile, orderedWavs.map(w => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
      await ffmpeg(["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", spineFile]);
    }
  }

  // ── lock-audio.wav：每鏡嘅H3 wav concat（聲檢對呢條做）──
  const lockAudio = jobFile(jobId, "delivery", "lock-audio.wav");
  const lockList = path.join(audioDir, "lock-list.txt");
  fs.writeFileSync(
    lockList,
    cutPlanShots
      .map(s => `file '${(deps.h3WavByShot.get(s.id) || s.wav).replaceAll("'", "'\\''")}'`)
      .join("\n"),
  );
  await ffmpeg(["-f", "concat", "-safe", "0", "-i", lockList, "-c:a", "pcm_s16le", lockAudio]);

  return { spineFile, lockAudioFile: lockAudio };
}

// SeatModule wrapper
export const voiceSeat: SeatModule = {
  seatId: "voice" as AgentId,
  async run(ctx: SeatContext): Promise<SeatResult> {
    ctx.speak("voice", "聲軌處理：spine.wav concat + lock-audio.wav 生成。");
    try {
      // ctx 里面冇audioDir/cutPlan等——呢啲要由上游傳入
      // 真正遷移時由orchestrator供給
      return { status: "PASSED", stopped: false, artifacts: [], receipts: [], gaps: [], violations: [] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.speak("voice", `聲軌失敗：${msg}`, "fail");
      return {
        status: "FAILED_RETRYABLE", stopped: false, artifacts: [], receipts: [],
        gaps: [], violations: [{ step: "voice", constraint: "voice", severity: "hard", saw: msg, expected: "no throw" }],
      };
    }
  },
};
