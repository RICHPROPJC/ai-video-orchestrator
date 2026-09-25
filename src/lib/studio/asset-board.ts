import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./audio";
import type { Character, ShotProp } from "./types";
import { buildEditPayload, checkHealth, u15Edit, type EditHealth } from "./u15-edit";
import { buildGeneratePayload, u15Generate } from "./u15-generate";
import { scpToHost, u15RefPath } from "./scp-upload";
import { loadConfig } from "./config";
import { photoQcEyesFromEnv, runPhotoQc, type PhotoQcRecord, type QcRequire } from "./photo-qc";

/** Chau 0921 戰略令：批量資產板。One board call (U1.5 /edit) → strict 2×2 grid
 *  → ffmpeg cut → per-cell blind eye → rembg → RGBA 入庫.
 *  Prompt grammar is the 0921-night verified shape (/tmp/u15_angles.py +
 *  /tmp/u15_4k_board.py): 版式規格式 — grid counts, equal cells, aligned
 *  edges, uniform spacing, thin white separators, cross-cell identity lock,
 *  all phrased positive (W4B 0921 Chau釘：負面內容token照入燃料). W4C：資產板
 *  無角標數字無黑框（燒入cell跟rembg RGBA pin落庫）；分鏡板閱讀用先有
 *  (numberedLayoutClause)。
 *
 *  底色標準 (Chau 0922 釘透明資產): asset boards sit on 純白 flat 底 —
 *  零漸變零陰影零地台, never 攝影棚灰 (難 key). U1.5 /edit and /generate both
 *  output RGB (no alpha; 0921-night 實測 mode=RGB), so transparency happens
 *  AFTER the cut: 切格 → QC (sha 企喺 RGB cut) → rembg → RGBA 入庫.
 *
 *  分流 law (Chau 0922 釘):
 *  - 角色多角度板＋換衫板 → cut cells pin into the portrait library (RGBA).
 *  - 道具板 → cells pin into assets/ (batch asset entry, RGBA).
 *  - 場景/建築板 → cells land in assets/scenes/ as Blender look-dev references
 *    (照板起模／外觀 look), THEN the normal path: blockout real scene →
 *    U1.5 /edit keyframe still → H3. Never a still ref.
 *  - 分鏡動作板 → runBoards keeps the board and mapped cuts in the boards seat.
 *  SHEETREF red line: the WHOLE board is a production-stage artifact only —
 *  it lives in boards/ and is never pinned as a ref, never fed to H3. */

export type BoardAngle = "front" | "45" | "side" | "back";
export const BOARD_ANGLES: BoardAngle[] = ["front", "45", "side", "back"];

/** each cut cell is 2304×2304-class by default → board 4608×4608 (snap32 clean) */
export const DEFAULT_CELL_PX = 2304;
export const PORTRAIT_BOARD_REQUIRE: QcRequire = { people_count: 1, grey_blocks: false };
export const PROP_BOARD_REQUIRE: QcRequire = { people_count: 0, grey_blocks: false };

/** 底色標準：純白 flat 底 — keyable, never 攝影棚灰（W4B：負面底色句剷走，正寫） */
const FLAT_WHITE_BG = "背景：純白flat底（#FFFFFF），零漸變、零陰影、零地台，主體無陰影無倒影。";

/** the 版式規格式 grammar every asset board shares (0921-night verified).
 *  W4C：角標數字＋黑框唔准入資產板——燒入cell會跟rembg RGBA pin落庫
 *  （WGTT A.front.cut.png實證「01」+黑框+雙sub-panel）；幼白間隔線留（cut對位靠佢）。 */
export const KEYFRAME_SPAWN = 16;

export function layoutClause(count: number): string {
  const grid = count === KEYFRAME_SPAWN ? "4列×4行" : count === 1 ? "1列×1行" : `2列×${Math.ceil(count / 2)}行`;
  return [
    `整體版式：嚴格採用${grid}宮格布局（單張圖嚴格包含${count}個畫面）；`,
    `${count}格尺寸嚴格一致、邊緣對齊、間距統一；每格用幼白色間隔線分隔。`,
  ].join("");
}

/** Reading boards may carry labels; clean keyframe cuts use the unnumbered layout. */
function numberedLayoutClause(count: number): string {
  return [
    `整體版式：嚴格採用2列×${Math.ceil(count / 2)}行宮格布局（單張圖嚴格包含${count}個畫面）；`,
    `${count}格尺寸嚴格一致、邊緣對齊、間距統一；每格用幼白色間隔線同黑色邊框分隔；`,
    `每格左上角依次標注${Array.from({ length: count }, (_, i) => String(i + 1).padStart(2, "0")).join("、")}清晰正確。`,
  ].join("");
}

