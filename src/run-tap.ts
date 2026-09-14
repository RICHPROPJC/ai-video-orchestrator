#!/usr/bin/env tsx
/** run-tap — obs-tap 獨立 runner：把 data/jobs 下各 slate 嘅 events.jsonl 鏡像去觀測 bus。
 *
 * 用法：
 *   npx tsx src/run-tap.ts                        # 全部 slates → 預設 bus data/obs/eventbus.jsonl
 *   npx tsx src/run-tap.ts --slate SC-0914-EN79   # 淨係一個 slate
 *   npx tsx src/run-tap.ts --bus /path/bus.jsonl  # 指定 bus（或 env OBS_TAP_BUS）
 *                                                   真源 bus 路徑係 ops 層決定，唔硬編入 src
 *
 * 冪等：cursor 落 `<bus>.tap-cursors.json`，重跑只送新行。
 * Fail-loud：bus 寫唔到即刻非零退出——tap 死唔准靜靜跳過。
 */
import path from "node:path";
import { tapAll } from "./lib/studio/obs-tap";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : undefined;
}

const repo = path.resolve(__dirname, "..");
const jobsDir = arg("--jobs") ?? path.join(repo, "data", "jobs");
const bus = arg("--bus") ?? process.env.OBS_TAP_BUS ?? path.join(repo, "data", "obs", "eventbus.jsonl");
const only = arg("--slate");

function runOnce(): void {
  const results = tapAll(jobsDir, bus, only);
  let sent = 0;
  for (const r of results) {
    if (r.sent > 0) console.log(`${r.slate}: +${r.sent} / ${r.total}`);
    sent += r.sent;
  }
  console.log(`obs-tap: bus=${bus} · ${results.length} slates · +${sent} rows`);
}

const watchSec = Number(arg("--watch") ?? 0);

if (watchSec > 0) {
  // daemon 語義：一輪失敗只報錯唔 exit——下一輪 cursor 追返，bus 翻生自動復修。
  // 單發（冇 --watch）維持 fail-loud exit 1，畀閘用人。
  console.log(`obs-tap watch: 每 ${watchSec}s 一輪 · bus=${bus}`);
  const loop = async (): Promise<void> => {
    for (;;) {
      try {
        runOnce();
      } catch (err) {
        console.error(`obs-tap watch 輪失敗（續行）: ${String(err)}`);
      }
      await new Promise((r) => setTimeout(r, watchSec * 1000));
    }
  };
  void loop();
} else {
  try {
    runOnce();
  } catch (err) {
    console.error(String(err));
    process.exit(1);
  }
}
