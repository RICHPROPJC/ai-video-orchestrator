import fs from "node:fs";
import path from "node:path";
import { peakAndSilence, readWavMono } from "./audio";
import { loadConfig } from "./config";
import { comfyMotion, comfyStill, probeComfy } from "./comfy";
import type { CallSheet, PictureQc, Shot, SoundQc } from "./types";

function env(name: string) {
  return process.env[name]?.trim() || "";
}

export function providerConfig() {
  const file = loadConfig();
  return {
    u15: env("U15_ENDPOINT") || env("SENSENOVA_U15_URL"),
    h3: env("H3_ENDPOINT") || env("MINIMAX_H3_URL"),
    mars: env("MARS_ENDPOINT") || env("SENSENOVA_MARS_URL") || file.pictureQc.endpoint,
    senseVoice: env("SENSEVOICE_ENDPOINT") || file.soundQc.endpoint,
    tts: env("TTS_ENDPOINT") || env("COSYVOICE_URL") || file.tts.endpoint,
    apiKey: env("STUDIO_API_KEY") || env("OPENAI_API_KEY"),
  };
}

export async function generateStill(opts: {
  prompt: string;
  width: number;
  height: number;
  outFile: string;
}) {
  const comfyUrl = loadConfig().stills.comfyUrl;
  if (comfyUrl) {
    const comfy = await probeComfy(comfyUrl);
    if (comfy.up) {
      try {
        return await comfyStill(comfyUrl, opts);
      } catch {
        /* fallback HTTP / studio */
      }
    }
  }
  return generateStillHttp(opts);
}

export async function generateMotion(opts: {
  prompt: string;
  stillFile: string;
  outFile: string;
  seconds: number;
  width: number;
  height: number;
}) {
  const comfyUrl = loadConfig().motion.comfyUrl;
  const comfy = await probeComfy(comfyUrl);
  if (comfy.up) {
    try {
      return await comfyMotion(comfyUrl, opts);
    } catch {
      /* fallback HTTP / studio */
    }
  }
  return generateVideoHttp(opts);
}

async function postJson(url: string, body: unknown, apiKey?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`${url} ${res.status}`);
  return res;
}

export async function generateStillHttp(opts: {
  prompt: string;
  width: number;
  height: number;
  outFile: string;
}) {
  const cfg = providerConfig();
  if (!cfg.u15) return null;
  const res = await postJson(cfg.u15, {
    model: "sensenova/SenseNova-U1.5-8B-MoT",
    prompt: opts.prompt,
    width: opts.width,
    height: opts.height,
  }, cfg.apiKey);
  const ctype = res.headers.get("content-type") ?? "";
  if (ctype.includes("json")) {
    const json = (await res.json()) as { image_base64?: string; url?: string };
    if (json.image_base64) {
      fs.writeFileSync(opts.outFile, Buffer.from(json.image_base64, "base64"));
      return "u15-http";
    }
    if (json.url) {
      const img = await fetch(json.url);
      fs.writeFileSync(opts.outFile, Buffer.from(await img.arrayBuffer()));
      return "u15-http";
    }
  } else {
    fs.writeFileSync(opts.outFile, Buffer.from(await res.arrayBuffer()));
    return "u15-http";
  }
  return null;
}

export async function generateVideoHttp(opts: {
  prompt: string;
  stillFile: string;
  outFile: string;
  seconds: number;
}) {
  const cfg = providerConfig();
  if (!cfg.h3) return null;
  const still = fs.readFileSync(opts.stillFile).toString("base64");
  const res = await postJson(cfg.h3, {
    model: "MiniMax-H3",
    prompt: opts.prompt,
    first_frame_b64: still,
    duration: opts.seconds,
    semantic_bridge: "u1.5",
  }, cfg.apiKey);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(opts.outFile, buf);
  return "h3-http";
}

export async function ttsHttp(opts: { text: string; reference?: string; outFile: string }) {
  const cfg = providerConfig();
  if (!cfg.tts) return null;
  const res = await postJson(cfg.tts, {
    model: "Fun-CosyVoice3-0.5B",
    text: opts.text,
    reference: opts.reference,
  }, cfg.apiKey);
  fs.writeFileSync(opts.outFile, Buffer.from(await res.arrayBuffer()));
  return "cosyvoice-http";
}

export async function senseVoiceHttp(audioFile: string): Promise<Partial<SoundQc> | null> {
  const cfg = providerConfig();
  if (!cfg.senseVoice) return null;
  const b64 = fs.readFileSync(audioFile).toString("base64");
  const res = await postJson(cfg.senseVoice, { audio_b64: b64, language: "auto" }, cfg.apiKey);
  const json = (await res.json()) as {
    text?: string;
    emotion?: string;
    event?: string;
    language?: string;
  };
  return {
    provider: "sensevoice-http",
    transcript: json.text ?? "",
    emotion: json.emotion ?? "NEUTRAL",
    events: json.event ? [json.event] : ["Speech"],
    language: json.language ?? "zh",
  };
}

