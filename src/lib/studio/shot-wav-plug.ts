import fs from "node:fs";
import path from "node:path";
import { ensureAudibleShotWav, runAukTts, type RunAukTtsOpts } from "./auk-tts";
import type { Shot } from "./types";

export type PluggedShotWav = {
  shotId: string;
  file: string;
  /** "copied" = given plug wav; "auk" = synthesized from the continuity dialogue */
  source: "copied" | "auk";
  /** dialogue text the AuK take reads ("" for plug shots) */
  text: string;
};

export type PlugShotWavsOpts = {
  boards: Shot[];
  /** --wav-dir plug; undefined = voice seat speaks every dialogue shot */
  wavDir?: string;
  audioDir: string;
  /** job-level clone ref (--clone upload); undefined falls back to tts.promptWav inside runAukTts */
  cloneRef?: string;
  synthesize?: (opts: RunAukTtsOpts) => Promise<unknown>;
  onShot?: (r: PluggedShotWav) => void | Promise<void>;
};

/** Voice hop, per shot: the given SHxx.wav is the clock, else AuK speaks the
 *  continuity dialogue (one verbatim take; clone voice = the ref's speaker).
 *  Fail loud when a shot has neither a plug wav nor dialogue. */
export async function plugShotWavs(opts: PlugShotWavsOpts): Promise<PluggedShotWav[]> {
  const out: PluggedShotWav[] = [];
  for (const shot of opts.boards) {
    const src = opts.wavDir ? path.join(opts.wavDir, `${shot.id}.wav`) : undefined;
    if (src && !fs.existsSync(src)) {
      throw new Error(`--wav-dir 缺 ${shot.id}.wav（${src}）`);
    }
    const text = shot.dialogue.trim();
    const dst = path.join(opts.audioDir, `${shot.id}.wav`);
    const base = opts.synthesize ?? runAukTts;
    // clone ref: job upload wins, else runAukTts falls back to tts.promptWav itself
    const synth = ((o: RunAukTtsOpts) => base(opts.cloneRef ? { ...o, promptWav: opts.cloneRef } : o)) as typeof runAukTts;
    const source = await ensureAudibleShotWav({ src, dst, text, synthesize: synth });
    const row: PluggedShotWav = { shotId: shot.id, file: dst, source, text };
    out.push(row);
    await opts.onShot?.(row);
  }
  return out;
}
