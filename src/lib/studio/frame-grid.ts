import fs from "node:fs";
import { runCommand } from "./audio";
import { loadConfig } from "./config";

export const FPS = 24;
const GRID_K = 17;
const GRID_B = 5; // frames = 17k+5 (H3 official grid)
const K_MIN_DEFAULT = 3; // 56f ≈ 2.33s. k=7 (124f) is not the formula's floor.
const K_MAX_DEFAULT = 21; // 362f ≈ 15.1s

export function gridK(): { kMin: number; kMax: number } {
  try {
    const g = loadConfig().h3Grid;
    const kMin = Number.isFinite(g?.kMin) ? Math.floor(g.kMin) : K_MIN_DEFAULT;
    const kMax = Number.isFinite(g?.kMax) ? Math.floor(g.kMax) : K_MAX_DEFAULT;
    return { kMin: Math.max(1, kMin), kMax: Math.max(Math.max(1, kMin), kMax) };
  } catch {
    return { kMin: K_MIN_DEFAULT, kMax: K_MAX_DEFAULT };
  }
}

export function framesForK(k: number): number {
  return GRID_K * k + GRID_B;
}

export function shotSecMin(): number {
  return framesForK(gridK().kMin) / FPS;
}

export function shotSecMax(): number {
  return framesForK(gridK().kMax) / FPS;
}

/** Ceil onto 17k+5. Below kMin or above kMax throws — do not rewrite the shot to 124 frames. */
export function snapDurationToFrames(duration: number): number {
  const { kMin, kMax } = gridK();
  const k = Math.ceil((duration * FPS - GRID_B) / GRID_K);
  if (k < kMin || k > kMax) {
    throw new Error(
      `h3_grid: ${duration}s needs k=${k}, allowed ${kMin}–${kMax} (${shotSecMin().toFixed(2)}–${shotSecMax().toFixed(2)}s)`,
    );
  }
  return framesForK(k);
}

async function ffprobeDuration(file: string): Promise<number> {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  if (r.code !== 0) throw new Error(r.stderr || `ffprobe failed on ${file}`);
  const sec = Number(r.stdout.trim());
  if (!Number.isFinite(sec) || sec <= 0) throw new Error(`ffprobe: no duration for ${file}`);
  return sec;
}

/** wav duration in seconds: walk RIFF chunks (fmt byte_rate + data size),
 * fall back to ffprobe for containers the RIFF walk cannot read. */
export async function wavSeconds(file: string): Promise<number> {
  const buf = fs.readFileSync(file);
  if (buf.length >= 12 && buf.toString("latin1", 0, 4) === "RIFF" && buf.toString("latin1", 8, 12) === "WAVE") {
    let pos = 12;
    let byteRate = 0;
    let dataBytes = -1;
    while (pos + 8 <= buf.length) {
      const id = buf.toString("latin1", pos, pos + 4);
      const size = buf.readUInt32LE(pos + 4);
      if (id === "fmt ") byteRate = buf.readUInt32LE(pos + 16);
      if (id === "data") {
        dataBytes = size;
        break;
      }
      pos += 8 + size + (size % 2); // chunks are word-aligned
    }
    if (byteRate > 0 && dataBytes >= 0) return dataBytes / byteRate;
  }
  return ffprobeDuration(file);
}
