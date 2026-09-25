#!/usr/bin/env tsx
/** wb CLI — slatecrew 內部白盒採集／閘／查詢。
 *
 *  npx tsx src/lib/studio/wb/cli.ts <cmd>
 *    project [--jobs <dir>] [--db <file>]   全廠 events.jsonl 增量投影
 *    query --sql "<select...>"              即揾即到（readonly）
 *    query --latest <job> [k]               一個 job 最新 k 件
 *    query --deaths                         全廠 failed job 死因一句
 *    query --seat <job>                     每個席只收回自己嘅事件
 *    verify <jobId> [--jobs <dir>]          status claim 對碟上實物（四態）
 *    preflight [--drama <id>] [--skip-rig]  開場閘：playbook schema＋rig probe
 */
import { wbDbPath, projectEvents } from "./projector";
import { wbQuery, latestEvents, failedDeathCauses, dispatchBySeat } from "./query";
import { verifyJobStatus } from "./receipts";
import { preflightGate } from "./gates";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1];
  return fallback;
}

function main(): number {
  const cmd = process.argv[2];
  if (!cmd || cmd === "help" || cmd === "-h") {
    console.log(
      "wb <project|query|verify|preflight> — 詳情睇檔頭 doc：npx tsx src/lib/studio/wb/cli.ts",
    );
    return 0;
  }
  const dbPath = arg("--db") ?? wbDbPath();
  if (cmd === "project") {
    const r = projectEvents({ dbPath, jobsDir: arg("--jobs") });
    console.log(`projected ${r.projected} rows (skipped ${r.skipped}) -> ${dbPath}`);
    for (const s of r.sources) if (s.projected) console.log(`  +${s.projected} ${s.source}`);
    return 0;
  }
  if (cmd === "query") {
    const sql = arg("--sql");
    if (sql) {
      const { columns, rows } = wbQuery(dbPath, sql);
      console.log(JSON.stringify({ columns, rows }, null, 2));
      return 0;
    }
    const latest = process.argv.includes("--latest") ? arg("--latest") : undefined;
    if (latest) {
      const k = Number(arg("--k", process.argv[process.argv.indexOf("--latest") + 2] ?? "5")) || 5;
      console.log(JSON.stringify(latestEvents(dbPath, latest, k), null, 2));
      return 0;
    }
    if (process.argv.includes("--seat")) {
      const job = arg("--seat");
      if (!job) {
        console.error("query --seat <job>");
        return 1;
      }
      console.log(JSON.stringify(dispatchBySeat(dbPath, job), null, 2));
      return 0;
    }
    if (process.argv.includes("--deaths")) {
      for (const d of failedDeathCauses({ dbPath })) {
        console.log(`${d.job}  ${d.cause}`);
        if (d.lastEvent) console.log(`        last fail event: ${d.lastEvent.slice(0, 120)}`);
      }
      return 0;
    }
    console.error("query 需要 --sql / --latest <job> [k] / --seat <job> / --deaths");
    return 1;
  }
  if (cmd === "verify") {
    const jobId = process.argv[3];
    if (!jobId) {
      console.error("verify <jobId>");
      return 1;
    }
    const r = verifyJobStatus(jobId, { jobsDir: arg("--jobs") });
    console.log(JSON.stringify(r, null, 2));
    return r.verdict === "verified" || r.verdict === "no-receipt" ? 0 : 1;
  }
  if (cmd === "preflight") {
    const ok = preflightGate({
      drama: arg("--drama"),
      skipRigProbe: process.argv.includes("--skip-rig"),
    });
    for (const l of [...ok.playbook, ...ok.rig]) console.log(l);
    return 0;
  }
  console.error(`wb: 唔識嘅命令 ${cmd}`);
  return 1;
}

/* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access */
if (typeof require !== "undefined" && require.main === module) {
  process.exit(main());
}
