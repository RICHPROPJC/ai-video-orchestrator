// R22 差4（ROOT 0929 接續令）：runtime loaded version 自報——Album 五態進度
// ③「loaded runtime」嘅服務收據。git HEAD＋pid＋uptime；dev server hot-reload
// 後 commit 即時反映（同 repo 真源直讀）。git 唔在（部署包）＝各欄 null 照報。
import { execFileSync } from "node:child_process";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

export async function GET() {
  const git = (args: string[]): string | null => {
    try {
      return execFileSync("git", args).toString().trim();
    } catch {
      return null;
    }
  };
  return NextResponse.json({
    commit: git(["rev-parse", "HEAD"]),
    commitTs: git(["show", "-s", "--format=%cI", "HEAD"]),
    pid: process.pid,
    uptimeSec: Math.round(process.uptime()),
    ts: new Date().toISOString(),
  });
}
