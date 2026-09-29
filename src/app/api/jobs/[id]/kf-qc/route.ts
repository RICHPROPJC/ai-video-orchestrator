import fs from "node:fs";
import path from "node:path";
import { NextResponse } from "next/server";
import { jobDir } from "@/lib/studio/paths";
import { readJob } from "@/lib/studio/store";

export const runtime = "nodejs";

/** ROOT 1046Z 刀3：KF cell QC 真源——seats/boards/<board>.visual.json 內
 *  attempts[].cells[].destination＝stills/SHxx.kf-NN.png（board 名帶 content
 *  hash，client 猜唔到）——呢度 server 側 listing＋reduce 做「每張 KF 檔最新
 *  cell 狀態」map，client 一個 fetch。收據冇 destination＝named 缺，唔判 FAIL。 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!readJob(id)) return NextResponse.json({ error: "not found" }, { status: 404 });
  const boardsDir = path.join(jobDir(id), "seats", "boards");
  type Attempt = { board?: string; sha256?: string; cells?: { destination?: string; status?: string }[] };
  const kf: Record<string, { status: string; board: string; boardSha?: string; attemptBoard?: string }> = {};
  let boards = 0;
  if (fs.existsSync(boardsDir)) {
    for (const f of fs.readdirSync(boardsDir).sort()) {
      if (!f.endsWith(".visual.json")) continue;
      boards += 1;
      let doc: { attempts?: Attempt[] };
      try {
        doc = JSON.parse(fs.readFileSync(path.join(boardsDir, f), "utf-8")) as { attempts?: Attempt[] };
      } catch {
        continue;
      }
      // attempts 時序排——後者覆蓋前者＝每 destination 取最新 round 狀態。
      for (const at of doc.attempts ?? []) {
        for (const c of at.cells ?? []) {
          const dest = c.destination?.split("/").pop();
          if (!dest) continue;
          kf[dest] = {
            status: c.status ?? "?",
            board: f.replace(/\.visual\.json$/, ""),
            boardSha: at.sha256,
            attemptBoard: at.board?.split("/").pop(),
          };
        }
      }
    }
  }
  return NextResponse.json({ boards, kf }, { headers: { "cache-control": "no-store" } });
}
