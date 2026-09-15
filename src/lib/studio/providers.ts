import fs from "node:fs";
import path from "node:path";
import { peakAndSilence, readWavMono } from "./audio";
import { assertAukTtsPin, genSecondsForText, runAukTts } from "./auk-tts";
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

export async function ttsHttp(opts: {
  text: string;
  reference?: string;
  outFile: string;
  seconds?: number;
  synthesize?: typeof runAukTts;
}) {
  const cfg = loadConfig();
  if (!cfg.tts.endpoint.trim()) throw new Error("tts.endpoint unconfigured — AuK http://127.0.0.1:9882");
  assertAukTtsPin(cfg.tts);
  const synth = opts.synthesize ?? runAukTts;
  await synth({
    text: opts.text,
    outFile: opts.outFile,
    genSeconds: opts.seconds ?? genSecondsForText(opts.text),
    promptWav: opts.reference,
  });
  return "auk-9882" as const;
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

function levenshtein(a: string[], b: string[]): number {
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, (_, i) => {
    const row = new Array<number>(n + 1);
    row[0] = i;
    return row;
  });
  for (let j = 0; j <= n; j += 1) dp[0]![j] = j;
  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i]![j] = Math.min(dp[i - 1]![j]! + 1, dp[i]![j - 1]! + 1, dp[i - 1]![j - 1]! + cost);
    }
  }
  return dp[m]![n]!;
}

/** CJK = character edit rate; EN = word miss rate. Service down is unconfigured, not this. */
export function scriptEditRate(ref: string, hyp: string): { rate: number; code: "cer" | "wer" } {
  const chars = [...ref.replace(/\s+/g, "")];
  const cjk = chars.filter((ch) => /\p{Script=Han}/u.test(ch)).length;
  if (chars.length && cjk / chars.length >= 0.5) {
    const b = [...hyp.replace(/\s+/g, "")];
    const rate = chars.length ? levenshtein(chars, b) / chars.length : b.length ? 1 : 0;
    return { rate, code: "cer" };
  }
  return { rate: wer(ref, hyp), code: "wer" };
}

/** A3 fail-loud: an ear is a provider. No endpoint = stage FAIL "unconfigured",
 *  never a schema stand-in. */
export function soundQcUnconfigured(reason = "soundQc.endpoint not set — no ASR ear on this stage"): SoundQc {
  return {
    provider: "unconfigured",
    transcript: "",
    language: "unknown",
    emotion: "unknown",
    events: [],
    wer: 1,
    durationSec: 0,
    peak: 0,
    silenceRatio: 0,
    cloneSimilarity: 0,
    pass: false,
    issues: [{ code: "unconfigured", severity: "block", detail: reason }],
  };
}

/** Real wav measurements only — clip / level / holes. No transcript, no WER,
 *  no pass verdict: the ear is senseVoiceHttp or the stage fails loud. */
export function wavPrecheck(opts: { audioFile: string }): {
  durationSec: number;
  peak: number;
  silenceRatio: number;
  issues: SoundQc["issues"];
} {
  const wav = readWavMono(opts.audioFile);
  const { peak, silenceRatio } = peakAndSilence(wav.samples);
  const durationSec = wav.samples.length / wav.sampleRate;
  const issues: SoundQc["issues"] = [];
  if (peak > 0.98) issues.push({ code: "clip", severity: "block" as const, detail: "Peak clipping on VO" });
  if (peak < 0.08) issues.push({ code: "too-quiet", severity: "block" as const, detail: "VO too quiet for delivery" });
  if (silenceRatio > 0.55) issues.push({ code: "holes", severity: "warn" as const, detail: "Long silence holes" });
  return { durationSec, peak, silenceRatio, issues };
}

/** SenseVoice HTTP transcript → full SoundQc verdict against the script. */
export function soundQcFromRemote(opts: {
  remote: NonNullable<Awaited<ReturnType<typeof senseVoiceHttp>>>;
  expectedText: string;
  expectedEmotion: string;
  cloneSimilarity: number;
  wav: ReturnType<typeof wavPrecheck>;
}): SoundQc {
  const issues = [...opts.wav.issues];
  const { rate, code } = scriptEditRate(opts.expectedText, opts.remote.transcript ?? "");
  if (rate > 0.18) {
    issues.push({
      code,
      severity: "block" as const,
      detail: `${code.toUpperCase()} ${rate.toFixed(2)} vs script`,
    });
  }
  return {
    provider: opts.remote.provider ?? "sensevoice-http",
    transcript: opts.remote.transcript ?? "",
    language: opts.remote.language ?? (/[㐀-鿿]/.test(opts.expectedText) ? "yue/zh" : "en"),
    emotion: opts.remote.emotion ?? opts.expectedEmotion,
    events: opts.remote.events ?? ["Speech"],
    wer: rate,
    durationSec: opts.wav.durationSec,
    peak: opts.wav.peak,
    silenceRatio: opts.wav.silenceRatio,
    cloneSimilarity: opts.cloneSimilarity,
    pass: !issues.some((i) => i.severity === "block"),
    issues,
  };
}

/** A3: OCR is a provider slot — empty endpoint fails loud, no fake pass. */
export async function ocrHttp(opts: { imageFile: string }): Promise<{ text: string }> {
  const cfg = loadConfig();
  if (!cfg.ocr.endpoint.trim()) throw new Error("ocr.endpoint unconfigured — no OCR provider");
  const b64 = fs.readFileSync(opts.imageFile).toString("base64");
  const res = await postJson(cfg.ocr.endpoint, { image_b64: b64 }, apiKey());
  const json = (await res.json()) as { text?: string };
  return { text: json.text ?? "" };
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
  const video = opts.target === "video";
  return {
    // A3: the plan-geometry pre-check never wears a MARS name — photo-qc MARS is the eye
    provider: "mark-geometry",
    target: opts.target,
    overall,
    identity,
    composition,
    hands,
    feet,
    artifacts,
    pass: video ? false : overall >= 0.72 && !issues.some((i) => i.severity === "block"),
    notes: video
      ? "mark-geometry pre-check (marks/crop/feet). The delivery gate is blind pictureQc video QC per frame."
      : "plan-geometry pre-check (marks/crop/feet). The delivery gate is blind pictureQc photo QC per still.",
    issues,
  };
}
