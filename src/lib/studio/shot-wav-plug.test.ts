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

test("fail loud: plug wav missing from --wav-dir, or no wav and no dialogue", async () => {
  const dir = tmp();
  const wavDir = path.join(dir, "plug");
  fs.mkdirSync(wavDir);
  const audioDir = path.join(dir, "audio");
  fs.mkdirSync(audioDir);

  await assert.rejects(
    () => plugShotWavs({ boards: [shot("SH03", "")], wavDir, audioDir, synthesize: async () => undefined }),
    /--wav-dir 缺 SH03\.wav/,
  );
  await assert.rejects(
    () => plugShotWavs({ boards: [shot("SH04", "   ")], audioDir, synthesize: async () => undefined }),
    /no wav and empty dialogue/,
  );
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
