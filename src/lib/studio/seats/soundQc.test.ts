/** SoundQc 席單元測——mock SeatContext，驗 think→speak→speak 調用順序。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import type { SeatContext } from "../core/orchestrator";
import type { CallSheet, JobRecord, ProduceInput } from "../types";
import { soundQcUnconfigured } from "../providers";
import {
  bindSoundQcBag,
  unbindSoundQcBag,
  soundQcSeat,
  _resetSoundQcDepsForTest,
  _setSoundQcDepsForTest,
  type SoundQcBag,
} from "./soundQc";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function mockJob(id: string): JobRecord {
  return {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "running",
    input: { brief: "t", wavDir: "" } as ProduceInput,
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [], blockout: [], receipts: [] },
    providers: {
      stills: "u",
      motion: "h",
      tts: "AuK",
      senseVoice: "pending",
      mars: "m",
      blender: "b",
      lipSync: "none",
    },
  };
}

function mockCtx(jobId: string, calls: string[]): SeatContext {
  const job = mockJob(jobId);
  return {
    jobId,
    input: { brief: "t", wavDir: "" } as ProduceInput,
    job,
    speak: (agent, message, level = "info") => {
      calls.push(`speak:${agent}:${level}:${message.slice(0, 40)}`);
    },
    think: (agent) => {
      calls.push(`think:${agent}`);
    },
    artifacts: new Map(),
    receipts: [],
    repairRound: 0,
    maxRepairs: 3,
  };
}

function timedSheet(): CallSheet {
  return {
    title: "t",
    logline: "l",
    language: "zh-Hant",
    location: "x",
    timeOfDay: "night",
    weather: "clear",
    mood: "cold",
    durationSec: 3,
    aspect: "9:16",
    characters: [
      {
        id: "A",
        name: "A",
        role: "r",
        wardrobe: "coat",
        palette: ["#111", "#222", "#333"],
        voice: { pitchHz: 120, gender: "m" },
      },
    ],
    styleBible: { grade: "g", refs: [], stillModel: "s", motionModel: "m" },
    shots: [
      {
        id: "SH01",
        index: 0,
        heading: "1",
        size: "medium",
        location: "x",
        action: "a",
        dialogue: "今日天氣好",
        durationSec: 3,
        camera: { pos: { x: 0, y: 0, z: 1 }, lookAt: { x: 0, y: 0, z: 1 }, lensMm: 35 },
        marks: [],
        stillPrompt: "",
        motionPrompt: "",
      },
    ],
    voiceover: "今日天氣好",
  };
}

function makeBag(lockAudio: string): SoundQcBag {
  return { timed: timedSheet(), lockAudio };
}

test("soundQcSeat：think → speak intro → speak 結果；未配置 ear＝PARTIAL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soundqc-seat-"));
  const cwd = process.cwd();
  const jobId = "SC-TEST-SOUNDQC";
  const calls: string[] = [];
  const ctx = mockCtx(jobId, calls);
  const lockAudio = path.join(tmp, "lock-audio.wav");
  fs.writeFileSync(lockAudio, "fake-wav");

  process.chdir(tmp);
  _setSoundQcDepsForTest({
    loadConfig: () => ({ soundQc: { endpoint: "", model: "x" } }),
    patch: (job, partial) => Object.assign(job, partial),
    soundQcUnconfigured,
  });
  bindSoundQcBag(jobId, makeBag(lockAudio));

  try {
    const result = await soundQcSeat.run(ctx);
    assert.equal(result.status, "PARTIAL");
    assert.equal(result.stopped, false);
    assert.equal(calls[0], "think:soundQc");
    assert.ok(
      calls[1]?.startsWith("speak:soundQc:info:SenseVoice"),
      `expected SenseVoice intro after think, got ${calls[1]}`,
    );
    assert.ok(
      calls[2]?.startsWith("speak:soundQc:fail:Sound QC FAIL"),
      `expected FAIL speak third, got ${calls[2]}`,
    );
    assert.equal(calls.length, 3);
    assert.equal(ctx.job.progress, 82);
    assert.equal(ctx.job.soundQc?.pass, false);
    assert.equal(ctx.job.providers?.senseVoice, "SenseVoice FAIL (unconfigured)");
    assert.equal(result.artifacts.length, 1);
    assert.equal(result.artifacts[0]!.kind, "qc_report");
    assert.equal(result.receipts.length, 1);
    assert.ok(result.violations.length >= 1);
    assert.ok(fs.existsSync(path.join(tmp, "data", "jobs", jobId, "delivery", "sound-qc.json")));
  } finally {
    unbindSoundQcBag(jobId);
    _resetSoundQcDepsForTest();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("soundQcSeat：ear 通＋對稿 OK → PASSED＋speak pass", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soundqc-pass-"));
  const cwd = process.cwd();
  const jobId = "SC-TEST-SOUNDQC-PASS";
  const calls: string[] = [];
  const ctx = mockCtx(jobId, calls);
  const lockAudio = path.join(tmp, "lock-audio.wav");
  fs.writeFileSync(lockAudio, "fake-wav");

  process.chdir(tmp);
  _setSoundQcDepsForTest({
    loadConfig: () => ({ soundQc: { endpoint: "http://127.0.0.1:9881", model: "x" } }),
    wavPrecheck: () => ({ durationSec: 2, peak: 0.5, silenceRatio: 0.1, issues: [] }),
    senseVoiceHttp: async () => ({
      provider: "sensevoice-http",
      transcript: "今日天氣好",
      emotion: "NEUTRAL",
      events: ["Speech"],
      language: "zh",
    }),
    patch: (job, partial) => Object.assign(job, partial),
  });
  bindSoundQcBag(jobId, makeBag(lockAudio));

  try {
    const result = await soundQcSeat.run(ctx);
    assert.equal(result.status, "PASSED");
    assert.equal(result.stopped, false);
    assert.equal(calls[0], "think:soundQc");
    assert.ok(calls[1]?.startsWith("speak:soundQc:info:SenseVoice"));
    assert.ok(
      calls[2]?.startsWith("speak:soundQc:pass:Sound QC PASS"),
      `expected PASS speak, got ${calls[2]}`,
    );
    assert.equal(calls.length, 3);
    assert.equal(ctx.job.soundQc?.pass, true);
    assert.equal(ctx.job.providers?.senseVoice, "SenseVoice HTTP");
    assert.equal(result.violations.length, 0);
  } finally {
    unbindSoundQcBag(jobId);
    _resetSoundQcDepsForTest();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("soundQcSeat：wavPrecheck throw → speak fail + FAILED_TERMINAL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "soundqc-fail-"));
  const cwd = process.cwd();
  const jobId = "SC-TEST-SOUNDQC-FAIL";
  const calls: string[] = [];
  const ctx = mockCtx(jobId, calls);

  process.chdir(tmp);
  _setSoundQcDepsForTest({
    loadConfig: () => ({ soundQc: { endpoint: "http://127.0.0.1:9881", model: "x" } }),
    wavPrecheck: () => {
      throw new Error("wav boom");
    },
    patch: (job, partial) => Object.assign(job, partial),
  });
  bindSoundQcBag(jobId, makeBag(path.join(tmp, "missing.wav")));

  try {
    const result = await soundQcSeat.run(ctx);
    assert.equal(result.status, "FAILED_TERMINAL");
    assert.equal(result.stopped, true);
    assert.equal(calls[0], "think:soundQc");
    assert.ok(calls[1]?.startsWith("speak:soundQc:info:SenseVoice"));
    const fail = calls.find((c) => c.startsWith("speak:soundQc:fail:"));
    assert.ok(fail, `expected fail speak, got ${calls.join(" | ")}`);
    assert.ok(fail!.includes("wav boom"));
    assert.equal(result.violations[0]!.step, "soundQc");
  } finally {
    unbindSoundQcBag(jobId);
    _resetSoundQcDepsForTest();
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

if (bareBun) {
  (async () => {
    for (const c of cases) {
      await c.fn();
      console.log(`ok - ${c.name}`);
    }
  })().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
