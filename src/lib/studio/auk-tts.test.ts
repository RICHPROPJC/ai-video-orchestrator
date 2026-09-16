import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { writeWav } from "./audio";
import {
  assertAukTtsPin,
  aukTtsUrl,
  ensureAudibleShotWav,
  genSecondsForText,
  oneAukTake,
  runAukTts,
  wavIsAudible,
} from "./auk-tts";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

test("aukTtsUrl rejects CosyVoice :9880 and empty", () => {
  assert.throws(() => aukTtsUrl(""), /empty/);
  assert.throws(() => aukTtsUrl("http://127.0.0.1:9880"), /CosyVoice/);
  assert.equal(aukTtsUrl("http://127.0.0.1:9882"), "http://127.0.0.1:9882/tts");
  assert.equal(aukTtsUrl("http://127.0.0.1:9882/tts"), "http://127.0.0.1:9882/tts");
});

test("oneAukTake refuses emotion markup that would be read aloud", () => {
  assert.equal(oneAukTake("行啦"), "行啦");
  assert.throws(() => oneAukTake("[sad]行啦"), /emotion/);
  assert.throws(() => oneAukTake("(whisper)行啦"), /emotion/);
});

test("assertAukTtsPin rejects CosyVoice model", () => {
  assert.throws(
    () => assertAukTtsPin({ endpoint: "http://127.0.0.1:9882", model: "Fun-CosyVoice3-0.5B" }),
    /CosyVoice/,
  );
});

test("wavIsAudible: silence vs tone", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-auk-"));
  const silent = path.join(dir, "s.wav");
  const loud = path.join(dir, "l.wav");
  writeWav(silent, new Float32Array(22050), 22050);
  writeWav(loud, Float32Array.from({ length: 22050 }, (_, i) => Math.sin((i / 22050) * Math.PI * 2 * 220) * 0.4), 22050);
  assert.equal(wavIsAudible(silent), false);
  assert.equal(wavIsAudible(loud), true);
});

test("genSecondsForText is always > 0", () => {
  assert.ok(genSecondsForText("測") > 0);
  assert.ok(genSecondsForText("測試聲軌") >= 1.5);
});

test("runAukTts POST /tts form + seed + gen_seconds>0; silent body fails", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-auk-post-"));
  const ref = path.join(dir, "ref.wav");
  const out = path.join(dir, "out.wav");
  writeWav(ref, Float32Array.from({ length: 8000 }, (_, i) => Math.sin(i / 40) * 0.3), 22050);
  const silent = path.join(dir, "silent-body.wav");
  writeWav(silent, new Float32Array(8000), 22050);
  let posted: { url: string; gen?: string; seed?: string; text?: string } = { url: "" };
  await assert.rejects(
    () =>
      runAukTts({
        text: "測試",
        outFile: out,
        genSeconds: 2,
        promptWav: ref,
        seed: 20260914,
        fetchImpl: async (url, init) => {
          const body = init?.body as FormData;
          posted = {
            url: String(url),
            gen: String(body.get("gen_seconds")),
            seed: String(body.get("seed")),
            text: String(body.get("tts_text")),
          };
          return new Response(fs.readFileSync(silent), { status: 200, headers: { "Content-Type": "audio/wav" } });
        },
      }),
    /silent/,
  );
  assert.equal(posted.url, "http://127.0.0.1:9882/tts");
  assert.equal(posted.gen, "2");
  assert.equal(posted.seed, "20260914");
  assert.equal(posted.text, "測試");
});

test("runAukTts poison seed 20260911 throws before fetch", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-auk-seed-"));
  const ref = path.join(dir, "ref.wav");
  writeWav(ref, Float32Array.from({ length: 1000 }, () => 0.2), 22050);
  await assert.rejects(
    () =>
      runAukTts({
        text: "x",
        outFile: path.join(dir, "o.wav"),
        genSeconds: 2,
        promptWav: ref,
        seed: 20260911,
        fetchImpl: async () => {
          throw new Error("fetch must not run");
        },
      }),
    /poison/,
  );
});

test("runAukTts genSeconds 0 throws", async () => {
  await assert.rejects(
    () => runAukTts({ text: "x", outFile: "/tmp/x.wav", genSeconds: 0, promptWav: "/tmp/no.wav" }),
    /gen_seconds/,
  );
});

test("ensureAudibleShotWav copies loud src; synthesizes when silent+text", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-auk-ens-"));
  const loud = path.join(dir, "in.wav");
  const dst = path.join(dir, "out.wav");
  writeWav(loud, Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 20) * 0.5), 22050);
  assert.equal(await ensureAudibleShotWav({ src: loud, dst, text: "忽略" }), "copied");
  assert.equal(wavIsAudible(dst), true);

  const silent = path.join(dir, "silent.wav");
  writeWav(silent, new Float32Array(4000), 22050);
  const made = path.join(dir, "made.wav");
  let called = 0;
  const synth = async (opts: { outFile: string }) => {
    called += 1;
    writeWav(opts.outFile, Float32Array.from({ length: 4000 }, (_, i) => Math.sin(i / 20) * 0.5), 22050);
    return { provider: "auk-9882" as const, genSeconds: 2, bytes: 100, peak: 0.5 };
  };
  assert.equal(await ensureAudibleShotWav({ src: silent, dst: made, text: "重生", synthesize: synth as never }), "auk");
  assert.equal(called, 1);
  assert.equal(wavIsAudible(made), true);
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
