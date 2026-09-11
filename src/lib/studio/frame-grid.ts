import fs from "node:fs";
import { runCommand } from "./audio";

export const FPS = 24;
const GRID_K = 17;
const GRID_B = 5; // frames = 17k+5 (H3 official grid)
const K_MIN = 7;
const K_MAX = 21; // 124≈5.2s … 362≈15.1s (trained max)

export function snapDurationToFrames(duration: number): number {
  // ceil, not round — the wav must be fully covered: 8.12s wav round→192f=8.0s
  // truncates the audio, ceil→209f covers it (shotdag frame_grid receipt).
  const k = Math.ceil((duration * FPS - GRID_B) / GRID_K);
  return GRID_K * Math.max(K_MIN, Math.min(K_MAX, k)) + GRID_B;
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
