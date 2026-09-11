import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { runCommand } from "./audio";

const DH_W = 9;
const DH_H = 8; // dHash grid: 9 wide → 8 horizontal comparisons per row
const BYTES_PER_FRAME = DH_W * DH_H;

function runBinary(cmd: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let err = "";
    child.stderr.on("data", (d) => {
      err += String(d);
    });
    child.stdout.on("data", (d: Buffer) => chunks.push(d));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(Buffer.concat(chunks));
      else reject(new Error(err || `${cmd} exited ${code}`));
    });
  });
}

export type VideoFacts = { nbFrames: number; fps: number };

/** (nb_frames, fps) from ffprobe — the stream is the truth, not the CLI flag. */
export async function probe(file: string): Promise<VideoFacts> {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0",
    "-show_entries", "stream=nb_frames,r_frame_rate",
    "-of", "json", file,
  ]);
  if (r.code !== 0) throw new Error(r.stderr || `ffprobe failed on ${file}`);
  const st = (JSON.parse(r.stdout).streams ?? [])[0] as
    | { nb_frames?: string; r_frame_rate?: string }
    | undefined;
  if (!st?.nb_frames || !st.r_frame_rate) throw new Error(`ffprobe: no stream facts for ${file}`);
  const [num, den] = st.r_frame_rate.split("/").map(Number);
  return { nbFrames: Number(st.nb_frames), fps: num / den };
}

/** one 64-bit dHash per frame: ffmpeg scales to 9×8 gray, this builds the bits */
export async function frameHashes(file: string): Promise<bigint[]> {
  const raw = await runBinary("ffmpeg", [
    "-v", "error", "-i", file,
    "-vf", `scale=${DH_W}:${DH_H},format=gray`, "-f", "rawvideo", "-",
  ]);
  if (raw.length % BYTES_PER_FRAME) {
    throw new Error(`${file}: raw extract is ${raw.length} bytes — not a whole number of ${BYTES_PER_FRAME}-byte frames`);
  }
  const hashes: bigint[] = [];
  for (let off = 0; off < raw.length; off += BYTES_PER_FRAME) {
    let bits = 0n;
    for (let y = 0; y < DH_H; y += 1) {
      for (let x = 0; x < DH_W - 1; x += 1) {
        bits = (bits << 1n) | (raw[off + y * DH_W + x]! > raw[off + y * DH_W + x + 1]! ? 1n : 0n);
      }
    }
    hashes.push(bits);
  }
  return hashes;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    x &= x - 1n;
    n += 1;
  }
  return n;
}

/** local maxima of the consecutive-frame series: non-zero, strictly above the
 *  left neighbour, not below the right one (deterministic on ties/plateaus) */
export function changePoints(deltas: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < deltas.length - 1; i += 1) {
    if (deltas[i]! > 0 && deltas[i]! > deltas[i - 1]! && deltas[i]! >= deltas[i + 1]!) out.push(i);
  }
  return out;
}

/** greedy by delta height (ties → lower frame index). Frame 0 is always an
 *  anchor and DOES participate in spacing — a peak 35f after cut-in is noise. */
export function pick(cands: number[], deltas: number[], maxN: number, minGap: number): number[] {
  const picked: number[] = [0];
  const order = [...cands].sort((a, b) => (deltas[b]! - deltas[a]!) || (a - b));
  for (const i of order) {
    if (picked.length >= maxN) break;
    if (picked.every((j) => Math.abs(i - j) >= minGap)) picked.push(i);
  }
  return picked.sort((a, b) => a - b);
}

export type AnchorRecord = {
  video: string;
  fps: number;
  frame_count: number;
  max: number;
  min_gap_frames: number;
  candidates: number;
  anchors: { frame: number; t_s: number; dhash_delta: number }[];
};

export async function writeAnchors(
  video: string,
  outJson: string,
  opts: { fps?: number; max?: number; minGapFrames?: number } = {},
): Promise<AnchorRecord> {
  const wantFps = opts.fps ?? 24;
  const maxN = opts.max ?? 5;
  const minGap = opts.minGapFrames ?? 124;
  const facts = await probe(video);
  if (Math.abs(facts.fps - wantFps) > 1e-6) {
    throw new Error(`${video}: stream is ${facts.fps} fps but anchor fps says ${wantFps} — the stream wins`);
  }
  const hashes = await frameHashes(video);
  if (hashes.length !== facts.nbFrames) {
    throw new Error(`${video}: ffprobe says ${facts.nbFrames} frames, extracted ${hashes.length}`);
  }
  const deltas = [0];
  for (let i = 1; i < hashes.length; i += 1) deltas.push(hamming(hashes[i - 1]!, hashes[i]!));
  const cands = changePoints(deltas);
  const frames = pick(cands, deltas, maxN, minGap);
  const record: AnchorRecord = {
    video,
    fps: facts.fps,
    frame_count: facts.nbFrames,
    max: maxN,
    min_gap_frames: minGap,
    candidates: cands.length,
    anchors: frames.map((f) => ({ frame: f, t_s: Math.round((f / facts.fps) * 1e4) / 1e4, dhash_delta: deltas[f]! })),
  };
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(record, null, 2));
  return record;
}
