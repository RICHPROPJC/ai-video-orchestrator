#!/usr/bin/env tsx
import fs from "node:fs";
import path from "node:path";
import { genSecondsForText, runAukTts, wavIsAudible } from "./lib/studio/auk-tts";
import { writeWav } from "./lib/studio/audio";

async function main() {
  const job = path.resolve("data/jobs/SC-0915-LD0F");
  const outDir = path.join(job, "wav-plug");
  const cs = JSON.parse(fs.readFileSync(path.join(job, "callsheet.json"), "utf8")) as {
    shots: { id: string; dialogue?: string; durationSec: number }[];
  };
  fs.mkdirSync(outDir, { recursive: true });

  function softTone(sec: number, rate = 24000): Float32Array {
    const n = Math.max(1, Math.round(sec * rate));
    const out = new Float32Array(n);
    for (let i = 0; i < n; i++) out[i] = Math.sin((i / rate) * Math.PI * 2 * 180) * 0.12;
    return out;
  }

  let auk = 0;
  let tone = 0;
  let keep = 0;
  for (const shot of cs.shots) {
    const dst = path.join(outDir, `${shot.id}.wav`);
    if (fs.existsSync(dst) && wavIsAudible(dst)) {
      keep += 1;
      console.log(`KEEP ${shot.id}`);
      continue;
    }
    const text = (shot.dialogue || "").trim();
    if (text) {
      const gen = Math.max(genSecondsForText(text), Math.min(12, shot.durationSec * 0.85));
      await runAukTts({ text, outFile: dst, genSeconds: gen });
      auk += 1;
      console.log(`AUK  ${shot.id} ${gen.toFixed(2)}s ${text.slice(0, 28)}`);
    } else {
      writeWav(dst, softTone(Math.max(1.5, shot.durationSec)), 24000);
      if (!wavIsAudible(dst)) throw new Error(`tone inaudible ${shot.id}`);
      tone += 1;
      console.log(`TONE ${shot.id} ${shot.durationSec.toFixed(2)}s`);
    }
  }
  console.log(JSON.stringify({ total: cs.shots.length, keep, auk, tone, outDir }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
