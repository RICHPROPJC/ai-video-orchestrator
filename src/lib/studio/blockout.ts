import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
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
  await assertFiguresVisible(path.join(framesDir, "frame_0001.png"), opts.shot);
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

/** frame 0 of a blockout = the base image for a first-appearance /edit.
 *  A stanceEnd shot's keyframe is the pose held after the transition (its f0
 *  must differ from the previous shot — the C3KJ lesson), so frame 1 by default,
 *  end-of-lerp frame when any mark animates its stance. */
export function stillFrameFor(shot: Shot, frames: number): number {
  const animated = shot.marks.some((m) => m.stanceEnd && m.stanceEnd !== m.stance);
  return animated ? Math.min(frames, Math.round(0.4 * frames) + 1) : 1;
}

export async function extractFrame0(mp4: string, png: string, frame = 1): Promise<void> {
  fs.mkdirSync(path.dirname(png), { recursive: true });
  await ffmpeg(["-i", mp4, "-vf", `select='eq(n,${frame - 1})'`, "-frames:v", "1", png]);
}

/** every mark's crop box must show a figure: real renders span ≥106 luma
 *  (figure 170 vs bg 64 / floor 207); the empty-floor regression fixture's
 *  worst crop spans 57 (STUDIO gradient + mark disc), so 70 separates both. */
const FIGURE_LUMA_SPAN_MIN = 70;
export async function assertFiguresVisible(f0png: string, shot: Shot): Promise<void> {
  const meta = await sharp(f0png).metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error(`${f0png}: cannot read dimensions for figure check`);
  // insert = detail framing (hands/prop); the body mark is off-frame by design, so the
  // figure crop sees only figure+floor (5.1.2: 159 vs 179, span 20) — no figure claim to gate
  if (shot.size === "insert") return;
  for (const mark of shot.marks) {
    const w = Math.round(width * 0.16);
    const h = Math.round(height * 0.4);
    const x = Math.max(0, Math.min(width - w, Math.round((width * mark.start.x) / 100 - w / 2)));
    const y = Math.max(0, Math.min(height - h, Math.round((height * mark.start.y) / 100 - h / 2)));
    const r = await runCommand("ffprobe", [
      "-v", "error",
      "-f", "lavfi", "-i", `movie='${f0png.replaceAll("'", "\\'")}',format=gray,crop=${w}:${h}:${x}:${y},signalstats`,
      "-show_entries", "frame_tags=lavfi.signalstats.YMIN,lavfi.signalstats.YMAX",
      "-of", "json",
    ]);
    if (r.code !== 0) throw new Error(`${shot.id} figure check ffprobe failed: ${r.stderr}`);
    const frames = (JSON.parse(r.stdout).frames ?? []) as { tags?: Record<string, string> }[];
    const tags = frames[0]?.tags ?? {};
    const ymin = Number(tags["lavfi.signalstats.YMIN"]);
    const ymax = Number(tags["lavfi.signalstats.YMAX"]);
    if (!Number.isFinite(ymin) || !Number.isFinite(ymax) || ymax - ymin < FIGURE_LUMA_SPAN_MIN) {
      throw new Error(
        `${shot.id} blockout has no figure at mark ${mark.characterId} (Ymin=${tags["lavfi.signalstats.YMIN"]} Ymax=${tags["lavfi.signalstats.YMAX"]})`,
      );
    }
  }
}