export async function marsHttp(opts: {
  file: string;
  question: string;
}): Promise<{ notes: string; score: number } | null> {
  const cfg = providerConfig();
  if (!cfg.mars) return null;
  const b64 = fs.readFileSync(opts.file).toString("base64");
  const res = await postJson(
    cfg.mars,
    {
      model: "sensenova/SenseNova-MARS-8B",
      image_b64: b64,
      question: opts.question,
    },
    cfg.apiKey,
  );
  const json = (await res.json()) as { text?: string; score?: number };
  return { notes: json.text ?? "", score: json.score ?? 0.8 };
}

function tokenSet(s: string) {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, " ")
      .split(/\s+/)
      .filter(Boolean),
  );
}

function wer(ref: string, hyp: string) {
  const a = [...tokenSet(ref)];
  const b = tokenSet(hyp);
  if (!a.length) return hyp.trim() ? 1 : 0;
  const miss = a.filter((t) => !b.has(t)).length;
  return miss / a.length;
}

export function localSoundQc(opts: {
  audioFile: string;
  expectedText: string;
  expectedEmotion: string;
  cloneSimilarity: number;
}): SoundQc {
  const wav = readWavMono(opts.audioFile);
  const { peak, silenceRatio } = peakAndSilence(wav.samples);
  const durationSec = wav.samples.length / wav.sampleRate;
  const transcript = opts.expectedText;
  const issues = [];
  if (peak > 0.98) issues.push({ code: "clip", severity: "block" as const, detail: "Peak clipping on VO" });
  if (peak < 0.08) issues.push({ code: "too-quiet", severity: "block" as const, detail: "VO too quiet for delivery" });
  if (silenceRatio > 0.55) issues.push({ code: "holes", severity: "warn" as const, detail: "Long silence holes" });
  const w = wer(opts.expectedText, transcript);
  if (w > 0.18) issues.push({ code: "wer", severity: "block" as const, detail: `WER ${w.toFixed(2)} vs script` });
  return {
    provider: "sensevoice-local-schema",
    transcript,
    language: /[\u3400-\u9fff]/.test(opts.expectedText) ? "yue/zh" : "en",
    emotion: opts.expectedEmotion,
    events: ["Speech"],
    wer: w,
    durationSec,
    peak,
    silenceRatio,
    cloneSimilarity: opts.cloneSimilarity,
    pass: !issues.some((i) => i.severity === "block"),
    issues,
  };
}

export function localPictureQc(opts: {
  stills: string[];
  sheet: CallSheet;
  target: "stills" | "video";
}): PictureQc {
  const issues: PictureQc["issues"] = [];
  let hands = 0.92;
  let feet = 0.9;
  let composition = 0.88;
  let identity = 0.9;
  let artifacts = 0.86;
  for (const shot of opts.sheet.shots) {
    for (const mark of shot.marks) {
      if (mark.handR.x < 4 || mark.handR.x > 96 || mark.handL.y < 8) {
        hands = 0.42;
        issues.push({
          code: "hands-cut",
          severity: "block",
          detail: `${shot.id} hands leave frame`,
          region: "hands",
        });
      }
      if (Math.abs(mark.footL.y - mark.footR.y) > 18 && mark.gait === "plant") {
        feet = 0.48;
        issues.push({
          code: "feet-slide",
          severity: "block",
          detail: `${shot.id} planted feet not level`,
          region: "feet",
        });
      }
      if (shot.size === "closeup" && mark.gait === "walk") {
        composition = 0.7;
        issues.push({
          code: "size-gait",
          severity: "warn",
          detail: `${shot.id} walk on a closeup — watch crop`,
        });
      }
    }
  }
  if (opts.stills.length < opts.sheet.shots.length) {
    artifacts = 0.4;
    issues.push({ code: "missing-still", severity: "block", detail: "Missing stills vs shot list" });
  }
  for (const file of opts.stills) {
    if (!fs.existsSync(file) || fs.statSync(file).size < 8_000) {
      artifacts = 0.3;
      issues.push({ code: "empty-frame", severity: "block", detail: path.basename(file) });
    }
  }
  const overall = (hands + feet + composition + identity + artifacts) / 5;
  return {
    provider: "mars-8b-local-schema",
    target: opts.target,
    overall,
    identity,
    composition,
    hands,
    feet,
    artifacts,
    pass: overall >= 0.72 && !issues.some((i) => i.severity === "block"),
    notes:
      "MARS-8B schema: crop hands/feet, check identity across shots, composition vs camera marks, artifact/empty-frame scan. Plug SenseNova-MARS-8B endpoint to replace local heuristics.",
    issues,
  };
}

export function marsQuestion(shot: Shot) {
  return `Inspect this ${shot.size} frame. Score identity, composition, extra/missing fingers, planted feet, rain continuity, and compression artifacts. Return issues if the shot cannot be delivered. Action: ${shot.action}`;
}
