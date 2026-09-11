import fs from "node:fs";
import path from "node:path";

export type SlateConfig = {
  comfyUrl: string;
  stills: {
    workflow: string;
    checkpoint: string;
  };
  motion: {
    workflow: string;
    checkpoint: string;
    textEncoder: string;
    videoVae: string;
    audioVae: string;
  };
  tts: { endpoint: string; model: string };
  pictureQc: { endpoint: string; model: string };
  soundQc: { endpoint: string; model: string };
};

const DEFAULTS: SlateConfig = {
  comfyUrl: "http://127.0.0.1:8188",
  stills: {
    workflow: "workflows/u15-t2i.api.json",
    checkpoint: "SenseNova-U1.5-8B-MoT.safetensors",
  },
  motion: {
    workflow: "workflows/h3-i2v.api.json",
    checkpoint: "minimax_h3_fl2va_pruned_int8_convrot.safetensors",
    textEncoder: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    videoVae: "minimax_h3_video_vae_fp16.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
  },
  tts: { endpoint: "", model: "Fun-CosyVoice3-0.5B" },
  pictureQc: { endpoint: "", model: "sensenova/SenseNova-MARS-8B" },
  soundQc: { endpoint: "", model: "FunAudioLLM/SenseVoiceSmall" },
};

export function configPath() {
  return path.join(process.cwd(), "slatecrew.config.json");
}

export function loadConfig(): SlateConfig {
  const file = configPath();
  if (!fs.existsSync(file)) return structuredClone(DEFAULTS);
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<SlateConfig>;
  return {
    ...DEFAULTS,
    ...raw,
    stills: { ...DEFAULTS.stills, ...raw.stills },
    motion: { ...DEFAULTS.motion, ...raw.motion },
    tts: { ...DEFAULTS.tts, ...raw.tts },
    pictureQc: { ...DEFAULTS.pictureQc, ...raw.pictureQc },
    soundQc: { ...DEFAULTS.soundQc, ...raw.soundQc },
    comfyUrl: process.env.COMFY_URL?.trim() || raw.comfyUrl || DEFAULTS.comfyUrl,
  };
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
