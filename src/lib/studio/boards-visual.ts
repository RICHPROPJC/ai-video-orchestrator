import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import sharp from "sharp";
import { chunkFrameMoments, ensureKeyframeSheet, storyboardBoardPrompt, type BoardLane, type SheetMoment } from "./asset-board";
import { MAX_IMAGES } from "./u15-edit";
import { EYE_SAMPLING, eyeDescribe, type QcRequire } from "./photo-qc";
import { loadConfig } from "./config";

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
  const attempts: { board: string; sha256: string; inputs: string[]; prompt: string; droppedRefs?: string[]; cells: { shotId: string; at: string; file: string; destination: string; sha256: string; qc: string; status: string }[] }[] = [];
  const digest = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");
  const write = (status: string) => fs.writeFileSync(receipt, JSON.stringify({ owner: "boards", status, attempts }, null, 2));
  write("pending");
  let pending = opts.moments;
  const rejected = new Map<string, string>();
  // 統籌 ruling 0930（y8kh-stop-r1-repair）：round 上限 2——round 0 成板（mix
  // FL 幀列表×REF 成板 Image-1）、round 1 單格重做；舊 round1/2 repair tile
  // 成板 reroll 退役（「成板重出同成板 blocked 都唔係呢條路」）。
  for (let round = 0; round < 2 && pending.length; round++) {
    const failed: SheetMoment[] = [];
    if (round > 0) {
      // ===== round 1＝單格重做（ruling 規格）：QC FAIL 格逐個重出 =====
      // refs＝灰模板第 i 格裁切（對位）＋原有外觀 refs；輸出同出板格一樣大嘅
      // 單格圖；新圖寫返同一塊板第 i 格矩形（其他格像素留低）；重 QC 嗰格。
      // 唔砌 repair tile 板、唔成板 reroll、唔 seed bump。
      // ③（ruling y8kh-cell-redo-accept）：round 0 版式拒切時 attempts[0].board
      // 係空字串——攞第一塊真板；冇真板＝具名 throw 唔貼。
      const base = attempts.find((a) => a.board)?.board ?? "";
      if (!base) throw new Error("boards: round 1 單格重做冇真板可貼（round 0 全部版式拒切，board 空）——唔入 composite");
      const greyBoardSrc = opts.images[0]!;
      // ①（ruling）：外觀 refs 留滿 MAX_IMAGES-1（greyCrop 佔 1 位）；多餘先
      // 寫 droppedRefs——舊 slice(1, MAX_IMAGES-1) 淨留 3 張，第五張靜靜掉。
      const outerRefs = opts.images.slice(1, 1 + (MAX_IMAGES - 1));
      const outerDropped = opts.images.length > MAX_IMAGES ? opts.images.slice(MAX_IMAGES).map((f) => path.basename(f)) : [];
      const cols = 4; // KEYFRAME_SPAWN=16 4×4（與 ensureKeyframeSheet 版式同源）
      const rows = Math.ceil(opts.moments.length / cols);
      const baseMeta = await sharp(base).metadata();
      const cw = Math.floor((baseMeta.width ?? 4096) / cols);
      const ch = Math.floor((baseMeta.height ?? 4096) / rows);
      const greyMeta = await sharp(greyBoardSrc).metadata();
      const gcw = Math.floor((greyMeta.width ?? 2048) / cols);
      const gch = Math.floor((greyMeta.height ?? 2048) / rows);
      // ②（ruling）：sha256 貼完十六格先 digest（建 attempt 時留空，迴圈後寫返）
      const redoAttempt: typeof attempts[number] = { board: base, sha256: "", inputs: [greyBoardSrc, ...outerRefs], prompt: "single-cell redo (per-cell prompt in cell receipts)", ...(outerDropped.length ? { droppedRefs: outerDropped } : {}), cells: [] };
      attempts.push(redoAttempt);
      for (const [j, m] of opts.moments.entries()) {
        if (!pending.some((p) => p.file === m.file)) continue; // 淨本輪 FAIL 格
        const col = j % cols;
        const row = Math.floor(j / cols);
        const greyCrop = path.join(attemptDir, `${opts.name}-r1-cell-${j + 1}.greyref.png`);
        await sharp(greyBoardSrc).extract({ left: col * gcw, top: row * gch, width: gcw, height: gch }).toFile(greyCrop);
        const cellFile = path.join(attemptDir, `${opts.name}-r1-cell-${j + 1}.png`);
        // 統籌 ruling 0930（y8kh-stop-r1-prompt）：舊 cellPrompt 三死位——
        // ①一格走 numberedLayoutClause(1) 出「2列×1行＋左上角01」（燒四 cell-5
        // 出兩直欄同呢句對上）②正文淨係分號切出一片（「人縫之間」）但 QC
        // require.action 係成句——模型冇被叫去畫成句③尾再貼成板 refNote
        // （「16 格對位板」——r1 Image-1 其實係一格裁切，句錯配）。新形態：
        // cleanCuts（layoutClause(1)＝1列×1行、冇 01 冇「文字數字」句）；
        // Image-1 淨講呢張裁切＝企位/走位/構圖、外觀唔跟佢，後面參考圖先係
        // 角色道具外形（唔再貼 opts.refNote）；格正文寫呢格要見到嘅畫面
        // （場所＋景別＋呢個時刻動作，同 QC require 同源）；img_cfg/steps/
        // QC require／第二眼 catch 唔郁。
        const cellRq = opts.require?.[m.file] ?? opts.require?.[m.shotId] ?? {};
        // 統籌覆核 0930：m.text 係 action 分號切出嘅一片（cell-1「高角固定俯
        // 瞰斑馬線：人潮由畫左向畫右湧過馬路」、cell-3「人縫之間」）——只加場
        // 所景別前綴，格 3 依然係「呢一刻：人縫之間」一片，唔係呢格要見到嘅
        // 畫面。正形：畫面正文用 require.action 成句（QC 判官逐項判嘅就係佢
        // ——prompt 畫面同 QC 驗收同源），m.text 淨做呢格時刻定位；action
        // 缺席先 fallback 一片。
        const cellScene = [
          cellRq.location ? `場所：${cellRq.location}` : "",
          cellRq.size ? `景別：${cellRq.size}` : "",
          `呢一格畫面（時刻：${m.text}）：${cellRq.action ?? m.text}`,
        ].filter(Boolean).join("。").replace(/。+$/, "");
        const cellPrompt = storyboardBoardPrompt({ cells: [cellScene], style: opts.style ?? "寫實電影感、画面清晰銳利", cleanCuts: true })
          + `單格重做：呢張圖只畫呢一格（第 ${j + 1} 格嘅時刻），成張圖就係呢一個畫面，冇格線、冇編號、冇拼接。Image-1 係灰模板第 ${j + 1} 格嘅裁切＝呢格嘅企位/走位/構圖/鏡位照佢，外觀（人樣/衫/道具look）永遠唔參考佢；其後嘅參考圖先係角色同道具外形。`;
        // 燒二實證（a5b69434 cell-5）：單格 edit 偶發出 2 直行版式→ensureKeyframeSheet
        // 版式拒切 throw 殺 job（round1 段漏 catch——round0 有）。修：拒切＝呢格
        // keep FAIL 收據（RETRY_LAYOUT）續行其他格，唔重試唔殺隊（round 上限 2
        // 冇 round 2，單格拒切等下輪 resume）。
        try {
          await ensureKeyframeSheet({ ...opts, images: [greyCrop, ...outerRefs], boardsDir: attemptDir, name: `${opts.name}-r1-cell-${j + 1}-sheet`, moments: [{ ...m, file: cellFile }], cellPx: cw, seed: (opts.seed ?? 42) + 100 + j, prompt: cellPrompt });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (!/board_layout/.test(message)) throw error;
          redoAttempt.cells.push({ shotId: m.shotId, at: m.at, file: cellFile, destination: m.file, sha256: "", qc: "", status: `R1-RETRY_LAYOUT: ${message}` });
          rejected.set(m.file, cellFile);
          failed.push(m);
          write("pending");
          continue;
        }
        // 新圖寫返主板第 i 格矩形（temp→rename 原子替換；其他格像素留低）
        const cellPng = await sharp(cellFile).resize(cw, ch).png().toBuffer();
        await sharp(base).composite([{ input: cellPng, left: col * cw, top: row * ch }]).png().toFile(`${base}.r1tmp.png`);
        fs.renameSync(`${base}.r1tmp.png`, base);
        const qc = cellFile.replace(/\.png$/, ".photo_qc.json");
        const result = await opts.lane.qc(cellFile, qc, opts.require?.[m.file] ?? opts.require?.[m.shotId] ?? {});
        redoAttempt.cells.push({ shotId: m.shotId, at: m.at, file: cellFile, destination: m.file, sha256: digest(cellFile), qc, status: `R1-CELL ${result.status}` });
        if (result.status === "GREEN") {
          fs.mkdirSync(path.dirname(m.file), { recursive: true });
          fs.copyFileSync(cellFile, m.file);
        } else {
          rejected.set(m.file, cellFile);
          failed.push(m);
        }
        write("pending");
      }
      redoAttempt.sha256 = digest(base); // ②：貼完全部格先 digest 寫返收據
      pending = failed;
      continue;
    }
    for (const [i, group] of chunkFrameMoments(pending, 16).entries()) {
      const name = `${opts.name}-r${round}-${i + 1}`;
      const staged = group.map((m, j) => ({ ...m, file: path.join(attemptDir, `${name}.cell-${j + 1}.png`) }));
      // round 0＝成板（mix：caller images[0] 灰模板做 Image-1）——舊 repair tile
      // 成板 reroll 段已退役（統籌 ruling 0930：FAIL 格行 round 1 單格重做）。
      const images = opts.images;
      const repairDroppedRefs: string[] = [];
      let made: Awaited<ReturnType<typeof ensureKeyframeSheet>>;
      // R22（ROOT 0929）：actual submitted prompt 原文變數化——每 attempt 落收據
      // （stills 外層 QC expectation 消費真提交原文，keyframeSheetPrompt 重建版
      // 唔再冒充 actual；版式承諾留喺板層收據，outer 淨驗 primary cell 合同）。
      // R22 修2（ROOT 0929 修正令）：fallback refNote（「參考圖第一張係角色身份」）
      // 剷走——caller 必須傳真實圖序 refNote（images 首張可能係灰模 f0 或 repair
      // 板，假定第一張身份＝角色錯配根源）；缺席即 throw 唔靜靜行模板。
      if (!opts.refNote) throw new Error("boards: refNote required（真實 ordered Image-N role mapping——caller 照 images 實際序砌；灰模只空間/姿態參考唔冒充身份）");
      const submittedPrompt = storyboardBoardPrompt({
        cells: group.map((m) => m.text),
        style: opts.style ?? "寫實電影感、画面清晰銳利", cleanCuts: true,
      }) + "格內只畫指定時刻，鏡號同百分比係切格對照資料，留喺收據，畫面保持乾淨。剩餘空位留白，唔開新鏡。"
        + opts.refNote;
      try {
        made = await ensureKeyframeSheet({
          ...opts, images, boardsDir: attemptDir, name, moments: staged, seed: (opts.seed ?? 42) + round,
        prompt: submittedPrompt,
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
          attempts.push({ board: "", sha256: "", inputs: images, prompt: submittedPrompt, cells: group.map((m) => ({ shotId: m.shotId, at: m.at, file: m.file, destination: m.file, sha256: "", qc: "", status: `RETRY_LAYOUT: ${message}` })) });
          failed.push(...group);
          continue;
        }
        throw error;
      }
      const attempt: typeof attempts[number] = { board: made.board, sha256: digest(made.board), inputs: images, prompt: submittedPrompt, ...(repairDroppedRefs.length ? { droppedRefs: repairDroppedRefs } : {}), cells: [] };
      attempts.push(attempt);
      // RULING-001 D1b（Pi 統籌 1001）批准：nex 快照層——round0 切格後全格
      // 並行 :8017 一格一讀（reasoning_effort=none），收據逐格一句＋每格耗時
      // ＋wall clock＋model id。硬邊界：淨寫快照層，唔寫 photo_qc status、
      // 唔 copy destination、唔當 GREEN、唔擋下面 Qwen QC loop、唔入任何
      // U1.5 input（讀輸出唔係餵輸入）。Y8KH 凍結照舊——呢層跟下一次正路
      // run 先實際行。全 try/catch：快照爛淨寫 error 收據，唔阻主流程。
      try {
        const snapCfg = loadConfig();
        const snapT0 = Date.now();
        const snapCells = await Promise.all(staged.map(async (s) => {
          const c0 = Date.now();
          const sentence = await eyeDescribe(snapCfg.nex.endpoint, snapCfg.nex.model, fs.readFileSync(s.file), EYE_SAMPLING, 400);
          return { file: path.basename(s.file), sentence: sentence.trim().slice(0, 500), ms: Date.now() - c0 };
        }));
        fs.writeFileSync(path.join(attemptDir, `${name}.nex-snapshot.json`), JSON.stringify({
          tool: "slatecrew.nex_snapshot", ts: new Date().toISOString(),
          model: snapCfg.nex.model, parallel: staged.length,
          wallClockMs: Date.now() - snapT0, cells: snapCells,
        }, null, 2));
      } catch (error) {
        try {
          fs.writeFileSync(path.join(attemptDir, `${name}.nex-snapshot.error.json`), JSON.stringify({
            tool: "slatecrew.nex_snapshot", ts: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
          }, null, 2));
        } catch { /* 收據都寫唔到就淨係唔出快照——主流程照行 */ }
      }
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
