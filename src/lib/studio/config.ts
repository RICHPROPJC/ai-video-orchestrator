import fs from "node:fs";
import path from "node:path";

export type SlateConfig = {
  stills: {
    url: string;
    comfyUrl: string;
    workflow: string;
    checkpoint: string;
    width: number;
    height: number;
  };
  motion: {
    comfyUrl: string;
    checkpoint: string;
    fl2va: string;
    turboLora: string;
    textEncoder: string;
    videoVae: string;
    audioVae: string;
    width: number;
    height: number;
    steps: number;
    seed: number;
  };
  tts: { endpoint: string; model: string };
  pictureQc: { endpoint: string; model: string };
  soundQc: { endpoint: string; model: string };
  ssh: { user: string; motionInputDir: string; stillsRefsDir: string };
};

const DEFAULTS: SlateConfig = {
  stills: {
    url: "http://100.76.131.19:8097",
    comfyUrl: "",
    workflow: "workflows/u15-t2i.api.json",
    checkpoint: "SenseNova-U1.5-8B-MoT.safetensors",
    width: 2048,
    height: 1152,
  },
  motion: {
    comfyUrl: "http://100.127.176.64:8188",
    checkpoint: "minimax_h3_ref2va_pruned_int8_convrot.safetensors",
    fl2va: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    turboLora: "minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors",
    textEncoder: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    videoVae: "minimax_h3_video_vae_fp16.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
    width: 864,
    height: 480,
    steps: 4,
    seed: 42,
  },
  tts: { endpoint: "", model: "Fun-CosyVoice3-0.5B" },
  pictureQc: { endpoint: "http://172.17.0.2:8015", model: "mars-fa2" },
  soundQc: { endpoint: "", model: "FunAudioLLM/SenseVoiceSmall" },
  ssh: {
    user: "hojaiv3v",
    motionInputDir: "~/comfy/ComfyUI/input",
    stillsRefsDir: "/home/hojaiv3v/SenseNova-U1/refs",
  },
};

export function configPath() {
  return path.join(process.cwd(), "slatecrew.config.json");
}

export function loadConfig(): SlateConfig {
  const file = configPath();
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SlateConfig>;
  const merged: SlateConfig = {
    ...DEFAULTS,
    ...raw,
    stills: { ...DEFAULTS.stills, ...raw.stills },
    motion: { ...DEFAULTS.motion, ...raw.motion },
    tts: { ...DEFAULTS.tts, ...raw.tts },
    pictureQc: { ...DEFAULTS.pictureQc, ...raw.pictureQc },
    soundQc: { ...DEFAULTS.soundQc, ...raw.soundQc },
    ssh: { ...DEFAULTS.ssh, ...raw.ssh },
  };
  const h3 = process.env.H3_COMFY_URL?.trim();
  if (h3) merged.motion.comfyUrl = h3;
  const u15 = process.env.U15_URL?.trim();
  if (u15) merged.stills.url = u15;
  const mars = process.env.MARS_URL?.trim();
  if (mars) merged.pictureQc.endpoint = mars;
  return merged;
}

export function legacyComfyUrl(): string | null {
  const file = configPath();
  if (!fs.existsSync(file)) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
  return typeof raw.comfyUrl === "string" ? raw.comfyUrl : null;
}

export function saveConfig(next: SlateConfig) {
  fs.writeFileSync(configPath(), JSON.stringify(next, null, 2) + "\n");
}

export function setConfigPath(dot: string, value: string) {
  const cfg = loadConfig();
  const parts = dot.split(".");
  let cur: Record<string, unknown> = cfg as unknown as Record<string, unknown>;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const key = parts[i]!;
    const nxt = cur[key];
    if (!nxt || typeof nxt !== "object") throw new Error(`unknown key ${dot}`);
    cur = nxt as Record<string, unknown>;
  }
  cur[parts.at(-1)!] = value;
  saveConfig(cfg);
  return cfg;
}

export { DEFAULTS as defaultConfig };
