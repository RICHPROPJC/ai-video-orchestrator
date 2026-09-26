import fs from "node:fs";
import path from "node:path";
import { writeWav } from "./audio";
import { ensureAudibleShotWav, runAukTts, type RunAukTtsOpts } from "./auk-tts";
import type { Shot } from "./types";

export type PluggedShotWav = {
  shotId: string;
  file: string;
  /** "copied" = given plug wav; "auk" = dialogue take; "silent" = picture beat, no line */
  source: "copied" | "auk" | "silent";
  /** dialogue text the AuK take reads ("" for plug and silent shots) */
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

/** Voice hop, per shot: a plug wav is copied, dialogue goes to AuK, a picture
 *  beat with no line gets a silent take. The bed mix fills the locked clock;
 *  AuK is not padded with silence. A named --wav-dir that lacks the file still fails. */
export async function plugShotWavs(opts: PlugShotWavsOpts): Promise<PluggedShotWav[]> {
  const out: PluggedShotWav[] = [];
  for (const shot of opts.boards) {
    const src = opts.wavDir ? path.join(opts.wavDir, `${shot.id}.wav`) : undefined;
    if (src && !fs.existsSync(src)) {
      throw new Error(`--wav-dir 缺 ${shot.id}.wav（${src}）`);
    }
    const text = shot.dialogue.trim();
    const dst = path.join(opts.audioDir, `${shot.id}.wav`);
    let source: PluggedShotWav["source"];
    if (!src && !text) {
      fs.mkdirSync(opts.audioDir, { recursive: true });
      const seconds = Math.max(1 / 24, shot.durationSec);
      writeWav(dst, new Float32Array(Math.round(seconds * 22050)), 22050);
      source = "silent";
    } else {
      const base = opts.synthesize ?? runAukTts;
      const synth = ((o: RunAukTtsOpts) => base(opts.cloneRef ? { ...o, promptWav: opts.cloneRef } : o)) as typeof runAukTts;
      source = await ensureAudibleShotWav({ src, dst, text, synthesize: synth });
    }
    const row: PluggedShotWav = { shotId: shot.id, file: dst, source, text };
    out.push(row);
    await opts.onShot?.(row);
  }
  return out;
}
