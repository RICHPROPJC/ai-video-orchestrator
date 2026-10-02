/** Voice 席單元測——mock SeatContext，驗 think→speak 調用順序。 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import type { SeatContext } from "../core/orchestrator";
import type { CallSheet, JobRecord, ProduceInput } from "../types";
import {
  bindVoiceBag,
  unbindVoiceBag,
  voiceSeat,
  _resetVoiceDepsForTest,
  _setVoiceDepsForTest,
  type VoiceBag,
} from "./voice";

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
      tts: "wav plug",
      senseVoice: "s",
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
      calls.push(`speak:${agent}:${level}:${message.slice(0, 24)}`);
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

function stubSheet(): CallSheet {
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
    characters: [],
    styleBible: { grade: "g", refs: [], stillModel: "s", motionModel: "m" },
    shots: [],
    voiceover: "你好",
  };
}

function makeBag(tmp: string): VoiceBag {
  const audioDir = path.join(tmp, "audio");
  fs.mkdirSync(audioDir, { recursive: true });
  fs.mkdirSync(path.join(tmp, "delivery"), { recursive: true });
  const sh01 = path.join(audioDir, "SH01.wav");
  const h3 = path.join(audioDir, "SH01.h3.wav");
  fs.writeFileSync(sh01, "fake");
  fs.writeFileSync(h3, "fake");
  const spine = path.join(audioDir, "spine.wav");
  fs.writeFileSync(spine, "fake-spine");
  const sheet = stubSheet();
  return {
    plugged: [{ shotId: "SH01", file: sh01, source: "auk", text: "你好" }],
    locked: sheet,
    timed: sheet,
    cloneRef: undefined,
    spineWav: spine, // 已有 spine → 跳過 concat 支路
    audioDir,
    cutPlan: { gap_s: 0, shots: [{ id: "SH01", start_s: 0, end_s: 3, duration_s: 3, wav: sh01 }] },
    gapSec: 0,
    h3WavByShot: new Map([["SH01", h3]]),
  };
}

function installVoiceTestDeps(ffmpeg: (args: string[]) => Promise<void>): void {
  _setVoiceDepsForTest({
    ffmpeg,
    runCommand: async () => ({ code: 0, stdout: "{}", stderr: "" }),
    patch: (job, partial) => Object.assign(job, partial),
    upsertDoc: () => undefined as never,
  });
}

test("voiceSeat：think → speak 順序，PASSED 時無 fail speak", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-seat-"));
  const jobId = "SC-TEST-VOICE";
  const calls: string[] = [];
  const ctx = mockCtx(jobId, calls);
  const bag = makeBag(tmp);
  const ffmpegCalls: string[][] = [];

  installVoiceTestDeps(async (args) => {
    ffmpegCalls.push(args);
  });
  bindVoiceBag(jobId, bag);

  try {
    const result = await voiceSeat.run(ctx);
    assert.equal(result.status, "PASSED");
    assert.equal(result.stopped, false);
    assert.equal(calls[0], "think:voice");
    assert.ok(calls[1]?.startsWith("speak:voice:info:"), `expected speak after think, got ${calls[1]}`);
    assert.ok(
      calls[1]!.includes("AuK") || calls[1]!.includes("聲軌"),
      `speak message should mention AuK/plug: ${calls[1]}`,
    );
    // spine 已有 → 淨係 lock-audio concat 一次 ffmpeg
    assert.equal(ffmpegCalls.length, 1);
    assert.ok(ffmpegCalls[0]!.includes("concat"));
    assert.equal(ctx.job.progress, 76);
    assert.equal(ctx.job.outputs.voice, "audio/spine.wav");
    assert.ok(String(ctx.job.providers?.tts).includes("AuK"));
  } finally {
    unbindVoiceBag(jobId);
    _resetVoiceDepsForTest();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("voiceSeat：ffmpeg 失敗 → speak fail + FAILED_TERMINAL", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "voice-seat-fail-"));
  const jobId = "SC-TEST-VOICE-FAIL";
  const calls: string[] = [];
  const ctx = mockCtx(jobId, calls);
  const bag = makeBag(tmp);
  bag.spineWav = undefined; // 逼入 concat 支路

  installVoiceTestDeps(async () => {
    throw new Error("ffmpeg boom");
  });
  bindVoiceBag(jobId, bag);

  try {
    const result = await voiceSeat.run(ctx);
    assert.equal(result.status, "FAILED_TERMINAL");
    assert.equal(result.stopped, true);
    assert.equal(calls[0], "think:voice");
    assert.ok(calls[1]?.startsWith("speak:voice:info:"));
    const fail = calls.find((c) => c.startsWith("speak:voice:fail:"));
    assert.ok(fail, `expected fail speak, got ${calls.join(" | ")}`);
    assert.ok(fail!.includes("ffmpeg boom"));
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0]!.step, "voice");
  } finally {
    unbindVoiceBag(jobId);
    _resetVoiceDepsForTest();
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