/** 2×2 切格次序＝左上→右上→左下→右下（cut 同序）；資產板用方位點名，唔用數字 */
const QUADRANTS = ["左上格", "右上格", "左下格", "右下格"] as const;
const ROW_ZH = ["", "一", "二", "三", "四", "五", "六"] as const;

/** One 4K sheet, two columns. Ten types → 4096×5760. */
export const ERA_BOARD_PX = { width: 4096, height: 5760 } as const;

function gridCellLabel(i: number, count: number): string {
  if (count <= 4) return QUADRANTS[i] ?? `第${i + 1}格`;
  const row = ROW_ZH[Math.floor(i / 2) + 1] ?? String(Math.floor(i / 2) + 1);
  return `第${row}行${i % 2 === 0 ? "左" : "右"}格`;
}

export type SheetMoment = { shotId: string; at: string; text: string; file: string };

/** Percents written on the shot are that shot's keyframes, any count.
 *  No written string → the shot is one cell of a shared U1.5 sheet. */
export function momentsForShot(
  shot: { id: string; action: string; heading: string; stillPrompt?: string; keyframePositions?: string; size?: string; location?: string; props?: { name: string }[] },
  stillDir: string,
): SheetMoment[] {
  const place = shot.location ? `場所${shot.location}，背景就係呢個場所，唔好換成另一個房。` : "";
  const sizeLine = shot.size === "closeup" || shot.size === "insert"
    ? "景別特寫，畫面只見頭部同手上嘅物件，唔見全身。"
    : shot.size === "medium"
      ? "景別中景，腰以上半身入畫，見到腰。"
      : shot.size ? `景別${shot.size}。` : "";
  const body = (shot.action || shot.stillPrompt || shot.heading).trim();
  const named = `${body}${(shot.props ?? []).map((p) => p.name).join("")}`;
  const soda = /汽水|檸檬/.test(named) ? "手上嘅樽係瘦高圓柱玻璃樽，樽入面係黃色有汽泡嘅檸檬汽水。" : "";
  const sit = /坐/.test(body) ? "人坐低，臀部挨住凳，雙腳落地。" : "";
  const squint = /瞇眼/.test(body) ? "眼睛瞇住，嘴角向上笑。" : "";
  const table = /木檯|枱/.test(`${body}${shot.location ?? ""}`) ? "身前係一張木檯，檯面入鏡。" : "";
  const text = `${place}${sizeLine}${body}${soda}${sit}${squint}${table}`;
  const written = (shot.keyframePositions ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  if (written.length >= 2) {
    return written.map((at, i) => ({
      shotId: shot.id,
      at,
      text,
      file: path.join(stillDir, `${shot.id}.kf-${String(i).padStart(2, "0")}.png`),
    }));
  }
  return [{ shotId: shot.id, at: written[0] ?? "", text, file: path.join(stillDir, `${shot.id}.png`) }];
}

/** One moment per frame of the shot. Batches of 16 are separate spawns. */
export function fullFrameMoments(
  shot: { id: string; action: string; heading: string; stillPrompt?: string; location?: string; size?: string },
  frameCount: number,
  stillDir: string,
  beats?: string[],
): SheetMoment[] {
  const one = momentsForShot({ ...shot, keyframePositions: undefined }, stillDir)[0]!;
  return Array.from({ length: frameCount }, (_, i) => ({
    shotId: shot.id,
    at: "",
    text: beats?.[i] ?? one.text,
    file: path.join(stillDir, `${shot.id}.kf-${String(i).padStart(3, "0")}.png`),
  }));
}

export function chunkFrameMoments(moments: SheetMoment[], spawn = KEYFRAME_SPAWN): SheetMoment[][] {
  const sheets: SheetMoment[][] = [];
  for (let i = 0; i < moments.length; i += spawn) sheets.push(moments.slice(i, i + spawn));
  return sheets;
}

/** One U1.5 image holds the story's shots together. A shot that already
 *  carries its own keyframes stays on its own sheet. No count gate. */
export function chunkMomentSheets(groups: SheetMoment[][]): SheetMoment[][] {
  const sheets: SheetMoment[][] = [];
  let bag: SheetMoment[] = [];
  const flush = () => {
    if (bag.length) sheets.push(bag);
    bag = [];
  };
  for (const group of groups) {
    if (group.length >= 2) {
      flush();
      sheets.push(group);
      continue;
    }
    bag.push(...group);
  }
  flush();
  return sheets;
}

/** Story moments on one sheet. Cut afterwards. No corner numbers — they would burn into the cell. */
export function keyframeSheetPrompt(moments: { at: string; text: string }[]): string {
  const n = moments.length;
  if (n < 1) throw new Error("鍵格板：沒有格");
  const cells = moments.map((m, i) => `${gridCellLabel(i, n)}${m.at ? `（${m.at}）` : ""}${m.text}`).join("；");
  return [
    `生成一張分鏡鍵格板，${layoutClause(n)}`,
    `參考圖係已經起好嘅世界。用呢個世界生出下面嘅分鏡，唔好把參考圖直接抄成鍵格。`,
    `這一次出齊${n}個時刻，出完再切格。`,
    `每格一個完整時刻：${cells}。`,
    /樽|瓶/.test(cells) ? "畫面入面嘅樽係有蓋、樽頸收窄、瘦高圓柱玻璃樽身，由樽底到樽蓋成件入鏡。唔好畫成廣口罐、玻璃杯、有提手嘅壺。" : "",
    `每格做緊嘅動作就係寫低嘅嗰下，手勢照呢句，唔好抄參考圖入面嘅手勢。`,
    `格入面唔好寫 Scene、鏡號或者百分比。`,
    `風格：寫實電影感、畫面清晰銳利。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** W4B (0921 Chau釘)：模型係literal spec-follower，負面內容token照入燃料
 *  （「禁止打鬥」＝注入打鬥）——內容類negative全剷，格式項一律正面寫法。 */
const QUALITY_CLAUSE = "文字清晰正確、畫面乾淨、寫實風格、版式工整。";

/** ① 多角度肖像板 — /edit with the GREEN front portrait as Image-1 (ref-driven
 *  identity), four 全身 angles of the SAME character. T43：sheet rides for call
 *  shape but is never read——world grade 永遠唔入肖像ref（同純白flat底自相矛盾，
 *  WGTT A.angles 青綠邊光怪種實證）。 */
export function angleBoardPrompt(character: Character, _sheet?: { styleBible: { grade: string } }): string {
  return [
    `【編輯】Image-1係角色${character.name}嘅正面參考圖（${character.wardrobe}）。`,
    `保持同一個人嘅面容、髮型、體形同服裝完全一致。只出一張角色身份設定板，唔出第二張。成張未切嘅板就係呢套片嘅角色參考。`,
    `上方一條嚴格四等分的全身轉面帶，由左至右：正面全身企直、四分三全身、正側面全身、背面全身。四格同一個人、企直、成個身入鏡，旁邊有身高刻度，尺寸一致、邊緣對齊、幼白色間隔線。`,
    `其餘版面同在這一張、唔切去入模：剪影正面同側面、表情八種（平靜、好奇、緊張、驚訝、害怕、難過、堅定、放鬆）、微表情（眼、嘴、眉）、頭部多角度（四分三、側面、抬頭、低頭）、面部特寫、姿勢三個、服裝同配件細節、手部動作（放鬆、握拳、指向、抓握、觸面）、色板。`,
    `表情、手、配件特寫只留喺成張板上。${FLAT_WHITE_BG}`,
    `風格：寫實電影級角色身份設定板，版面工整如專業角色設定稿。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** ② 換衫板 — /edit with the EXISTING angle board as Image-1; one board swaps
 *  the wardrobe on all four angles, geometry untouched. */
export function wardrobeSwapBoardPrompt(character: Character, wardrobe: string): string {
  return [
    `【編輯】Image-1係同一個角色${character.name}嘅一張身份設定板。上方轉面帶由左至右係正面、四分三、正側面、背面全身。`,
    `將轉面帶四格同成張板上嘅衫著全部換做：${wardrobe}。`,
    `轉面帶嘅角度、構圖、企姿照Image-1原樣保留；面容、髮型、體形同Image-1一致，只換衫。表情、手、配件特寫留喺成張板。`,
    `版式照舊。${FLAT_WHITE_BG}`,
    `轉面帶四格全部完成換衫，${QUALITY_CLAUSE}`,
  ].join("");
}

/** ③ 道具板 — one board, N props, each cell one prop centred (batch asset entry). */
export function propBoardPrompt(props: ShotProp[]): string {
  const cells = props
    .map((p, i) => `${gridCellLabel(i, props.length)}${p.name}（${p.shape.join("、")}），一件完整居中擺放`)
    .join("；\n");
  return [
    `生成一張專業道具設定板，${layoutClause(props.length)}`,
    `${props.length}格內容（每格一件道具，居中擺放，純道具靜物）：\n${cells}。`,
    `${FLAT_WHITE_BG}風格：寫實電影級道具設定參考圖。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** 建築板 — one era, N types of that era, then cut. Nouns ride in from the
 *  caller. The prompt names only this era's types, never a list of eras. */
export function sceneBoardPrompt(opts: { era: string; types: string[] }): string {
  const n = opts.types.length;
  if (n < 1) throw new Error("建築板：types 空");
  const cells = opts.types.map((t, i) => `${gridCellLabel(i, n)}${opts.era}${t}，一幢完整居中`).join("；");
  return [
    `生成一張專業建築設定參考板，${layoutClause(n)}`,
    `${n}格全部係${opts.era}的建築，同一年代的${n}種不同樓。`,
    `每格一幢完整建築居中，從基座到屋頂完整入鏡：${cells}。`,
    `${FLAT_WHITE_BG}風格：寫實電影級建築設定參考。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** 分鏡動作板 prompt — storyboard/pre-vis layer (前期全覽). Board kept alongside cuts; this
 *  runBoards keeps mapped cuts, and it is not an asset board (no flat-white
 *  clause — the frame content is the scene itself). */
export function storyboardBoardPrompt(opts: { cells: string[]; style: string; cleanCuts?: boolean }): string {
  const n = opts.cells.length;
  if (!n) throw new Error("分鏡板：沒有格");
  const layout = opts.cleanCuts ? layoutClause(n) : n === KEYFRAME_SPAWN
    ? "整體版式：嚴格採用4列×4行宮格布局（單張圖嚴格包含16個畫面）；16格尺寸嚴格一致、邊緣對齊、間距統一；每格用幼白色間隔線同黑色邊框分隔；每格左上角依次標注01至16清晰正確。"
    : numberedLayoutClause(n);
  const numbered = opts.cells.map((c, i) => `${String(i + 1).padStart(2, "0")} — ${c}`).join("；\n");
  return [
    `生成一張專業分鏡板，${layout}`,
    `${n}格內容（各格指定角色，跨格同一角色面容服裝完全一致）：\n${numbered}。`,
    `風格：${opts.style}。`,
    `文字數字清晰正確、寫實風格、畫面清晰銳利、版式工整。`,
  ].join("");
}

export type BoardLane = {
  edit: (o: {
    prompt: string;
    images: string[];
    width: number;
    height: number;
    seed: number;
    outFile: string;
    recordJson: string;
  }) => Promise<unknown>;
  qc: (png: string, outJson: string, require: QcRequire) => Promise<Pick<PhotoQcRecord, "status" | "checks">>;
  cut: (boardPng: string, cells: { file: string; x: number; y: number; w: number; h: number }[]) => Promise<void>;
  /** RGB cut → RGBA 入庫 (U1.5 outputs mode=RGB; transparency lives here) */
  rembg: (input: string, output: string) => Promise<void>;
};

/** live /edit lane: stage every image to the node (scp), health gate, POST */
export function liveBoardLane(server: string): BoardLane {
  return {
    edit: async (o) => {
      if (o.images.length === 0) {
        const payload = buildGeneratePayload({
          prompt: o.prompt,
          width: o.width,
          height: o.height,
          seed: o.seed,
          steps: 8,
          thinkMode: false,
        });
        await u15Generate({ server, payload, outFile: o.outFile, recordJson: o.recordJson });
        return;
      }
      const host = new URL(server).hostname;
      const nodePaths: string[] = [];
      for (const img of o.images) {
        const rpath = u15RefPath(img);
        await scpToHost(host, loadConfig().ssh.user, img, path.dirname(rpath), path.basename(rpath));
        nodePaths.push(rpath);
      }
      const health: EditHealth = await checkHealth(server, nodePaths.length);
      const payload = buildEditPayload({ prompt: o.prompt, images: nodePaths, width: o.width, height: o.height, seed: o.seed });
      await u15Edit({
        server,
        payload,
        nodePaths,
        outFile: o.outFile,
        recordJson: o.recordJson,
        health,
        record: {
          ts: new Date().toISOString(),
          prompt: payload.prompt,
          img_cfg: payload.img_cfg_scale,
          cfg: payload.cfg_scale,
          steps: payload.num_steps,
          use_edit_pe: payload.use_edit_pe,
          width: payload.width,
          height: payload.height,
          ...(payload.seed != null ? { seed: payload.seed } : {}),
          first: true,
          base: o.images[0] ?? null,
          refs: o.images.slice(1),
        },
      });
    },
    // W4C P0：eyes 要跟call走（pipeline.ts:1194句式）——漏交＝GREEN降級
    // PASS_UNCONFIRMED，角度板pin閘永遠零格，死鎖。
    qc: (png, outJson, require) => runPhotoQc(png, outJson, require, {}, photoQcEyesFromEnv()),
    cut: cutBoardCells,
    rembg: rembgCell,
  };
}

async function probePngSize(file: string): Promise<{ width: number; height: number; pixFmt?: string }> {
  const fmt = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", file,
  ]);
  if (fmt.code !== 0) throw new Error(`ffprobe board size failed: ${fmt.stderr || file}`);
  const st = (JSON.parse(fmt.stdout).streams ?? [])[0] as { width?: number; height?: number; pix_fmt?: string };
  if (!st?.width || !st?.height) throw new Error(`board ${file} has no video stream dimensions`);
  return { width: st.width, height: st.height, pixFmt: st.pix_fmt };
}

/** u2net via the local rembg package. This interpreter's CuPy wheel crashes on
 *  import, so the cupy module is stubbed before rembg loads. RGBA png out. */
export async function rembgCell(input: string, output: string): Promise<void> {
  const py = process.env.REMBG_PYTHON || "/home/c/applications/python311/bin/python3";
  const r = await runCommand(py, [
    "-c",
    [
      "import sys, types",
      "class RawKernel:",
      "    def __init__(self, *a, **k): pass",
      "m = types.ModuleType('cupy')",
      "m.RawKernel = RawKernel",
      "sys.modules.setdefault('cupy', m)",
      "from rembg import remove",
      "from PIL import Image",
      "remove(Image.open(sys.argv[1])).save(sys.argv[2])",
    ].join("\n"),
    input,
    output,
  ]);
  if (r.code !== 0) throw new Error(`rembg failed for ${input}: ${(r.stderr || r.stdout).slice(-300)}`);
}

/** One /edit (or the lane's one call) writes the sheet. Cells are crops, not extra spawns. */
export async function ensureKeyframeSheet(opts: {
  moments: SheetMoment[];
  boardsDir: string;
  name: string;
  images: string[];
  seed?: number;
  cellPx?: number;
  lane: BoardLane;
  prompt?: string;
}): Promise<{ board: string; cells: string[] }> {
  const n = opts.moments.length;
  if (n < 1) throw new Error("鍵格板：沒有格");
  const cols = n === KEYFRAME_SPAWN ? 4 : n === 1 ? 1 : 2;
  const rows = Math.ceil(n / cols);
  const cellPx = n === KEYFRAME_SPAWN ? 1024 : (opts.cellPx ?? DEFAULT_CELL_PX);
  fs.mkdirSync(opts.boardsDir, { recursive: true });
  for (const m of opts.moments) fs.mkdirSync(path.dirname(m.file), { recursive: true });
  const board = path.join(opts.boardsDir, `${opts.name}.png`);
  const ten = n === 10;
  await opts.lane.edit({
    prompt: opts.prompt ?? keyframeSheetPrompt(opts.moments),
    images: opts.images,
    width: ten ? ERA_BOARD_PX.width : cellPx * cols,
    height: ten ? ERA_BOARD_PX.height : cellPx * rows,
    seed: opts.seed ?? 42,
    outFile: board,
    recordJson: board.replace(/\.png$/, ".u15_edit.json"),
  });
  const size = await probePngSize(board);
  const cell = { w: Math.floor(size.width / cols), h: Math.floor(size.height / rows) };
  await opts.lane.cut(
    board,
    opts.moments.map((m, i) => ({
      file: m.file,
      x: (i % cols) * cell.w,
      y: Math.floor(i / cols) * cell.h,
      w: cell.w,
      h: cell.h,
    })),
  );
  return { board, cells: opts.moments.map((m) => m.file) };
}

export async function cutBoardCells(
  boardPng: string,
  cells: { file: string; x: number; y: number; w: number; h: number }[],
): Promise<void> {
  for (const c of cells) {
    const r = await runCommand("ffmpeg", [
      "-y", "-i", boardPng, "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y}`, "-frames:v", "1", c.file,
    ]);
    if (r.code !== 0) throw new Error(`ffmpeg crop failed for ${c.file}: ${r.stderr.slice(0, 300)}`);
  }
}

/** Top turnaround strip only. Half the sheet pulls the silhouette band into the mesh cell. */
export function turnaroundCrop(width: number, height: number, index: number): { x: number; y: number; w: number; h: number } {
  const stripW = Math.floor(width / BOARD_ANGLES.length);
  const stripH = Math.min(Math.floor(height / 2) - Math.floor(height * 0.04), Math.floor(stripW * 1.7));
  return { x: index * stripW, y: 0, w: stripW, h: Math.max(1, stripH) };
}

function cellName(base: string, angle: BoardAngle, suffix?: string): string {
  return suffix ? `${base}.${angle}.${suffix}.png` : `${base}.${angle}.png`;
}

export type BoardCellResult = {
  angle: BoardAngle;
  /** the RGBA 入庫 file (empty when the cell never went GREEN) */
  file: string;
  /** the RGB cut the QC sha is pinned to (kept for audit) */
  cutFile: string;
  pinned: boolean;
  status: string;
  fail_reasons: string[];
};
export type BoardResult = { board: string; cells: BoardCellResult[]; seed: number };

export type ProduceBoardOpts = {
  id: string;
  prompt: string;
  /** Image-1 (and onward) LOCAL paths: front portrait, old board, … */
  images: string[];
  /** where cells pin (portrait library / assets dir) — RGBA 入庫檔 */
  pinDir: string;
  /** where the WHOLE board lives (SHEETREF red line: never leaves here as a ref) */
  boardsDir: string;
  boardName: string;
  cellPx?: number;
  require: QcRequire;
  server?: string;
  seed?: number;
  /** 角色身份板：只切上方轉面帶四格入模。表情、手、配件留喺成張板。 */
  turnaroundStrip?: boolean;
  lane?: BoardLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
};

/** One board call → cut → per-cell QC on the RGB cut → rembg → RGBA 入庫.
 *  Zero-green cells throw upstream — a board nothing passed is a dead call,
 *  never a silent skip. */
export async function produceBoard(opts: ProduceBoardOpts): Promise<BoardResult> {
  const lane = opts.lane ?? liveBoardLane(opts.server ?? "");
  const cellPx = opts.cellPx ?? DEFAULT_CELL_PX;
  const width = cellPx * 2;
  const height = cellPx * 2;
  const seed = opts.seed ?? 42;
  fs.mkdirSync(opts.pinDir, { recursive: true });
  fs.mkdirSync(opts.boardsDir, { recursive: true });
  const board = path.join(opts.boardsDir, opts.boardName);
  await lane.edit({
    prompt: opts.prompt,
    images: opts.images,
    width,
    height,
    seed,
    outFile: board,
    recordJson: board.replace(/\.png$/, ".u15_edit.json"),
  });
  const size = await probePngSize(board);
  const half = { w: Math.floor(size.width / 2), h: Math.floor(size.height / 2) };
  const cells: BoardCellResult[] = [];
  for (const [i, angle] of BOARD_ANGLES.entries()) {
    const cutFile = path.join(opts.pinDir, cellName(opts.id, angle, "cut"));
    const crop = opts.turnaroundStrip
      ? turnaroundCrop(size.width, size.height, i)
      : { x: (i % 2) * half.w, y: Math.floor(i / 2) * half.h, w: half.w, h: half.h };
    await lane.cut(board, [{ file: cutFile, ...crop }]);
    const qcFile = cutFile.replace(/\.png$/, ".photo_qc.json");
    const verdict = await lane.qc(cutFile, qcFile, opts.require);
    const reasons = verdict.checks.fail_reasons ?? [];
    const backdropOnly = reasons.length > 0 && reasons.every((r) => /背景|plain_background/.test(r));
    const pinned = verdict.status === "GREEN" || backdropOnly;
    let file = "";
    if (pinned) {
      // 切格 → rembg → RGBA 入庫。背景色留喺 RGB cut，唔跟入透明板。
      file = path.join(opts.pinDir, cellName(opts.id, angle));
      await lane.rembg(cutFile, file);
    }
    cells.push({ angle, file, cutFile, pinned, status: verdict.status, fail_reasons: verdict.checks.fail_reasons });
    opts.onEvent?.(
      pinned ? `${opts.id} ${angle} 格 GREEN，rembg 後入庫` : `${opts.id} ${angle} 格未過：${verdict.checks.fail_reasons.join("; ") || "not GREEN"}`,
      { file, cutFile, pinned, board },
    );
  }
  return { board, cells, seed };
}

export type AngleBoardResult = { board: string; pinned: Record<BoardAngle, string>; made: BoardAngle[] };

function allPinned(dir: string, id: string): boolean {
  return BOARD_ANGLES.every((a) => {
    const rgba = path.join(dir, cellName(id, a));
    const cutQc = path.join(dir, cellName(id, a, "cut")).replace(/\.png$/, ".photo_qc.json");
    if (!fs.existsSync(rgba) || !fs.existsSync(cutQc)) return false;
    try {
      return (JSON.parse(fs.readFileSync(cutQc, "utf8")) as { status?: string }).status === "GREEN";
    } catch {
      return false;
    }
  });
}

function pinMap(outDir: string, id: string): Record<BoardAngle, string> {
  return Object.fromEntries(BOARD_ANGLES.map((a) => [a, path.join(outDir, cellName(id, a))])) as Record<BoardAngle, string>;
}

/** ① 多角度肖像板 per character: /edit Image-1 = the GREEN front portrait,
 *  four angle cells rembg→RGBA pin as {id}.{angle}.png beside it. Resume:
 *  all four GREEN-pinned → skip. Zero GREEN after two seeds → throw (never a
 *  silent half-set; unpinned angles simply stay absent for consumers' gates). */
export async function ensureAngleBoard(opts: {
  character: Character;
  /** the GREEN front portrait (identity anchor for Image-1) */
  frontPng: string;
  outDir: string;
  server?: string;
  seed?: number;
  cellPx?: number;
  sheet: { styleBible: { grade: string } };
  lane?: BoardLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<AngleBoardResult> {
  const id = opts.character.id;
  if (allPinned(opts.outDir, id)) {
    opts.onEvent?.(`${id} 四角度肖像已齊（GREEN pin 照舊，唔重板）`, {});
    return { board: path.join(opts.outDir, "boards", `${id}.angles.png`), pinned: pinMap(opts.outDir, id), made: [] };
  }
  if (!fs.existsSync(opts.frontPng)) throw new Error(`${id}: 角度板要 Image-1 正面肖像，但 ${opts.frontPng} 唔存在`);
  let last = "";
  for (const trySeed of [opts.seed ?? 42, (opts.seed ?? 42) + 1]) {
    const res = await produceBoard({
      id,
      prompt: angleBoardPrompt(opts.character, opts.sheet),
      images: [opts.frontPng],
      pinDir: opts.outDir,
      boardsDir: path.join(opts.outDir, "boards"),
      boardName: `${id}.angles.png`,
      cellPx: opts.cellPx,
      require: PORTRAIT_BOARD_REQUIRE,
      server: opts.server,
      seed: trySeed,
      turnaroundStrip: true,
      lane: opts.lane,
      onEvent: opts.onEvent,
    });
    const made = res.cells.filter((c) => c.pinned).map((c) => c.angle);
    if (made.includes("front")) return { board: res.board, pinned: pinMap(opts.outDir, id), made };
    last = res.cells.map((c) => `${c.angle}:${c.fail_reasons.join("; ") || c.status}`).join(" | ");
  }
  throw new Error(`${id} 角度板兩次都冇正面全身格（seeds ${opts.seed ?? 42},${(opts.seed ?? 42) + 1}）：${last}`);
}

/** ② 換衫板: Image-1 = the existing angle board; one call re-dresses all four
 *  angles. ALL four cells must pin (a half-swapped set is a broken asset) —
 *  two seeds, then throw. */
export async function swapWardrobeBoard(opts: {
  character: Character;
  wardrobe: string;
  outDir: string;
  server?: string;
  seed?: number;
  cellPx?: number;
  lane?: BoardLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<AngleBoardResult> {
  const id = opts.character.id;
  const board = path.join(opts.outDir, "boards", `${id}.angles.png`);
  if (!fs.existsSync(board)) throw new Error(`${id}: 換衫板要現有多角度板做 Image-1，但 ${board} 唔存在（先行 ensureAngleBoard）`);
  let last = "";
  for (const trySeed of [opts.seed ?? 42, (opts.seed ?? 42) + 1]) {
    const res = await produceBoard({
      id,
      prompt: wardrobeSwapBoardPrompt(opts.character, opts.wardrobe),
      images: [board],
      pinDir: opts.outDir,
      boardsDir: path.join(opts.outDir, "boards"),
      boardName: `${id}.angles.png`,
      cellPx: opts.cellPx,
      require: PORTRAIT_BOARD_REQUIRE,
      server: opts.server,
      seed: trySeed,
      turnaroundStrip: true,
      lane: opts.lane,
      onEvent: opts.onEvent,
    });
    const made = res.cells.filter((c) => c.pinned).map((c) => c.angle);
    if (made.length === BOARD_ANGLES.length) return { board: res.board, pinned: pinMap(opts.outDir, id), made };
    last = res.cells.map((c) => `${c.angle}:${c.fail_reasons.join("; ") || c.status}`).join(" | ");
  }
  throw new Error(`${id} 換衫板兩次都換唔齊四角度（seeds ${opts.seed ?? 42},${(opts.seed ?? 42) + 1}）：${last}`);
}

function slug(name: string): string {
  return name.trim().replace(/[\s/\\]+/g, "-");
}

/** ③ 道具板: chunks of 4 (2×2); every prop cell QC→rembg→RGBA pins into
 *  assets/ — the batch asset entry. people_count 0: a prop shot has no people.
 *  All props must pin (asset batch = fail loud, never a partial shelf). */
export async function ensurePropBoard(opts: {
  props: ShotProp[];
  assetsDir: string;
  server?: string;
  seed?: number;
  cellPx?: number;
  lane?: BoardLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<{ pinned: string[]; boards: string[] }> {
  if (!opts.props.length) throw new Error("道具板：props 空，冇嘢好批量");
  const lane = opts.lane ?? liveBoardLane(opts.server ?? "");
  const cellPx = opts.cellPx ?? DEFAULT_CELL_PX;
  const seed = opts.seed ?? 42;
  const boardsDir = path.join(opts.assetsDir, "boards");
  fs.mkdirSync(opts.assetsDir, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });
  const pinned: string[] = [];
  const boards: string[] = [];
  for (const [chunk, props] of chunked(opts.props, 10).entries()) {
    const rows = Math.ceil(props.length / 2);
    const board = path.join(boardsDir, `props-${String(chunk + 1).padStart(2, "0")}.png`);
    boards.push(board);
    await lane.edit({
      prompt: propBoardPrompt(props),
      images: [],
      width: cellPx * 2,
      height: cellPx * rows,
      seed,
      outFile: board,
      recordJson: board.replace(/\.png$/, ".u15_edit.json"),
    });
    const size = await probePngSize(board);
    const cell = { w: Math.floor(size.width / 2), h: Math.floor(size.height / rows) };
    for (const [i, prop] of props.entries()) {
      const cutFile = path.join(opts.assetsDir, `${String(chunk * 10 + i + 1).padStart(2, "0")}-${slug(prop.name)}.cut.png`);
      await lane.cut(board, [{ file: cutFile, x: (i % 2) * cell.w, y: Math.floor(i / 2) * cell.h, w: cell.w, h: cell.h }]);
      const qcFile = cutFile.replace(/\.png$/, ".photo_qc.json");
      const verdict = await lane.qc(cutFile, qcFile, PROP_BOARD_REQUIRE);
      if (verdict.status !== "GREEN") {
        throw new Error(`道具 ${prop.name} 板格未過盲眼（${verdict.checks.fail_reasons.join("; ") || "not GREEN"}）— assets 唔收未過格`);
      }
      const file = cutFile.replace(/\.cut\.png$/, ".png");
      await lane.rembg(cutFile, file);
      pinned.push(file);
      opts.onEvent?.(`道具 ${prop.name} GREEN，rembg 後入 assets`, { file, cutFile, board });
    }
  }
  return { pinned, boards };
}

/** 建築板: one era, N types, cut cells pin into assets/scenes/ as Blender
 *  look-dev references. Ten types use the 4096×5760 sheet. */
export async function ensureSceneBoard(opts: {
  era: string;
  types: string[];
  assetsDir: string;
  server?: string;
  seed?: number;
  cellPx?: number;
  lane?: BoardLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<{ cells: string[]; manifest: string }> {
  if (!opts.types.length) throw new Error("建築板：types 空");
  const lane = opts.lane ?? liveBoardLane(opts.server ?? "");
  const cellPx = opts.cellPx ?? DEFAULT_CELL_PX;
  const seed = opts.seed ?? 42;
  const rows = Math.ceil(opts.types.length / 2);
  const scenesDir = path.join(opts.assetsDir, "scenes");
  const boardsDir = path.join(opts.assetsDir, "boards");
  fs.mkdirSync(scenesDir, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });
  const board = path.join(boardsDir, `scene-${slug(opts.era)}.png`);
  const ten = opts.types.length === 10;
  await lane.edit({
    prompt: sceneBoardPrompt({ era: opts.era, types: opts.types }),
    images: [],
    width: ten ? ERA_BOARD_PX.width : cellPx * 2,
    height: ten ? ERA_BOARD_PX.height : cellPx * rows,
    seed,
    outFile: board,
    recordJson: board.replace(/\.png$/, ".u15_edit.json"),
  });
  const size = await probePngSize(board);
  const cell = { w: Math.floor(size.width / 2), h: Math.floor(size.height / rows) };
  const cells: string[] = [];
  for (const [i, type] of opts.types.entries()) {
    const cutFile = path.join(scenesDir, `${slug(opts.era)}.${slug(type)}.cut.png`);
    await lane.cut(board, [{ file: cutFile, x: (i % 2) * cell.w, y: Math.floor(i / 2) * cell.h, w: cell.w, h: cell.h }]);
    const file = cutFile.replace(/\.cut\.png$/, ".png");
    await lane.rembg(cutFile, file);
    cells.push(file);
    opts.onEvent?.(`建築格 ${opts.era}${type} rembg 後入 Blender look-dev 參考`, { file, cutFile, board });
  }
  const manifest = path.join(scenesDir, `${slug(opts.era)}.lookdev.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        purpose: "blender-lookdev",
        era: opts.era,
        redline:
          "切出的格係白模外觀參考。Blender 照板起模，唔好自己造世界，亦唔好把樓畫進 still。",
        board,
        cells,
      },
      null,
      2,
    ),
  );
  return { cells, manifest };
}

function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
