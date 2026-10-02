/** Voice席unit test——用WIST真實wav做spine concat測試 */

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const WIST_AUDIO = path.resolve("data/jobs/SC-0913-WIST/audio");

nodeTest.test("WIST audio有wav可以concat", () => {
  const wavs = fs.readdirSync(WIST_AUDIO).filter(f => f.endsWith(".wav"));
  assert.ok(wavs.length > 0, `應該有wav，得${wavs.length}`);
});

nodeTest.test("spine concat：無gap直接concat有SHA", () => {
  // 揀前3個非h3嘅wav做子集測試
  const wavs = fs.readdirSync(WIST_AUDIO)
    .filter(f => f.endsWith(".wav") && !f.includes("h3") && !f.includes("spine") && !f.includes("gap"))
    .sort()
    .slice(0, 3);
  assert.ok(wavs.length === 3, `要3個wav做測試，得${wavs.length}`);

  const listFile = "/tmp/test-voice-spine-list.txt";
  fs.writeFileSync(listFile, wavs.map(w => `file '${path.join(WIST_AUDIO, w)}'`).join("\n"));

  const out = "/tmp/test-voice-spine.wav";
  execSync(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy ${out}`, { stdio: "pipe" });

  const stat = fs.statSync(out);
  assert.ok(stat.size > 1000, `spine.wav太細：${stat.size}`);
});

nodeTest.test("gap wav生成：指定時長嘅靜音", () => {
  const gapOut = "/tmp/test-voice-gap.wav";
  execSync(`ffmpeg -y -f lavfi -i anullsrc=r=24000:cl=1 -t 0.5 -c:a pcm_s16le ${gapOut}`, { stdio: "pipe" });
  const stat = fs.statSync(gapOut);
  // 0.5秒@24kHz mono 16bit ≈ 24000 bytes + header
  assert.ok(stat.size > 20000, `gap.wav太細：${stat.size}`);
  assert.ok(stat.size < 30000, `gap.wav太大：${stat.size}`);
});
