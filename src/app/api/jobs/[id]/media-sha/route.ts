import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobDir } from "@/lib/studio/paths";
import { readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

/** Chau 0930 實症（重做出同前條一模一樣嘅片／翻用當兩鏡）：產物 sha 對帳口——
 *  outputs.shots＋outputs.blockout 每 rel 計 sha256，UI 同 sha 對標紅「翻用」。
 *  檔唔在＝缺席照報（named），唔猜。 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dir = jobDir(id);
  const out: Record<string, string> = {};
  const missing: string[] = [];
  for (const rel of [...(job.outputs.shots ?? []), ...(job.outputs.blockout ?? [])]) {
    try {
      const buf = fs.readFileSync(path.join(dir, rel));
      let h = 0x811c9dc5;
      for (const b of buf) {
        h ^= b;
        h = Math.imul(h, 0x01000193) >>> 0;
      }
      // FNV-1a 32bit＋bytes 長度雙鍵——同 job 幾十檔對翻用夠準夠快；完整 sha256 留收據層。
      out[rel] = `fnv${h.toString(16).padStart(8, "0")}:${buf.length}`;
    } catch {
      missing.push(rel);
    }
  }
  return NextResponse.json({ sha: out, missing }, { headers: { "cache-control": "no-store" } });
}
