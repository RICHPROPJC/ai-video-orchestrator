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
    // 5.1.2 -b with DISPLAY set picks GLX on this host and segfaults (exit 139, no
    // ARB_shader_draw_parameters); stripped → surfaceless EGL, pixel-identical to vulkan
    // (receipts /tmp/bl_egl_run vs /tmp/bl_vk_run). Same rule as lane/front 735dc2e.
  ], undefined, { DISPLAY: undefined, WAYLAND_DISPLAY: undefined });
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
  // 幀鐘夾唔埋防禦（Y8KH SH05 實證）：caller 傳 H3 生成窗 grid（≤1s 全
  // snap 56f）但 mp4 係 -r 24 牆時長（0.4s→11f）——select 抽 n=22 越界＝
  // 零輸出 exit 0，f0 靜靜缺，下游 sharp「Input file is missing」。probe
  // 實際幀數 clamp 到最尾幀：抽取永遠落在檔內（動作位語意由 caller 鐘
  // 決定，呢度只保證唔越界）。
  let want = frame;
  const pr = await runCommand("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", mp4]);
  if (pr.code === 0) {
    const nb = Number((pr.stdout ?? "").trim());
    if (Number.isFinite(nb) && nb > 0) want = Math.min(frame, nb);
  }
  await ffmpeg(["-i", mp4, "-vf", `select='eq(n,${want - 1})'`, "-frames:v", "1", png]);
  if (!fs.existsSync(png)) throw new Error(`extractFrame0: ${path.basename(mp4)} 抽幀 ${want}/${want - 1}n 零輸出——f0 冇寫`);
}

/** 統籌 ruling 0930（y8kh-r12-stop-grey-base 實裝令）：灰模唔再以單張 f0 做
 *  鍵格板 base——每鏡用自己條 blockout mp4 抽 16 幀（序號 round(i*(nb-1)/15)，
 *  i=0..15，含首尾幀）砌同格式 4×4 灰模 ref 板做 /edit images[0]，出板第 i
 *  格對第 i 格灰模。唔夠 16 個互異幀（SH05 11 幀實證）＝named gap：唔複製幀
 *  填滿、唔交板——caller blocked 呢鏡。 */
export async function greyKfRefBoard(
  mp4: string,
  outPng: string,
  spawn = 16,
): Promise<{ ok: true; file: string; frames: number; idx: number[] } | { ok: false; reason: string }> {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  if (fs.existsSync(outPng)) {
    // 幂等重用：板在場＋來源 mp4 冇新過佢就照用（唔重抽）
    if (fs.statSync(mp4).mtimeMs <= fs.statSync(outPng).mtimeMs) {
      return { ok: true, file: outPng, frames: -1, idx: [] };
    }
  }
  const pr = await runCommand("ffprobe", ["-v", "error", "-select_streams", "v:0", "-count_frames", "-show_entries", "stream=nb_read_frames", "-of", "csv=p=0", mp4]);
  if (pr.code !== 0) return { ok: false, reason: `ffprobe fail: ${(pr.stderr || "").slice(0, 120)}` };
  const nb = Number((pr.stdout ?? "").trim());
  if (!Number.isFinite(nb) || nb <= 0) return { ok: false, reason: `nb_read_frames=${nb}` };
  const idx = Array.from({ length: spawn }, (_, i) => Math.round((i * (nb - 1)) / (spawn - 1)));
  if (new Set(idx).size !== spawn) return { ok: false, reason: `mp4 淨 ${nb} 幀，${spawn} 抽樣序號互撞（${idx.join(",")}）——唔複製幀填滿` };
  const tmp = fs.mkdtempSync(path.join("/tmp", "greykf-"));
  try {
    const frames: string[] = [];
    for (const [k, n] of idx.entries()) {
      const f = path.join(tmp, `f${String(k).padStart(2, "0")}.png`);
      const r = await runCommand("ffmpeg", ["-y", "-v", "error", "-i", mp4, "-vf", `select='eq(n,${n})'`, "-frames:v", "1", f]);
      if (r.code !== 0 || !fs.existsSync(f)) return { ok: false, reason: `抽幀 ${n}n 零輸出（exit ${r.code}）` };
      frames.push(f);
    }
    const cell = 512;
    const cols = 4;
    const rows = Math.ceil(spawn / cols);
    const bufs = await Promise.all(frames.map((f) => sharp(f).resize(cell, cell, { fit: "cover" }).png().toBuffer()));
    await sharp({ create: { width: cell * cols, height: cell * rows, channels: 3, background: { r: 255, g: 255, b: 255 } } })
      .composite(bufs.map((input, i) => ({ input, left: (i % cols) * cell, top: Math.floor(i / cols) * cell })))
      .png()
      .toFile(outPng);
    return { ok: true, file: outPng, frames: nb, idx };
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
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
  // SC-CREATIVE-OS-0927 §2C：空 cast＝產品／環境鏡——冇人形可驗。改驗畫面有
  // 主體：中央 crop 唔係全平（YMIN<YMAX 有層次）。唔准為過人形閘偷塞人。
  if (shot.marks.length === 0) {
    const w = Math.round(width * 0.6);
    const h = Math.round(height * 0.6);
    const x = Math.round((width - w) / 2);
    const y = Math.round((height - h) / 2);
    const r = await runCommand("ffprobe", [
      "-v", "error",
      "-f", "lavfi", "-i", `movie='${f0png.replaceAll("'", "\\'")}',format=gray,crop=${w}:${h}:${x}:${y},signalstats`,
      "-show_entries", "frame_tags=lavfi.signalstats.YMIN,lavfi.signalstats.YMAX",
      "-of", "json",
    ]);
    if (r.code !== 0) throw new Error(`${shot.id} subject check ffprobe failed: ${r.stderr}`);
    const frames = (JSON.parse(r.stdout).frames ?? []) as { tags?: Record<string, string> }[];
    const tags = frames[0]?.tags ?? {};
    const ymin = Number(tags["lavfi.signalstats.YMIN"] ?? 255);
    const ymax = Number(tags["lavfi.signalstats.YMAX"] ?? 0);
    if (Number.isFinite(ymin) && Number.isFinite(ymax) && ymax - ymin < 12) {
      throw new Error(`${shot.id} 空 cast 鏡中央冇主體（span ${ymax - ymin}）——產品/環境鏡都要有嘢喺畫面`);
    }
    return;
  }
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
