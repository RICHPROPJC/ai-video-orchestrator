import { loadConfig } from "./config";
import { probeComfy } from "./comfy";
import { runCommand } from "./audio";

export type DoctorReport = {
  ffmpeg: boolean;
  blender: boolean;
  comfy: Awaited<ReturnType<typeof probeComfy>>;
  config: ReturnType<typeof loadConfig>;
};

export async function doctor(): Promise<DoctorReport> {
  const ffmpeg = await runCommand("ffmpeg", ["-version"]).then((r) => r.code === 0).catch(() => false);
  const blenderBin = process.env.BLENDER_BIN || "blender";
  const blender = await runCommand(blenderBin, ["-b", "--version"]).then((r) => r.code === 0).catch(() => false);
  const comfy = await probeComfy();
  return { ffmpeg, blender, comfy, config: loadConfig() };
}

export function formatDoctor(report: DoctorReport) {
  const lines = [
    `ffmpeg     ${report.ffmpeg ? "UP" : "DOWN"}`,
    `blender    ${report.blender ? "UP" : "DOWN (script still delivered)"}`,
    `comfy      ${report.comfy.up ? `UP ${report.comfy.url}` : `DOWN ${report.comfy.url}  ${report.comfy.error ?? ""}`.trim()}`,
    `stills     ${report.config.stills.checkpoint}`,
    `          ${report.config.stills.workflow}`,
    `motion     ${report.config.motion.checkpoint}`,
    `          ${report.config.motion.workflow}`,
    `qc         picture ${report.config.pictureQc.model}`,
    `           sound   ${report.config.soundQc.model}`,
    `tts        ${report.config.tts.model}`,
  ];
  if (report.comfy.up && report.comfy.checkpoints.length) {
    lines.push(`comfy ckpt ${report.comfy.checkpoints.slice(0, 8).join(", ")}`);
  }
  const need = ["MiniMaxH3ImageToVideo", "SenseNova U1 Local Text to Image", "SenseNovaU15Loader"];
  if (report.comfy.up) {
    const have = need.filter((n) => report.comfy.nodes.some((x) => x.includes(n) || n.includes(x)));
    lines.push(`nodes     ${have.length ? have.join(", ") : "templates missing — export API JSON from Comfy"}`);
  }
  return lines.join("\n");
}
