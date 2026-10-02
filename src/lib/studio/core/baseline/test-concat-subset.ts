/** Editor席局部characterization：用WIST嘅7個mp4做concat子集測試
 * 驗證新舊代碼對同一組輸入產出相同嘅concat結果 */

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

const DIR = path.join("data", "jobs", "SC-0913-WIST", "motion");
const OUT = "/tmp/char-concat-test.mp4";

async function main() {
  const mp4s = fs.readdirSync(DIR).filter(f => f.endsWith(".mp4")).sort();
  if (mp4s.length === 0) throw new Error("no mp4s");

  // 寫concat list（同pipeline.ts一樣嘅格式）
  const listFile = "/tmp/char-concat-list.txt";
  fs.writeFileSync(listFile, mp4s.map(f => `file '${path.join(DIR, f)}'`).join("\n"));

  // ffmpeg concat（同pipeline.ts一樣嘅參數）
  const { execSync } = await import("node:child_process");
  execSync(`ffmpeg -y -f concat -safe 0 -i ${listFile} -c copy ${OUT}`, { stdio: "pipe" });

  // SHA
  const sha = createHash("sha256").update(fs.readFileSync(OUT)).digest("hex");
  const size = fs.statSync(OUT).size;

  console.log(JSON.stringify({
    input: mp4s,
    output: OUT,
    sha256: sha,
    sizeBytes: size,
  }, null, 2));
}

main().catch(e => { console.error(e); process.exit(1); });
