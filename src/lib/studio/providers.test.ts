import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { loadConfig } from "./config";
import { ocrHttp, scriptEditRate, soundQcFromRemote, soundQcUnconfigured, ttsHttp } from "./providers";

const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const WAV = { durationSec: 2.4, peak: 0.5, silenceRatio: 0.1, issues: [] as never[] };

test("empty soundQc.endpoint = FAIL unconfigured, pass:false", () => {
  const s = soundQcUnconfigured();
  assert.equal(s.pass, false);
  assert.equal(s.provider, "unconfigured");
  assert.ok(s.issues.some((i) => i.code === "unconfigured" && i.severity === "block"));
});

test("unreachable ear also fails loud with the endpoint named", () => {
  const s = soundQcUnconfigured("sensevoice http://127.0.0.1:9881 unreachable or unparseable");
  assert.equal(s.pass, false);
  assert.ok(s.issues[0]!.detail.includes("9881"));
});

test("config pins soundQc.endpoint to :9881", () => {
  const cfg = loadConfig();
  assert.equal(cfg.soundQc.endpoint, "http://127.0.0.1:9881");
  const raw = JSON.parse(fs.readFileSync(path.resolve("slatecrew.config.json"), "utf8")) as {
    soundQc: { endpoint: string };
  };
  assert.equal(raw.soundQc.endpoint, "http://127.0.0.1:9881");
});

test("ocr slot exists in config and defaults empty", () => {
  const cfg = loadConfig();
  assert.equal(typeof cfg.ocr.endpoint, "string");
  assert.equal(cfg.ocr.endpoint, ""); // pinned empty until a real OCR provider lands
});

test("ocrHttp with empty endpoint throws unconfigured — no fake pass", async () => {
  await assert.rejects(() => ocrHttp({ imageFile: "x.png" }), /unconfigured/);
});

test("soundQcFromRemote: matching SenseVoice transcript is a real verdict", () => {
  const s = soundQcFromRemote({
    remote: { provider: "sensevoice-http", transcript: "今日天氣好", emotion: "NEUTRAL", events: ["Speech"], language: "zh" },
    expectedText: "今日天氣好",
    expectedEmotion: "NEUTRAL",
    cloneSimilarity: 1,
    wav: WAV,
  });
  assert.equal(s.pass, true);
  assert.equal(s.provider, "sensevoice-http");
  assert.equal(s.wer, 0);
});

test("soundQcFromRemote: CJK char edit + clipping block the delivery", () => {
  const s = soundQcFromRemote({
    remote: { transcript: "完全唔同嘅句子", emotion: "NEUTRAL" },
    expectedText: "今日天氣好",
    expectedEmotion: "NEUTRAL",
    cloneSimilarity: 1,
    wav: { durationSec: 1, peak: 0.99, silenceRatio: 0.1, issues: [{ code: "clip", severity: "block", detail: "Peak clipping on VO" }] },
  });
  assert.equal(s.pass, false);
  assert.ok(s.issues.some((i) => i.code === "cer"));
  assert.ok(s.issues.some((i) => i.code === "clip"));
});

test("scriptEditRate: CJK is char edit, EN is word miss", () => {
  assert.equal(scriptEditRate("今日天氣好", "今日天氣好").code, "cer");
  assert.equal(scriptEditRate("今日天氣好", "今日天氣好").rate, 0);
  assert.ok(scriptEditRate("今日天氣好", "今日天氣").rate > 0);
  assert.equal(scriptEditRate("hello world", "hello world").code, "wer");
  assert.ok(scriptEditRate("hello world", "hello there").rate > 0.18);
});

test("config pins tts to AuK :9882, not CosyVoice", () => {
  const cfg = loadConfig();
  assert.equal(cfg.tts.endpoint, "http://127.0.0.1:9882");
  assert.equal(cfg.tts.model, "auk-flash-1.5B");
  assert.doesNotMatch(`${cfg.tts.endpoint} ${cfg.tts.model}`, /cosyvoice|9880/i);
});

test("ttsHttp uses AuK adapter, never CosyVoice skip", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-auk-tts-"));
  const outFile = path.join(dir, "o.wav");
  let called = 0;
  const out = await ttsHttp({
    text: "測",
    outFile,
    synthesize: async (opts) => {
      called += 1;
      fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
      fs.writeFileSync(opts.outFile, "x");
      return { provider: "auk-9882" as const, genSeconds: 2, bytes: 1, peak: 0.5 };
    },
  });
  assert.equal(out, "auk-9882");
  assert.equal(called, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("tripwire: no *-local-schema provider id anywhere in studio src", () => {
  const dir = path.resolve("src/lib/studio");
  const offenders: string[] = [];
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
    if (fs.readFileSync(path.join(dir, f), "utf8").includes("local-schema")) offenders.push(f);
  }
  assert.deepEqual(offenders, []);
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
