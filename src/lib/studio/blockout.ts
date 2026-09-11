import fs from "node:fs";
import path from "node:path";
import type { CallSheet, Shot } from "./types";
import { blenderBlockoutScript } from "./blender";
import { runCommand } from "./audio";
import { snapDurationToFrames, wavSeconds } from "./frame-grid";
import { probe } from "./dhash-anchors";

export const BLOCKOUT_WIDTH = 864;
export const BLOCKOUT_HEIGHT = 480;
export const BLOCKOUT_FPS = 24;

async function ffmpeg(args: string[]) {
  const r = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (r.code !== 0) throw new Error(r.stderr || "ffmpeg failed");
}

/** grey WORKBENCH render of one shot: PNG sequence from Blender, then x264.
 *  Any non-zero exit throws — no SVG/IK fallback exists for blockouts. */
export async function renderBlockout(opts: {
  sheet: CallSheet;
  shot: Shot;
  frames: number;
  outMp4: string;
  blenderBin?: string;
}): Promise<{ scriptFile: string; framesDir: string; frames: number }> {
  const blender = opts.blenderBin || process.env.BLENDER_BIN || "blender";
  const scriptFile = opts.outMp4.replace(/\.mp4$/, ".blender.py");
  const framesDir = opts.outMp4.replace(/\.mp4$/, ".frames");
  fs.mkdirSync(path.dirname(scriptFile), { recursive: true });
  fs.mkdirSync(framesDir, { recursive: true });
  fs.writeFileSync(scriptFile, blenderBlockoutScript(opts.sheet, opts.shot.id));

  const render = await runCommand(blender, [
    "-b", "--threads", "8", "-P", scriptFile, "--",
    "--frames", String(opts.frames),
    "--out", framesDir,
    "--width", String(BLOCKOUT_WIDTH),
    "--height", String(BLOCKOUT_HEIGHT),
    "--fps", String(BLOCKOUT_FPS),
  ]);
  if (render.code !== 0) {
    throw new Error(`blender blockout failed (${opts.shot.id}, exit ${render.code}): ${render.stderr || render.stdout}`);
  }
  const pngs = fs.readdirSync(framesDir).filter((f) => /^frame_\d{4}\.png$/.test(f));
  if (pngs.length !== opts.frames) {
    throw new Error(`blender rendered ${pngs.length} frames, wanted ${opts.frames} (${opts.shot.id})`);
  }
  fs.mkdirSync(path.dirname(opts.outMp4), { recursive: true });
  await ffmpeg([
    "-framerate", String(BLOCKOUT_FPS),
    "-i", path.join(framesDir, "frame_%04d.png"),
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-s", `${BLOCKOUT_WIDTH}x${BLOCKOUT_HEIGHT}`,
    opts.outMp4,
  ]);
  fs.rmSync(framesDir, { recursive: true, force: true });
  return { scriptFile, framesDir, frames: opts.frames };
}

/** pre-rendered blockout from --blockout-dir: must exist, be 24 fps, and carry
 *  exactly the snapped frame count for the wav — anything else is a FAIL. */
export async function blockoutFromPlug(
  dir: string,
  shotId: string,
  wavFile: string,
): Promise<string> {
  const mp4 = path.join(dir, `${shotId}.mp4`);
  if (!fs.existsSync(mp4)) throw new Error(`blockout plug missing ${mp4}`);
  const seconds = await wavSeconds(wavFile);
  const frames = snapDurationToFrames(seconds);
  const facts = await probe(mp4);
  if (facts.fps !== BLOCKOUT_FPS) {
    throw new Error(`blockout plug ${mp4} is ${facts.fps} fps, wanted ${BLOCKOUT_FPS}`);
  }
  if (facts.nbFrames !== frames) {
    throw new Error(`blockout plug ${mp4} has ${facts.nbFrames} frames, wav snap wants ${frames}`);
  }
  return mp4;
}

/** frame 0 of a blockout = the base image for a first-appearance /edit */
export async function extractFrame0(mp4: string, png: string): Promise<void> {
  fs.mkdirSync(path.dirname(png), { recursive: true });
  await ffmpeg(["-i", mp4, "-frames:v", "1", png]);
}
