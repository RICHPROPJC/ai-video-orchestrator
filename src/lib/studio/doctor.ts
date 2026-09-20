import fs from "node:fs";
import { loadConfig, legacyComfyUrl, type SlateConfig } from "./config";
import { runCommand } from "./audio";

// node list the H3 R2V chain needs on node1 (h3-r2v-graph.ts wiring; card C ①
// switched the keyframe node — doctor must probe what the graph now emits)
const H3_NODES = [
  "MiniMaxH3ReferenceToVideo",
  "H3Keyframes",
  "H3EpisodeSplit",
  "H3LoraStack",
  "H3ReferenceAudio",
  "H3FreeTextEncoder",
  "H3ConditionStrength",
  "MiniMaxH3SigmaShift",
  "SolAttnMiniMaxH3Patcher",
  "H3FirstBlockCache",
  "H3ModelLoaderAny",
  "H3ClipLoaderAny",
  "VHS_LoadVideo",
  "H3LastFrame",
];

const VIMAX_SECRETS_ENV = "/mnt/ssd/vimax_repo/.vimax/secrets.env";

export type MotionProbe = {
  up: boolean;
  url: string;
  error?: string;
  nodesMissing: string[];
};

export type StillsProbe = {
  up: boolean;
  url: string;
  error?: string;
  model?: string;
  multiImage?: boolean;
  defaults?: Record<string, unknown>;
};

export type MarsProbe = {
  up: boolean;
  url: string;
  error?: string;
  modelPresent: boolean;
  models: string[];
};

export type DoctorReport = {
  ffmpeg: boolean;
  blender: boolean;
  sshpass: boolean;
  sshPassSource: string | null;
  motion: MotionProbe;
  stills: StillsProbe;
  pictureQc: MarsProbe;
  config: SlateConfig;
  warns: string[];
};

const LOOPBACK = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:|\/|$)/;

export function configWarns(cfg: SlateConfig): string[] {
  const warns: string[] = [];
  const urls: [string, string][] = [
    ["stills.url", cfg.stills.url],
    ["motion.comfyUrl", cfg.motion.comfyUrl],
    ["pictureQc.endpoint", cfg.pictureQc.endpoint],
  ];
  for (const [name, url] of urls) {
    if (url && LOOPBACK.test(url)) warns.push(`loopback ${name} ${url} — fleet hosts are tailnet/docker IPs`);
  }
  const legacy = legacyComfyUrl();
  if (legacy) warns.push(`legacy top-level comfyUrl "${legacy}" ignored — config is two-host (stills.url + motion.comfyUrl)`);
  if (process.env.NODE_USE_ENV_PROXY) {
    warns.push("NODE_USE_ENV_PROXY is set — node fetch would route tailnet hosts through HTTP_PROXY, which rejects them");
  }
  return warns;
}

export function sshPassSourceName(): string | null {
  if (process.env.SLATECREW_SSH_PASS) return "env SLATECREW_SSH_PASS";
  if (process.env.VIMAX_SSH_PASS) return "env VIMAX_SSH_PASS";
  try {
    if (fs.existsSync(VIMAX_SECRETS_ENV)) {
      const text = fs.readFileSync(VIMAX_SECRETS_ENV, "utf8");
      if (/^\s*VIMAX_SSH_PASS\s*=\s*\S/m.test(text)) return `file ${VIMAX_SECRETS_ENV} (key VIMAX_SSH_PASS)`;
    }
  } catch {
    return null; // unreadable secrets file = no source
  }
  return null;
}

async function probeMotion(url: string): Promise<MotionProbe> {
  const base = url.replace(/\/$/, "");
  try {
    const stats = await fetch(`${base}/system_stats`, { signal: AbortSignal.timeout(2500) });
    if (!stats.ok) throw new Error(`HTTP ${stats.status}`);
    let nodes: string[] = [];
    try {
      const info = (await (await fetch(`${base}/object_info`, { signal: AbortSignal.timeout(8000) })).json()) as Record<string, unknown>;
      nodes = Object.keys(info);
    } catch {
      nodes = []; // host is up; node list unavailable this probe
    }
    return { up: true, url: base, nodesMissing: H3_NODES.filter((n) => !nodes.includes(n)) };
  } catch (error) {
    return {
      up: false,
      url: base,
      error: error instanceof Error ? error.message : String(error),
      nodesMissing: [...H3_NODES],
    };
  }
}

