import fs from "node:fs";
import path from "node:path";
import { peakAndSilence, readWavMono } from "./audio";
import { loadConfig } from "./config";

const POISON_SEED = 20260911;
const PEAK_FLOOR = 0.08;
const EMOTION_TAG =
  /\[(?:sad|happy|angry|whisper|shout|soft|loud|emotion)[^\]]*\]|\((?:sad|angry|whisper|soft|loud)\)|【[^】]{1,12}】|<emotion\b[^>]*>/i;

export function aukTtsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/$/, "");
  if (!base) throw new Error("tts.endpoint empty — set http://127.0.0.1:9882");
  if (/9880|cosyvoice/i.test(base)) throw new Error("CosyVoice :9880 is dead — use AuK :9882");
  return base.endsWith("/tts") ? base : `${base}/tts`;
}

/** `/tts` is verbatim clone. Emotion markup gets read aloud — refuse it. */
export function assertVerbatimTtsText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new Error("AuK /tts text empty");
  if (EMOTION_TAG.test(trimmed)) {
    throw new Error("AuK /tts is verbatim clone — do not stuff emotion tags (they get read aloud)");
  }
  return trimmed;
}

/** One shot = one take. Never split a line into N `/tts` calls and splice. */
export function oneAukTake(dialogue: string): string {
  return assertVerbatimTtsText(dialogue);
}

export function assertAukTtsPin(tts: { endpoint: string; model: string }): void {
  if (!tts.endpoint.trim()) throw new Error("tts.endpoint empty — AuK http://127.0.0.1:9882");
  if (/cosyvoice|fun-cosy|9880/i.test(`${tts.endpoint} ${tts.model}`)) {
    throw new Error("CosyVoice pin is a lie — tts.model auk-flash-1.5B, endpoint :9882");
  }
}

export function genSecondsForText(text: string): number {
  const n = [...text.replace(/\s+/g, "")].length;
  return Math.max(1.5, Math.min(12, n * 0.21));
}

export function wavIsAudible(file: string): boolean {
  const { samples } = readWavMono(file);
  return peakAndSilence(samples).peak >= PEAK_FLOOR;
}

export type RunAukTtsOpts = {
  text: string;
  outFile: string;
  genSeconds: number;
  promptWav?: string;
  seed?: number;
  fetchImpl?: typeof fetch;
};

export async function runAukTts(opts: RunAukTtsOpts): Promise<{ provider: "auk-9882"; genSeconds: number; bytes: number; peak: number }> {
  const cfg = loadConfig();
  assertAukTtsPin(cfg.tts);
  if (!(opts.genSeconds > 0)) throw new Error("gen_seconds must be > 0 (0 inherits prompt-wav length)");
  const promptWav = opts.promptWav ?? cfg.tts.promptWav;
  if (!promptWav || !fs.existsSync(promptWav)) throw new Error(`tts.promptWav missing: ${promptWav ?? ""}`);
  const seed = opts.seed ?? cfg.tts.seed;
  if (seed === POISON_SEED) throw new Error("seed 20260911 is poison");
  const text = oneAukTake(opts.text);
  const url = aukTtsUrl(cfg.tts.endpoint);
  const form = new FormData();
  form.append("tts_text", text);
  form.append("gen_seconds", String(opts.genSeconds));
  form.append("seed", String(seed));
  form.append("prompt_wav", new File([new Uint8Array(fs.readFileSync(promptWav))], "ref.wav", { type: "audio/wav" }));
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(url, { method: "POST", body: form, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`AuK /tts HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, buf);
  const { peak } = peakAndSilence(readWavMono(opts.outFile).samples);
  if (peak < PEAK_FLOOR) throw new Error(`AuK wrote silent wav peak=${peak.toFixed(4)} ${opts.outFile}`);
  return { provider: "auk-9882", genSeconds: opts.genSeconds, bytes: buf.length, peak };
}

export async function ensureAudibleShotWav(opts: {
  src?: string;
  dst: string;
  text: string;
  synthesize?: typeof runAukTts;
}): Promise<"copied" | "auk"> {
  if (opts.src && fs.existsSync(opts.src) && wavIsAudible(opts.src)) {
    if (path.resolve(opts.src) !== path.resolve(opts.dst)) fs.copyFileSync(opts.src, opts.dst);
    return "copied";
  }
  const text = opts.text.trim();
  if (!text) {
    if (!opts.src || !fs.existsSync(opts.src)) throw new Error(`no wav and empty dialogue for ${opts.dst}`);
    fs.copyFileSync(opts.src, opts.dst);
    return "copied";
  }
  const synth = opts.synthesize ?? runAukTts;
  await synth({ text, outFile: opts.dst, genSeconds: genSecondsForText(text) });
  return "auk";
}
