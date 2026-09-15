import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./audio";
import { probe } from "./dhash-anchors";

async function ffmpeg(args: string[]) {
  const result = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (result.code !== 0) throw new Error(result.stderr || "ffmpeg failed");
}

/** first, mid, last, plus one every 2s — 0-based frame indices. */
export function pickMotionFrameIndices(nbFrames: number, fps: number): number[] {
  if (nbFrames <= 0) return [];
  const picked = new Set<number>();
  picked.add(0);
  picked.add(Math.floor((nbFrames - 1) / 2));
  picked.add(nbFrames - 1);
  const step = Math.max(1, Math.round(fps * 2));
  for (let f = 0; f < nbFrames; f += step) picked.add(f);
  return [...picked].sort((a, b) => a - b);
}

export type ExtractedMotionFrame = { frame: number; t_s: number; file: string };

/** Pull QC frames from an mp4 into `outDir` as SHxx_fNNNN.jpg. */
export async function extractMotionFrames(mp4: string, outDir: string, shotId: string): Promise<ExtractedMotionFrame[]> {
  if (!fs.existsSync(mp4)) throw new Error(`extractMotionFrames: missing ${mp4}`);
  const facts = await probe(mp4);
  const indices = pickMotionFrameIndices(facts.nbFrames, facts.fps);
  fs.mkdirSync(outDir, { recursive: true });
  const out: ExtractedMotionFrame[] = [];
  for (const frame of indices) {
    const file = path.join(outDir, `${shotId}_f${String(frame).padStart(4, "0")}.jpg`);
    await ffmpeg(["-i", mp4, "-vf", `select='eq(n\\,${frame})'`, "-frames:v", "1", "-q:v", "2", file]);
    out.push({ frame, t_s: Math.round((frame / facts.fps) * 1e4) / 1e4, file });
  }
  return out;
}
