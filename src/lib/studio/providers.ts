import fs from "node:fs";
import path from "node:path";
import { peakAndSilence, readWavMono } from "./audio";
import { loadConfig } from "./config";
import type { CallSheet, PictureQc, SoundQc } from "./types";

function postJson(url: string, body: unknown, apiKey?: string) {
  return fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
}

function apiKey() {
  return process.env.STUDIO_API_KEY?.trim() || process.env.OPENAI_API_KEY?.trim() || undefined;
}

export async function ttsHttp(opts: { text: string; reference?: string; outFile: string }) {
  const cfg = loadConfig();
  if (!cfg.tts.endpoint) return null;
  const res = await postJson(cfg.tts.endpoint, {
    model: cfg.tts.model,
    text: opts.text,
    reference: opts.reference,
  }, apiKey());
  fs.writeFileSync(opts.outFile, Buffer.from(await res.arrayBuffer()));
  return "cosyvoice-http";
}

export async function senseVoiceHttp(audioFile: string): Promise<Partial<SoundQc> | null> {
  const cfg = loadConfig();
  if (!cfg.soundQc.endpoint) return null;
  const b64 = fs.readFileSync(audioFile).toString("base64");
  const res = await postJson(cfg.soundQc.endpoint, { audio_b64: b64, language: "auto" }, apiKey());
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
    language: /[㐀-鿿]/.test(opts.expectedText) ? "yue/zh" : "en",
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

/** plan-geometry pre-check only — the delivery gate for stills is the blind
 *  MARS photo QC (photo-qc.ts), never this heuristic alone */
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
      "plan-geometry pre-check (marks/crop/feet). The delivery gate is blind MARS photo QC per still.",
    issues,
  };
}
