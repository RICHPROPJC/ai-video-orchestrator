import fs from "node:fs";
import { spawn } from "node:child_process";

export function writeWav(file: string, samples: Float32Array, sampleRate = 22050) {
  const dataSize = samples.length * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write("RIFF", 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write("WAVE", 8);
  buf.write("fmt ", 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples.length; i += 1) {
    const s = Math.max(-1, Math.min(1, samples[i] ?? 0));
    buf.writeInt16LE(Math.round(s * 32767), 44 + i * 2);
  }
  fs.writeFileSync(file, buf);
}

export function readWavMono(file: string): { sampleRate: number; samples: Float32Array } {
  const buf = fs.readFileSync(file);
  const sampleRate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  const channels = buf.readUInt16LE(22);
  const dataStart = 44;
  const samples = new Float32Array(Math.floor((buf.length - dataStart) / (bits / 8) / channels));
  for (let i = 0; i < samples.length; i += 1) {
    const offset = dataStart + i * channels * (bits / 8);
    samples[i] = bits === 16 ? buf.readInt16LE(offset) / 32768 : buf.readInt8(offset) / 128;
  }
  return { sampleRate, samples };
}

export function estimatePitchHz(samples: Float32Array, sampleRate: number) {
  const minLag = Math.floor(sampleRate / 420);
  const maxLag = Math.floor(sampleRate / 70);
  let bestLag = minLag;
  let best = 0;
  for (let lag = minLag; lag < maxLag; lag += 1) {
    let sum = 0;
    for (let i = 0; i < samples.length - lag; i += 80) {
      sum += (samples[i] ?? 0) * (samples[i + lag] ?? 0);
    }
    if (sum > best) {
      best = sum;
      bestLag = lag;
    }
  }
  return sampleRate / bestLag;
}

function syllableUnits(text: string) {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  const units: string[] = [];
  let buf = "";
  for (const ch of chars) {
    if (/[\u3400-\u9fff]/.test(ch)) {
      if (buf) units.push(buf);
      buf = "";
      units.push(ch);
    } else if (/\s|[，。！？,.!?]/.test(ch)) {
      if (buf) units.push(buf);
      buf = "";
      units.push(" ");
    } else {
      buf += ch;
    }
  }
  if (buf) units.push(buf);
  return units.filter((u) => u.length);
}

export function synthesizeVoice(opts: {
  text: string;
  seconds: number;
  pitchHz: number;
  rain: boolean;
}): Float32Array {
  const sr = 22050;
  const n = Math.floor(sr * opts.seconds);
  const out = new Float32Array(n);
  const units = syllableUnits(opts.text);
  const unitDur = Math.max(0.12, (opts.seconds - 0.4) / Math.max(1, units.length));
  let t0 = 0.12;
  for (let u = 0; u < units.length; u += 1) {
    const token = units[u] ?? " ";
    const voiced = token.trim().length > 0;
    const dur = token === " " ? 0.08 : unitDur;
    const f0 = opts.pitchHz * (voiced ? 1 + 0.04 * Math.sin(u) : 0.5);
    const formants = voiced ? [f0 * 2.1, 920 + (u % 5) * 70, 2400] : [180, 400, 800];
    const start = Math.floor(t0 * sr);
    const end = Math.min(n, Math.floor((t0 + dur) * sr));
    for (let i = start; i < end; i += 1) {
      const t = i / sr;
      const local = (i - start) / Math.max(1, end - start);
      const env = Math.sin(Math.min(1, local) * Math.PI) ** 0.6 * (voiced ? 0.22 : 0.03);
      let s = 0;
      for (const f of formants) {
        s += Math.sin(2 * Math.PI * f * t) / formants.length;
      }
      const buzz = Math.sign(Math.sin(2 * Math.PI * f0 * t)) * 0.25;
      out[i] += (s * 0.75 + buzz * 0.25) * env;
    }
    t0 += dur;
  }
  for (let i = 0; i < n; i += 1) {
    const t = i / sr;
    const room = (Math.random() * 2 - 1) * 0.012;
    const rain = opts.rain ? (Math.random() ** 8) * 0.08 : 0;
    const bed = Math.sin(2 * Math.PI * 78 * t) * 0.01;
    out[i] = Math.max(-0.95, Math.min(0.95, (out[i] ?? 0) + room + rain + bed));
  }
  return out;
}

export function mixTo(target: Float32Array, add: Float32Array, gain = 1) {
  const n = Math.min(target.length, add.length);
  for (let i = 0; i < n; i += 1) {
    target[i] = Math.max(-1, Math.min(1, (target[i] ?? 0) + (add[i] ?? 0) * gain));
  }
}

export function peakAndSilence(samples: Float32Array) {
  let peak = 0;
  let silent = 0;
  for (const s of samples) {
    const a = Math.abs(s);
    if (a > peak) peak = a;
    if (a < 0.02) silent += 1;
  }
  return { peak, silenceRatio: silent / Math.max(1, samples.length) };
}

export function runCommand(cmd: string, args: string[], cwd?: string, extraEnv?: Record<string, string | undefined>) {
  return new Promise<{ code: number; stderr: string; stdout: string }>((resolve, reject) => {
    const env = extraEnv ? { ...process.env, ...extraEnv } : undefined;
    // extraEnv value undefined = delete the inherited var (e.g. strip DISPLAY for blender)
    if (env) for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    const child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}
