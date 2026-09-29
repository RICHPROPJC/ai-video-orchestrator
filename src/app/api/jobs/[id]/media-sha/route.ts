import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobDir } from "@/lib/studio/paths";
import { readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

/** DECISION-SHA-REUSE（Chau 核實 front=side 同 sha256 11c69122…/3331B）：
 *  產物檔真 sha256 顯示口——UI 兩個位 sha 相同先標「同 sha 翻用」（精確匹配；
 *  story-30 七 shot sha 互異，唔可以標互相同片）。module cache（mtime+size
 *  不變用舊值）防每 poll 重算。檔唔在＝缺席 named。 */
const cache = new Map<string, { mtimeMs: number; size: number; sha: string }>();

function sha256Of(abs: string): string | null {
  try {
    const st = fs.statSync(abs);
    const hit = cache.get(abs);
    if (hit && hit.mtimeMs === st.mtimeMs && hit.size === st.size) return hit.sha;
    const h = createHash("sha256").update(fs.readFileSync(abs)).digest("hex");
    cache.set(abs, { mtimeMs: st.mtimeMs, size: st.size, sha: h });
    return h;
  } catch {
    return null;
  }
}

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) return NextResponse.json({ error: "not found" }, { status: 404 });
  const dir = jobDir(id);
  const sha: Record<string, string> = {};
  const missing: string[] = [];
  /** Chau 0930 指正：outputs.blockout manifest 淨註冊部分（WSY6 9/14）——碟上
   *  blockout/ 全部 mp4 照掃（SH05=SH06 喺碟唔喺清單，淨信 manifest 標唔到）。
   *  outputs.shots（motion）照舊；rel 統一 blockout/<name>。 */
  const rels = new Set<string>(job.outputs.shots ?? []);
  try {
    for (const f of fs.readdirSync(path.join(dir, "blockout"))) {
      if (f.endsWith(".mp4")) rels.add(`blockout/${f}`);
    }
  } catch {
    /* blockout dir 唔在＝零灰模，照舊 */
  }
  for (const rel of rels) {
    const h = sha256Of(path.join(dir, rel));
    if (h) sha[rel] = h;
    else missing.push(rel);
  }
  return NextResponse.json({ sha, missing }, { headers: { "cache-control": "no-store" } });
}
