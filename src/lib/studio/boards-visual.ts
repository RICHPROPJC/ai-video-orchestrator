import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { chunkFrameMoments, ensureKeyframeSheet, storyboardBoardPrompt, type BoardLane, type SheetMoment } from "./asset-board";
import type { QcRequire } from "./photo-qc";

export type BoardsVisualOptions = {
  moments: SheetMoment[];
  boardsDir: string;
  receiptDir: string;
  name: string;
  images: string[];
  lane: BoardLane;
  seed?: number;
  cellPx?: number;
  style?: string;
  require?: Record<string, QcRequire>;
};

/** Called only by runBoards. Failed crops are collected into repair boards;
 * accepted neighbours are never regenerated or overwritten by a repair. */
export async function renderBoards(opts: BoardsVisualOptions) {
  if (!opts.moments.length) throw new Error("boards: no moments");
  if (new Set(opts.moments.map((m) => m.file)).size !== opts.moments.length) throw new Error("boards: duplicate cell destination");
  fs.mkdirSync(opts.receiptDir, { recursive: true });
  const run = `${opts.name}-${crypto.randomUUID().slice(0, 8)}`;
  const attemptDir = path.join(opts.boardsDir, run);
  const receipt = path.join(opts.receiptDir, `${run}.visual.json`);
  const attempts: { board: string; sha256: string; inputs: string[]; cells: { shotId: string; at: string; file: string; destination: string; sha256: string; qc: string; status: string }[] }[] = [];
  const digest = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const write = (status: string) => fs.writeFileSync(receipt, JSON.stringify({ owner: "boards", status, attempts }, null, 2));
  write("pending");
  let pending = opts.moments;
  const rejected = new Map<string, string>();
  for (let round = 0; round < 3 && pending.length; round++) {
    const failed: SheetMoment[] = [];
    const batchSize = round === 0 ? 16 : pending.length <= 4 ? 4 : pending.length <= 8 ? 8 : 16;
    for (const [i, group] of chunkFrameMoments(pending, batchSize).entries()) {
      const name = `${opts.name}-r${round}-${i + 1}`;
      const staged = group.map((m, j) => ({ ...m, file: path.join(attemptDir, `${name}.cell-${j + 1}.png`) }));
      let images = opts.images;
      if (round > 0) {
        const cols = group.length === 16 ? 4 : group.length === 1 ? 1 : 2;
        const repairBoard = path.join(attemptDir, `${name}.repair-input.png`);
        const tiles = await Promise.all(group.map(async (m, j) => ({
          input: await sharp(rejected.get(m.file)!).resize(512, 512, { fit: "contain", background: "white" }).png().toBuffer(),
          left: (j % cols) * 512, top: Math.floor(j / cols) * 512,
        })));
        await sharp({ create: { width: cols * 512, height: Math.ceil(group.length / cols) * 512, channels: 3, background: "white" } })
          .composite(tiles).png().toFile(repairBoard);
        images = [repairBoard, ...opts.images];
      }
      const made = await ensureKeyframeSheet({
        ...opts, images, boardsDir: attemptDir, name, moments: staged, seed: (opts.seed ?? 42) + round,
        prompt: storyboardBoardPrompt({
          cells: group.map((m) => `${m.shotId}${m.at ? `，鏡內${m.at}` : "，鏡內起點"}：${m.text}`),
          style: opts.style ?? "寫實電影感、画面清晰銳利", cleanCuts: true,
        }) + "格內只畫指定時刻，鏡號同百分比係切格對照資料，留喺收據，畫面保持乾淨。剩餘空位留白，唔開新鏡。"
          + (round > 0 ? "Image-1係抽出再併嘅壞格，依照同一次序修正指定格；其後參考圖只供角色身份。" : "參考圖只供角色身份。"),
      });
      const attempt: typeof attempts[number] = { board: made.board, sha256: digest(made.board), inputs: images, cells: [] };
      attempts.push(attempt);
      for (const [j, m] of group.entries()) {
        const file = staged[j]!.file;
        const qc = file.replace(/\.png$/, ".photo_qc.json");
        const result = await opts.lane.qc(file, qc, opts.require?.[m.shotId] ?? {});
        attempt.cells.push({ shotId: m.shotId, at: m.at || "0%", file, destination: m.file, sha256: digest(file), qc, status: result.status });
        if (result.status === "GREEN") {
          fs.mkdirSync(path.dirname(m.file), { recursive: true });
          fs.copyFileSync(file, m.file);
        } else {
          rejected.set(m.file, file);
          failed.push(m);
        }
        write("pending");
      }
    }
    pending = failed;
  }
  write(pending.length ? "blocked" : "GREEN");
  if (pending.length) throw new Error(`boards: ${pending.length} cells not GREEN; receipt ${receipt}`);
  return { board: attempts[0]!.board, cells: opts.moments.map((m) => m.file), receipt, attempts };
}
