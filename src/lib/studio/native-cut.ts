/** Outer ffmpeg must not invent the cut. Duration / holds / camera live in
 *  H3 (wav clock → frames). Picture-lock is `-c copy` of clips that already
 *  join, never xfade / setpts / morph. */

const BANNED = /\b(xfade|setpts|minterpolate|tmix|morph)\b/i;

export function assertNativeFfmpeg(args: string[]): void {
  const line = args.join(" ");
  const hit = line.match(BANNED);
  if (hit) {
    throw new Error(
      `outer H3 cut banned (${hit[0]}): duration/holds/lens belong inside H3, not ffmpeg. args=${line.slice(0, 180)}`,
    );
  }
}

/** gapSec inserts silence between already-timed H3 clips — that is an outer cut. */
export function assertNoOuterGap(gapSec: number): void {
  if (gapSec > 0) {
    throw new Error(`gapSec=${gapSec} is an outer cut — set duration/holds inside H3 (wav clock), then concat -c copy`);
  }
}

export function concatCopyArgs(listFile: string, outFile: string): string[] {
  const args = ["-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", outFile];
  assertNativeFfmpeg(args);
  return args;
}
