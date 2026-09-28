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
  /** 參考圖角色說明（pipeline 按實際組合傳；缺省＝淨角色身份板） */
  refNote?: string;
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
      // 單格 repair 唔砌 tile 板：嗰塊 tile 做 Image-1 令 U1.5 抄錯版式
      // （board_layout asked 1 columns picture has 4 → throw，冇 r2 好試）。
      // 單格冇好鄰居要保，round>0 直接新 seed 重滾乾淨板。
      // repair tiles 只用「真係存在於碟且屬本 attempt QC FAIL」嘅 rejected crop；
      // 冇有效 crop（例如版式拒切 round）＝行乾淨 refs 生成，唔拼 repair 板。
      const repairable = round > 0 && group.length > 1
        ? group.filter((m) => {
            const f = rejected.get(m.file);
            return Boolean(f && f !== m.file && fs.existsSync(f));
          })
        : [];
      if (repairable.length > 1) {
        // repair tiles 版式必須同 ensureKeyframeSheet 嘅期望欄數一致（GPT-6 裁決
        // 根因1）：n<=3 一欄直疊，否則 tile 拼二欄、切格期望一欄＝拒切。
        const cols = repairable.length === 16 ? 4 : repairable.length <= 3 ? 1 : 2;
        const repairBoard = path.join(attemptDir, `${name}.repair-input.png`);
        const tiles = await Promise.all(repairable.map(async (m, j) => ({
          input: await sharp(rejected.get(m.file)!).resize(512, 512, { fit: "contain", background: "white" }).png().toBuffer(),
          left: (j % cols) * 512, top: Math.floor(j / cols) * 512,
        })));
        await sharp({ create: { width: cols * 512, height: Math.ceil(repairable.length / cols) * 512, channels: 3, background: "white" } })
          .composite(tiles).png().toFile(repairBoard);
        images = [repairBoard, ...opts.images];
      }
      let made: Awaited<ReturnType<typeof ensureKeyframeSheet>>;
      try {
        made = await ensureKeyframeSheet({
          ...opts, images, boardsDir: attemptDir, name, moments: staged, seed: (opts.seed ?? 42) + round,
        prompt: storyboardBoardPrompt({
          cells: group.map((m) => m.text),
          style: opts.style ?? "寫實電影感、画面清晰銳利", cleanCuts: true,
        }) + "格內只畫指定時刻，鏡號同百分比係切格對照資料，留喺收據，畫面保持乾淨。剩餘空位留白，唔開新鏡。"
          + (images[0]?.endsWith(".repair-input.png")
            ? "Image-1係抽出再併嘅壞格，依照同一次序修正指定格；其餘參考圖角色照下列（非位置描述）。"
            : "")
          + (opts.refNote
            ?? "參考圖第一張係角色身份，跨格同一人。其後每張係道具實物照：道具嘅外形、顏色、質感、比例以參考圖為準照抄落畫面，文字描述唔取代道具參考圖。"),
        });
      } catch (error) {
        // Fix3（GPT-6 裁決根因3）：版式拒切係「呢一 round 作廢、下 round 新 seed 重試」，
        // 唔係殺成個 produce。round 迴圈自然會行下一輪；三 round 用晒 pending 仍非空，
        // 末尾先 throw 全部未 GREEN。
        const message = error instanceof Error ? error.message : String(error);
        if (/board_layout/.test(message)) {
          // 版式拒切＝呢 round 作廢。group 必須留喺 pending（failed.push），
          // 唔可以設定 rejected（crop 從未切出，指去 m.file 只會令下 round
          // repair 讀錯檔——GPT-6 即時覆核捉嘅假 GREEN／毒 mapping）。
          attempts.push({ board: "", sha256: "", inputs: images, cells: group.map((m) => ({ shotId: m.shotId, at: m.at, file: m.file, destination: m.file, sha256: "", qc: "", status: `RETRY_LAYOUT: ${message}` })) });
          failed.push(...group);
          continue;
        }
        throw error;
      }
      const attempt: typeof attempts[number] = { board: made.board, sha256: digest(made.board), inputs: images, cells: [] };
      attempts.push(attempt);
      for (const [j, m] of group.entries()) {
        const file = staged[j]!.file;
        const qc = file.replace(/\.png$/, ".photo_qc.json");
        // R20 裁決①（0929）：require lookup 先 per-moment（destination file key，
        // endpoint-state 格 require）後 per-shot（舊介面）——一格一格按採納
        // moment 驗，唔把完整 shot 動詞塞每 cell。
        const result = await opts.lane.qc(file, qc, opts.require?.[m.file] ?? opts.require?.[m.shotId] ?? {});
        attempt.cells.push({ shotId: m.shotId, at: m.at, file, destination: m.file, sha256: digest(file), qc, status: result.status });
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
