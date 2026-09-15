#!/usr/bin/env tsx
/** run-bench — bench 獨立 runner：聚合 data/jobs/* 機器收據，零燒片。
 *
 * 用法：
 *   npx tsx src/run-bench.ts              # markdown 表去 stdout
 *   npx tsx src/run-bench.ts --json       # 成份 BenchReport JSON
 *   npx tsx src/run-bench.ts --jobs <dir> # 指定 jobs 目錄
 */
import path from "node:path";
import { bench, markdownReport } from "./lib/studio/bench";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const repo = path.resolve(__dirname, "..");
const jobsDir = arg("--jobs") ?? path.join(repo, "data", "jobs");

try {
  const report = bench(jobsDir);
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(markdownReport(report));
  }
} catch (err) {
  console.error(String(err));
  process.exit(1);
}
