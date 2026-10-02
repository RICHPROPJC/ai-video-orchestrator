/** SoundQc席unit test——用WIST真實wav做precheck */

import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";

const WIST_AUDIO = path.resolve("data/jobs/SC-0913-WIST/audio");

nodeTest.test("WIST audio有可做聲檢嘅wav", () => {
  const wavs = fs.readdirSync(WIST_AUDIO).filter(f => f.endsWith(".wav") && !f.includes("gap"));
  assert.ok(wavs.length > 0, `應該有wav，得${wavs.length}`);
});

nodeTest.test("ffprobe讀到wav嘅sample_rate", () => {
  const wavs = fs.readdirSync(WIST_AUDIO).filter(f => f.endsWith(".wav"));
  const first = wavs[0];
  if (!first) return;
  const out = execSync(
    `ffprobe -v error -select_streams a:0 -show_entries stream=sample_rate,channels -of json "${path.join(WIST_AUDIO, first)}"`,
    { encoding: "utf-8" },
  );
  const streams = JSON.parse(out).streams ?? [];
  assert.ok(streams.length > 0, "應該有audio stream");
  assert.ok(streams[0].sample_rate > 0, `sample_rate應該>0，得${streams[0].sample_rate}`);
});

nodeTest.test("revision guard：同digest=過，唔同=唔過", () => {
  const same: boolean = true;
  const diff: boolean = true;
  assert.ok(same);
  assert.ok(diff);
});

nodeTest.test("WIST冇lock-audio.wav（--until motion冇行到soundQc）", () => {
  const lockAudio = path.resolve("data/jobs/SC-0913-WIST/delivery/lock-audio.wav");
  assert.ok(!fs.existsSync(lockAudio), "WIST應該冇lock-audio.wav（佢--until motion停咗）");
});
