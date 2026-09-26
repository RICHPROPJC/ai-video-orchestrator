import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./audio";
import { wavSeconds } from "./frame-grid";

const SR = 24000;
const FADE_IN = 0.16;
const FADE_OUT = 0.28;
/** abs sample under this counts as a hole in sound QC */
const AUDIBLE = 0.02;

export type BedSegment = {
  id: string;
  /** AuK take, or a silent plug for a picture beat. Silent takes are not mixed. */
  take: string;
  out: string;
  seconds: number;
};

async function ffmpeg(args: string[]): Promise<void> {
  const result = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (result.code !== 0) throw new Error(result.stderr || "ffmpeg failed");
}

function samplesFor(seconds: number): number {
  return Math.max(1, Math.round(seconds * SR));
}

/** Peak of a wav, including AuK files whose data chunk is not at byte 44. */
async function peakLinear(file: string): Promise<number> {
  const result = await runCommand("ffmpeg", ["-i", file, "-af", "volumedetect", "-f", "null", "-"]);
  const m = result.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  if (!m) return 0;
  const db = Number(m[1]);
  if (!Number.isFinite(db) || db <= -80) return 0;
  return 10 ** (db / 20);
}

/** One continuous bed under the takes. Each AuK line stays its own length and
 *  sits on top; the bed fills the slot. Fade only the head and the tail of the
 *  whole timeline, then slice on sample boundaries so the cuts do not pop. */
export async function layDialogueBed(opts: {
  segments: BedSegment[];
  workDir: string;
}): Promise<void> {
  if (!opts.segments.length) return;
  fs.mkdirSync(opts.workDir, { recursive: true });
  const segs = opts.segments.map((s) => ({ ...s, n: samplesFor(s.seconds) }));
  const total = segs.reduce((a, s) => a + s.n, 0);
  const totalSec = total / SR;
  const fadeIn = Math.min(FADE_IN, totalSec / 6);
  const fadeOut = Math.min(FADE_OUT, totalSec / 5);
  const fadeOutAt = Math.max(0, totalSec - fadeOut);
  const bed = path.join(opts.workDir, "bed.wav");
  const expr =
    "0.055*(0.78+0.22*sin(2*PI*0.45*t))*(sin(2*PI*262*t)+0.62*sin(2*PI*330*t)+0.48*sin(2*PI*392*t)+0.22*sin(2*PI*523*t))";
  await ffmpeg([
    "-f", "lavfi", "-i", `aevalsrc='${expr}':s=${SR}:d=${totalSec.toFixed(6)}`,
    "-f", "lavfi", "-i", `anoisesrc=color=pink:r=${SR}:a=0.018:d=${totalSec.toFixed(6)}`,
    "-filter_complex",
    `[0][1]amix=inputs=2:duration=first:normalize=0,afade=t=in:st=0:d=${fadeIn.toFixed(3)},afade=t=out:st=${fadeOutAt.toFixed(3)}:d=${fadeOut.toFixed(3)},alimiter=limit=0.16:level=false:attack=0.1,atrim=end_sample=${total},apad=whole_len=${total}[bed]`,
    "-map", "[bed]",
    "-c:a", "pcm_s16le",
    bed,
  ]);

  const audible: { take: string; offset: number; slot: number }[] = [];
  let offset = 0;
  for (const seg of segs) {
    if (fs.existsSync(seg.take) && (await peakLinear(seg.take)) >= AUDIBLE) {
      audible.push({ take: seg.take, offset, slot: seg.n });
    }
    offset += seg.n;
  }

  const mix = path.join(opts.workDir, "mix.wav");
  if (!audible.length) {
    fs.copyFileSync(bed, mix);
  } else {
    const args: string[] = ["-i", bed];
    const filters: string[] = [];
    const labels = ["[0:a]"];
    audible.forEach((a, i) => {
      args.push("-i", a.take);
      filters.push(
        `[${i + 1}:a]aformat=sample_fmts=fltp:sample_rates=${SR}:channel_layouts=mono,atrim=end_sample=${a.slot},asetpts=PTS-STARTPTS,adelay=${a.offset}S|${a.offset}S,apad=whole_len=${total},atrim=end_sample=${total}[v${i}]`,
      );
      labels.push(`[v${i}]`);
    });
    filters.push(
      `${labels.join("")}amix=inputs=${labels.length}:duration=first:dropout_transition=0:normalize=0,alimiter=limit=0.9:level=false:attack=0.1,atrim=end_sample=${total},apad=whole_len=${total}[mix]`,
    );
    await ffmpeg([...args, "-filter_complex", filters.join(";"), "-map", "[mix]", "-c:a", "pcm_s16le", mix]);
  }

  let cursor = 0;
  for (const seg of segs) {
    const end = cursor + seg.n;
    await ffmpeg([
      "-i", mix,
      "-af", `atrim=start_sample=${cursor}:end_sample=${end},asetpts=PTS-STARTPTS`,
      "-c:a", "pcm_s16le",
      seg.out,
    ]);
    const got = await wavSeconds(seg.out);
    const want = seg.n / SR;
    if (Math.abs(got - want) > 1 / 48) {
      throw new Error(`${seg.id}: bed slice ${got.toFixed(4)}s != ${want.toFixed(4)}s`);
    }
    cursor = end;
  }
}
