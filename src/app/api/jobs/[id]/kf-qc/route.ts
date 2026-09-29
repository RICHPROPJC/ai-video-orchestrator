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
  /** 現行錨定 verdict：copy-on-GREEN 下 destination bytes 永遠由最新 GREEN
   *  attempt 釘住（重做輪 FAIL 唔 pin、碟上留 GREEN 版——production 23:0x 機制
   *  答覆＋mtime 時序核實）。淨報最新 attempt FAIL 會令用戶誤解碟圖 FAIL——
   *  兩態並列：pinned（碟上版收據）＋kf（最新重做輪態）。 */
  const pinned: Record<string, { status: string; board: string; boardSha?: string; attemptBoard?: string }> = {};
  let boards = 0;
  if (fs.existsSync(boardsDir)) {
    // 方法漂移審計實證（0930）：字母序會令 d92809b5（13:44 真採納）被
    // fabe4226（11:23 舊版）蓋——board 收據要按 mtime 時序，後完成嘅板先係
    // destination 嘅現行收據源。
    const files = fs
      .readdirSync(boardsDir)
      .filter((f) => f.endsWith(".visual.json"))
      .sort((a, b) => fs.statSync(path.join(boardsDir, a)).mtimeMs - fs.statSync(path.join(boardsDir, b)).mtimeMs);
    for (const f of files) {
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
          const row = {
            status: c.status ?? "?",
            board: f.replace(/\.visual\.json$/, ""),
            boardSha: at.sha256,
            attemptBoard: at.board?.split("/").pop(),
          };
          kf[dest] = row;
          if (row.status === "GREEN") pinned[dest] = row;
        }
      }
    }
  }
  return NextResponse.json({ boards, kf, pinned }, { headers: { "cache-control": "no-store" } });
}
