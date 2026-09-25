import fs from "node:fs";
import path from "node:path";
import { DEFAULT_CREW, type CrewConfig } from "./crew-llm";

export type SlateConfig = {
  crew: CrewConfig;
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
  /** AuK :9882 verbatim clone (CosyVoice :9880 is dead). promptWav = the clone
   *  ref whose speaker the /tts output follows; empty = env AUK_REF_WAV or
   *  job-level --clone upload must supply it, else the voice hop fails loud. */
  tts: { endpoint: string; model: string; promptWav: string; seed: number };
  /** CARD_BUG3_0920 item4 (Fable): the photo-qc second eye now lives in config,
   *  not just env. Empty secondEndpoint = not armed — judge GREEN stays capped
   *  at PASS_UNCONFIRMED. Env SLATECREW_SECOND_ENDPOINT/SLATECREW_SECOND_MODEL
   *  override (test seam, same chain seats photo-qc reads: opts → env → config). */
  pictureQc: { endpoint: string; model: string; secondEndpoint: string; secondModel: string };
  /** PACKAGE-QC-0917 眼：nex-n2.5 五路 describe（判官先係 pictureQc 端點）。空 endpoint＝fleet UNCONFIG（唔係 QC skip），live :8017 由 slatecrew.config.json 提供。 */
  nex: { endpoint: string; model: string };
  /** Card D 掣3 search-first PE step: local brains only (nex :8017 first,
   *  qwen38 :8015 backup). GLM cloud brains are banned for PE — thinking
   *  bursts the content field (0919 wire receipts). */
  pe: {
    endpoint: string;
    model: string;
    fallbackEndpoint: string;
    fallbackModel: string;
    maxTokens: number;
    wigoloClient: string;
    timeoutMs: number;
    /** 簡單改寫，上網搜尋關住。sensenova-v6.8-flash-lite via LiteLLM. */
    rewriteEndpoint: string;
    rewriteModel: string;
  };
  mesher: {
    endpoint: string;
    blender: string;
    textureResolution: number;
    targetHeightM: number;
  };
  soundQc: { endpoint: string; model: string };
  /** A3: every sense is a provider. Empty = the stage that needs it FAILs loud. */
  ocr: { endpoint: string; model: string };
  embed: { endpoint: string; model: string };
  /** H3 frame grid 17k+5. kMin 3 ≈ 2.3s. Do not clamp every shot up to k=7. */
  h3Grid: { kMin: number; kMax: number };
  ssh: { user: string; motionInputDir: string; stillsRefsDir: string };
};

const DEFAULTS: SlateConfig = {
  crew: DEFAULT_CREW,
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
    turboLora: "minimax_h3_ref2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors",
    textEncoder: "qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors",
    videoVae: "minimax_h3_video_vae_fp16.safetensors",
    audioVae: "minimax_h3_audio_vae_fp32.safetensors",
    width: 864,
    height: 480,
    steps: 8,
    seed: 42,
  },
  tts: {
    endpoint: "http://127.0.0.1:9882",
    model: "auk-flash-1.5B",
    promptWav: "",
    seed: 20260914,
  },
  pictureQc: { endpoint: "http://127.0.0.1:8015", model: "qwen38", secondEndpoint: "", secondModel: "" },
  nex: { endpoint: "", model: "nex-n2.5" },
  pe: {
    endpoint: "http://127.0.0.1:8017",
    model: "nex-n2.5",
    fallbackEndpoint: "http://127.0.0.1:8015",
    fallbackModel: "qwen38",
    // nex call-shape law: effort none + official sampling 0.7/0.95/40 + max_tokens >= 5000
    maxTokens: 6000,
    wigoloClient: "/mnt/ssd/u1_canvas_research/wigolo_research.py",
    timeoutMs: 300_000,
    rewriteEndpoint: "http://127.0.0.1:4000",
    rewriteModel: "sensenova-v6.8-flash-lite",
  },
  mesher: {
    endpoint: "http://127.0.0.1:8018",
    blender: "/home/c/applications/blender-5.1.2-linux-x64/blender",
    textureResolution: 512,
    targetHeightM: 1.7,
  },
  soundQc: { endpoint: "", model: "FunAudioLLM/SenseVoiceSmall" },
  ocr: { endpoint: "", model: "" },
  embed: { endpoint: "", model: "wemm-2b" },
  h3Grid: { kMin: 3, kMax: 21 },
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
    crew: { ...DEFAULTS.crew, ...raw.crew },
    stills: { ...DEFAULTS.stills, ...raw.stills },
    motion: { ...DEFAULTS.motion, ...raw.motion },
    tts: { ...DEFAULTS.tts, ...raw.tts },
    pictureQc: { ...DEFAULTS.pictureQc, ...raw.pictureQc },
    nex: { ...DEFAULTS.nex, ...raw.nex },
    pe: { ...DEFAULTS.pe, ...raw.pe },
    mesher: { ...DEFAULTS.mesher, ...raw.mesher },
    soundQc: { ...DEFAULTS.soundQc, ...raw.soundQc },
    ocr: { ...DEFAULTS.ocr, ...raw.ocr },
    embed: { ...DEFAULTS.embed, ...raw.embed },
    h3Grid: { ...DEFAULTS.h3Grid, ...raw.h3Grid },
    ssh: { ...DEFAULTS.ssh, ...raw.ssh },
  };
  const h3 = process.env.H3_COMFY_URL?.trim();
  if (h3) merged.motion.comfyUrl = h3;
  const u15 = process.env.U15_URL?.trim();
  if (u15) merged.stills.url = u15;
  const mars = process.env.MARS_URL?.trim();
  if (mars) merged.pictureQc.endpoint = mars;
  const secondE = process.env.SLATECREW_SECOND_ENDPOINT?.trim();
  if (secondE) merged.pictureQc.secondEndpoint = secondE;
  const secondM = process.env.SLATECREW_SECOND_MODEL?.trim();
  if (secondM) merged.pictureQc.secondModel = secondM;
  const nex = process.env.NEX_URL?.trim();
  if (nex) merged.nex.endpoint = nex;
  const crew = process.env.CREW_LLM_URL?.trim();
  if (crew) merged.crew.endpoint = crew;
  const auk = process.env.AUK_TTS_URL?.trim();
  if (auk) merged.tts.endpoint = auk;
  const aukRef = process.env.AUK_REF_WAV?.trim();
  if (aukRef) merged.tts.promptWav = aukRef;
  const sf3d = process.env.SF3D_URL?.trim();
  if (sf3d) merged.mesher.endpoint = sf3d;
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