async function probeStills(url: string): Promise<StillsProbe> {
  const base = url.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const info = (await res.json()) as { model?: string; multi_image?: boolean; defaults?: Record<string, unknown> };
    return { up: true, url: base, model: info.model, multiImage: info.multi_image, defaults: info.defaults };
  } catch (error) {
    return { up: false, url: base, error: error instanceof Error ? error.message : String(error) };
  }
}

async function probeMars(url: string, model: string): Promise<MarsProbe> {
  const base = url.replace(/\/$/, "");
  try {
    const res = await fetch(`${base}/v1/models`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = (await res.json()) as { data?: { id?: string }[] };
    const models = (json.data ?? []).map((m) => m.id ?? "").filter(Boolean);
    return { up: true, url: base, modelPresent: models.includes(model), models };
  } catch (error) {
    return { up: false, url: base, error: error instanceof Error ? error.message : String(error), modelPresent: false, models: [] };
  }
}

export async function doctor(): Promise<DoctorReport> {
  const cfg = loadConfig();
  const ffmpeg = await runCommand("ffmpeg", ["-version"]).then((r) => r.code === 0).catch(() => false);
  const blenderBin = process.env.BLENDER_BIN || "blender";
  const blender = await runCommand(blenderBin, ["-b", "--version"]).then((r) => r.code === 0).catch(() => false);
  const sshpass = await runCommand("which", ["sshpass"]).then((r) => r.code === 0).catch(() => false);
  return {
    ffmpeg,
    blender,
    sshpass,
    sshPassSource: sshPassSourceName(),
    motion: await probeMotion(cfg.motion.comfyUrl),
    stills: await probeStills(cfg.stills.url),
    pictureQc: await probeMars(cfg.pictureQc.endpoint, cfg.pictureQc.model),
    config: cfg,
    warns: configWarns(cfg),
  };
}

export function formatDoctor(report: DoctorReport) {
  const lines = [
    `ffmpeg     ${report.ffmpeg ? "UP" : "DOWN"}`,
    `blender    ${report.blender ? "UP" : "DOWN (blockout render needs it)"}`,
    `sshpass    ${report.sshpass ? "UP" : "DOWN (scp upload needs it)"}  pass source ${report.sshPassSource ?? "none"}`,
    `motion     ${report.motion.up ? `UP ${report.motion.url}` : `DOWN ${report.motion.url}  ${report.motion.error ?? ""}`.trim()}`,
    `  nodes    ${report.motion.up ? (report.motion.nodesMissing.length ? `MISSING ${report.motion.nodesMissing.join(", ")}` : `all ${H3_NODES.length} present`) : "unknown (host down)"}`,
    `  ckpt     ${report.config.motion.checkpoint}`,
    `stills     ${report.stills.up ? `UP ${report.stills.url}` : `DOWN ${report.stills.url}  ${report.stills.error ?? ""}`.trim()}`,
    `  /edit    model ${report.stills.model ?? "?"}  multi_image ${report.stills.multiImage ?? "?"}  defaults ${JSON.stringify(report.stills.defaults ?? {})}`,
    `pictureqc  ${report.pictureQc.up ? `UP ${report.pictureQc.url}` : `DOWN ${report.pictureQc.url}  ${report.pictureQc.error ?? ""}`.trim()}`,
    `  mars     ${report.pictureQc.modelPresent ? `${report.config.pictureQc.model} present` : `${report.config.pictureQc.model} NOT listed (host has ${report.pictureQc.models.length} models)`}`,
  ];
  for (const warn of report.warns) lines.push(`WARN  ${warn}`);
  return lines.join("\n");
}
