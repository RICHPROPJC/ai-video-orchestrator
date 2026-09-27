import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { writeWav } from "./audio";
import type { RunAukTtsOpts } from "./auk-tts";
import { plugShotWavs } from "./shot-wav-plug";
import type { Shot } from "./types";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function shot(id: string, dialogue: string): Shot {
  return {
    id,
    index: 0,
    heading: "1",
    size: "medium",
    location: "stage",
    action: "test",
    dialogue,
    durationSec: 2,
    camera: { pos: { x: 0, y: -4, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.4 }, lensMm: 35 },
    marks: [],
    stillPrompt: "",
    motionPrompt: "",
  };
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "shot-wav-plug-"));
}

function loudWav(file: string) {
  writeWav(file, Float32Array.from({ length: 22050 }, (_, i) => Math.sin((i / 22050) * Math.PI * 2 * 220) * 0.4), 22050);
}

test("given wavDir: audible SHxx.wav is copied, no synthesis", async () => {
  const dir = tmp();
  const wavDir = path.join(dir, "plug");
  fs.mkdirSync(wavDir);
  loudWav(path.join(wavDir, "SH01.wav"));
  const audioDir = path.join(dir, "audio");
  fs.mkdirSync(audioDir);
  const calls: RunAukTtsOpts[] = [];

  const out = await plugShotWavs({
    boards: [shot("SH01", "唔使出聲")],
    wavDir,
    audioDir,
    synthesize: async (o) => {
      calls.push(o);
    },
  });

  assert.deepEqual(out, [{ shotId: "SH01", file: path.join(audioDir, "SH01.wav"), source: "copied", text: "唔使出聲" }]);
  assert.equal(calls.length, 0);
  assert.ok(fs.existsSync(path.join(audioDir, "SH01.wav")));
});

test("no wavDir: AuK speaks the continuity dialogue, cloneRef reaches the take", async () => {
  const dir = tmp();
  const audioDir = path.join(dir, "audio");
  fs.mkdirSync(audioDir);
  const calls: RunAukTtsOpts[] = [];

  const out = await plugShotWavs({
    boards: [shot("SH02", "阿聲開咪。")],
    audioDir,
    cloneRef: path.join(dir, "clone-ref.wav"),
    synthesize: async (o) => {
      calls.push(o);
      writeWav(o.outFile, Float32Array.from({ length: 22050 }, (_, i) => Math.sin(i / 30) * 0.3), 22050);
    },
  });

  assert.equal(out[0]!.source, "auk");
  assert.equal(out[0]!.text, "阿聲開咪。");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.promptWav, path.join(dir, "clone-ref.wav"));
  assert.match(calls[0]!.text, /阿聲開咪/);
  assert.ok(fs.existsSync(path.join(audioDir, "SH02.wav")));
});

test("fail loud: --wav-dir that lacks the shot file still stops", async () => {
  const dir = tmp();
  const wavDir = path.join(dir, "plug");
  fs.mkdirSync(wavDir);
  const audioDir = path.join(dir, "audio");
  fs.mkdirSync(audioDir);

  await assert.rejects(
    () => plugShotWavs({ boards: [shot("SH03", "")], wavDir, audioDir, synthesize: async () => undefined }),
    /--wav-dir 缺 SH03\.wav/,
  );
});

test("picture beat with no dialogue writes silence and does not call AuK", async () => {
  const dir = tmp();
  const audioDir = path.join(dir, "audio");
  const calls: RunAukTtsOpts[] = [];
  const out = await plugShotWavs({
    boards: [shot("SH04", "   ")],
    audioDir,
    synthesize: async (o) => {
      calls.push(o);
    },
  });
  assert.equal(out[0]!.source, "silent");
  assert.equal(out[0]!.text, "");
  assert.equal(calls.length, 0);
  assert.ok(fs.statSync(path.join(audioDir, "SH04.wav")).size > 44);
});

if (bareBun) {
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}

// ── V2c（PLAN-v2 0928）§8：take 綁 utterance 文字行為鎖 ──────────────────────

test("V2c: take 重用綁文字——同文唔重讀，改文重新 synth", async () => {
  const dir = tmp();
  const audioDir = path.join(dir, "audio");
  const { plugVoiceEvents } = await import("./shot-wav-plug");
  const calls: string[] = [];
  const synthesize = async (o: { text?: string }) => {
    calls.push(o.text ?? "");
    loudWav(path.join(audioDir, "events", "SC01.B01.wav.tmp"));
    // ensureAudibleShotWav 會由 synth 結果兜——直接寫 audible 檔去 dst 嘅責任
    // 喺 ensure；呢度模擬一個可讀 take：寫落 ensure 期望嘅 dst 之前唔得，改為
    // 令 ensure 內部 re-check 通過（寫 880Hz）。
  };
  const boards = [{ id: "SH01", durationSec: 3 } as unknown as Shot];
  const ev = (text: string) => [{ beatId: "SC01.B01", text, speaker: "阿文", startSec: 0, endSec: 3 }];
  // 第一次：take 生成（mock 寫 audible wav 落 dst）
  const synthImpl = async (o: RunAukTtsOpts) => {
    calls.push(o.text ?? "");
    // ensureAudibleShotWav 收 synth 結果後自己驗 audible——模擬佢成功路：直接寫檔
    fs.mkdirSync(path.join(audioDir, "events"), { recursive: true });
    loudWav(path.join(audioDir, "events", "SC01.B01.wav"));
  };
  await plugVoiceEvents({ boards, events: ev("你好"), audioDir, synthesize: synthImpl as unknown as (o: RunAukTtsOpts) => Promise<unknown> });
  assert.equal(calls.length, 1, "第一次生成");
  // 第二次同文：唔准重新 synth（take＋sidecar 都在）
  await plugVoiceEvents({ boards, events: ev("你好"), audioDir, synthesize: synthImpl as unknown as (o: RunAukTtsOpts) => Promise<unknown> });
  assert.equal(calls.length, 1, "同文重用 take");
  // 改文：重新 synth（新 take 唔會舌聲）
  await plugVoiceEvents({ boards, events: ev("你好呀"), audioDir, synthesize: synthImpl as unknown as (o: RunAukTtsOpts) => Promise<unknown> });
  assert.equal(calls.length, 2, "改文重新生成");
  void synthesize;
});
