import fs from "node:fs";
import path from "node:path";
import { runCommand } from "./audio";
import type { Character, ShotProp } from "./types";
import { buildEditPayload, checkHealth, u15Edit, type EditHealth } from "./u15-edit";
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
 *  - 分鏡動作板 → storyboard/pre-vis layer, kept whole, never cut into refs.
 *  SHEETREF red line: the WHOLE board is a production-stage artifact only —
 *  it lives in boards/ and is never pinned as a ref, never fed to H3. */

export type BoardAngle = "front" | "45" | "side" | "back";
export const BOARD_ANGLES: BoardAngle[] = ["front", "45", "side", "back"];
const ANGLE_SPEC: Record<BoardAngle, string> = {
  front: "正面全身企直",
  "45": "四十五度角全身",
  side: "正側面全身",
  back: "背面全身",
};

/** each cut cell is 2304×2304-class by default → board 4608×4608 (snap32 clean) */
export const DEFAULT_CELL_PX = 2304;
export const PORTRAIT_BOARD_REQUIRE: QcRequire = { people_count: 1, grey_blocks: false };
export const PROP_BOARD_REQUIRE: QcRequire = { people_count: 0, grey_blocks: false };

/** 底色標準：純白 flat 底 — keyable, never 攝影棚灰（W4B：負面底色句剷走，正寫） */
const FLAT_WHITE_BG = "背景：純白flat底（#FFFFFF），零漸變、零陰影、零地台，主體無陰影無倒影。";

/** the 版式規格式 grammar every asset board shares (0921-night verified).
 *  W4C：角標數字＋黑框唔准入資產板——燒入cell會跟rembg RGBA pin落庫
 *  （WGTT A.front.cut.png實證「01」+黑框+雙sub-panel）；幼白間隔線留（cut對位靠佢）。 */
export function layoutClause(count: number): string {
  return [
    `整體版式：嚴格採用2列×${Math.ceil(count / 2)}行宮格布局（單張圖嚴格包含${count}個畫面）；`,
    `${count}格尺寸嚴格一致、邊緣對齊、間距統一；每格用幼白色間隔線分隔。`,
  ].join("");
}

/** 分鏡板（閱讀用、成張保留唔切割入庫）先准有角標＋黑框 — asset boards never. */
function numberedLayoutClause(count: number): string {
  return [
    `整體版式：嚴格採用2列×${Math.ceil(count / 2)}行宮格布局（單張圖嚴格包含${count}個畫面）；`,
    `${count}格尺寸嚴格一致、邊緣對齊、間距統一；每格用幼白色間隔線同黑色邊框分隔；`,
    `每格左上角依次標注${Array.from({ length: count }, (_, i) => String(i + 1).padStart(2, "0")).join("、")}清晰正確。`,
  ].join("");
}

/** 2×2 切格次序＝左上→右上→左下→右下（cut 同序）；資產板用方位點名，唔用數字 */
const QUADRANTS = ["左上格", "右上格", "左下格", "右下格"] as const;

/** W4B (0921 Chau釘)：模型係literal spec-follower，負面內容token照入燃料
 *  （「禁止打鬥」＝注入打鬥）——內容類negative全剷，格式項一律正面寫法。 */
const QUALITY_CLAUSE = "文字清晰正確、畫面乾淨、寫實風格、版式工整。";

/** ① 多角度肖像板 — /edit with the GREEN front portrait as Image-1 (ref-driven
 *  identity), four 全身 angles of the SAME character. T43：sheet rides for call
 *  shape but is never read——world grade 永遠唔入肖像ref（同純白flat底自相矛盾，
 *  WGTT A.angles 青綠邊光怪種實證）。 */
export function angleBoardPrompt(character: Character, sheet?: { styleBible: { grade: string } }): string {
  const cells = BOARD_ANGLES.map((a, i) => `${QUADRANTS[i]}${ANGLE_SPEC[a]}`).join("、");
  return [
    `【編輯】Image-1係角色${character.name}嘅正面參考圖（${character.wardrobe}）。`,
    `保持同一個人嘅面容、髮型、體形同服裝完全一致。出一張專業角色多角度設定板，`,
    `${layoutClause(BOARD_ANGLES.length)}四格分別係同一個角色嘅：${cells}。`,
    `同一個角色跨格面容髮型服裝完全一致。${FLAT_WHITE_BG}`,
    `風格：寫實電影級角色設定參考圖。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** ② 換衫板 — /edit with the EXISTING angle board as Image-1; one board swaps
 *  the wardrobe on all four angles, geometry untouched. */
export function wardrobeSwapBoardPrompt(character: Character, wardrobe: string): string {
  return [
    `【編輯】Image-1係同一個角色${character.name}嘅四角度設定板（左上格正面、右上格四十五度角、左下格正側面、右下格背面）。`,
    `將四格入面角色嘅衫著全部換做：${wardrobe}。`,
    `四格嘅角度、構圖、企姿照Image-1原樣保留；面容、髮型、體形同Image-1一致，只換衫。`,
    `版式照舊：${layoutClause(BOARD_ANGLES.length)}${FLAT_WHITE_BG}`,
    `四格全部完成換衫，${QUALITY_CLAUSE}`,
  ].join("");
}

/** ③ 道具板 — one board, N props, each cell one prop centred (batch asset entry). */
export function propBoardPrompt(props: ShotProp[]): string {
  const cells = props
    .map((p, i) => `${QUADRANTS[i]}${p.name}（${p.shape.join("、")}），一件完整居中擺放`)
    .join("；\n");
  return [
    `生成一張專業道具設定板，${layoutClause(props.length)}`,
    `${props.length}格內容（每格一件道具，居中擺放，純道具靜物）：\n${cells}。`,
    `${FLAT_WHITE_BG}風格：寫實電影級道具設定參考圖。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** 場景/建築板 — same grammar on the flat-white standard; cells are Blender
 *  look-dev references, never still refs (分流 law). nouns ride in from the
 *  caller, never authored here. */
export function sceneBoardPrompt(opts: { name: string; desc: string; grade: string }): string {
  return [
    `生成一張專業建築／場景設定板，${layoutClause(4)}`,
    `四格內容（同一個場景「${opts.name}」，跨格建築結構、陳設、材質完全一致）：`,
    `左上格廣角全景；右上格中景視角；左下格立面／結構細節；右下格反打角度。場景內容：${opts.desc}。`,
    `${FLAT_WHITE_BG}風格：寫實電影級建築設定參考圖${opts.grade.trim() ? `，${opts.grade.trim()}` : ""}。`,
    QUALITY_CLAUSE,
  ].join("");
}

/** 分鏡動作板 prompt — storyboard/pre-vis layer (前期全覽). Kept WHOLE; this
 *  module never cuts it into refs, and it is not an asset board (no flat-white
 *  clause — the frame content is the scene itself). */
export function storyboardBoardPrompt(opts: { cells: string[]; style: string }): string {
  const numbered = opts.cells.map((c, i) => `${String(i + 1).padStart(2, "0")} — ${c}`).join("；\n");
  return [
    `生成一張專業分鏡板，${numberedLayoutClause(opts.cells.length)}`,
    `${opts.cells.length}格內容（同一個角色，跨格面容服裝完全一致）：\n${numbered}。`,
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

/** rembg CLI (u2net) — RGB cut in, RGBA png out. Fail loud: a missing rembg
 *  means 底色殘留 in the library, never a silent skip. */
export async function rembgCell(input: string, output: string): Promise<void> {
  const r = await runCommand("rembg", ["i", input, output]);
  if (r.code !== 0) throw new Error(`rembg failed for ${input}: ${r.stderr.slice(0, 300)}`);
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
    await lane.cut(board, [{ file: cutFile, x: (i % 2) * half.w, y: Math.floor(i / 2) * half.h, w: half.w, h: half.h }]);
    const qcFile = cutFile.replace(/\.png$/, ".photo_qc.json");
    const verdict = await lane.qc(cutFile, qcFile, opts.require);
    const pinned = verdict.status === "GREEN";
    let file = "";
    if (pinned) {
      // 切格 → rembg → RGBA 入庫 (the QC sha stays on the RGB cut for audit)
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
      lane: opts.lane,
      onEvent: opts.onEvent,
    });
    const made = res.cells.filter((c) => c.pinned).map((c) => c.angle);
    if (made.length > 0) return { board: res.board, pinned: pinMap(opts.outDir, id), made };
    last = res.cells.map((c) => `${c.angle}:${c.fail_reasons.join("; ") || c.status}`).join(" | ");
  }
  throw new Error(`${id} 角度板兩次都零格 GREEN（seeds ${opts.seed ?? 42},${(opts.seed ?? 42) + 1}）：${last}`);
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
  for (const [chunk, props] of chunked(opts.props, 4).entries()) {
    const board = path.join(boardsDir, `props-${String(chunk + 1).padStart(2, "0")}.png`);
    boards.push(board);
    await lane.edit({
      prompt: propBoardPrompt(props),
      images: [],
      width: cellPx * 2,
      height: cellPx * 2,
      seed,
      outFile: board,
      recordJson: board.replace(/\.png$/, ".u15_edit.json"),
    });
    const size = await probePngSize(board);
    const half = { w: Math.floor(size.width / 2), h: Math.floor(size.height / 2) };
    for (const [i, prop] of props.entries()) {
      const cutFile = path.join(opts.assetsDir, `${String(chunk * 4 + i + 1).padStart(2, "0")}-${slug(prop.name)}.cut.png`);
      await lane.cut(board, [{ file: cutFile, x: (i % 2) * half.w, y: Math.floor(i / 2) * half.h, w: half.w, h: half.h }]);
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

/** 場景/建築板: cells QC→rembg→RGBA pin into assets/scenes/ as Blender
 *  look-dev references (照板起模／外觀 look) + a manifest carrying the 分流
 *  red line. The normal path resumes AFTER look-dev: blockout real scene →
 *  U1.5 /edit keyframe → H3. */
export async function ensureSceneBoard(opts: {
  name: string;
  desc: string;
  grade: string;
  assetsDir: string;
  server?: string;
  seed?: number;
  cellPx?: number;
  lane?: BoardLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<{ cells: string[]; manifest: string }> {
  const lane = opts.lane ?? liveBoardLane(opts.server ?? "");
  const cellPx = opts.cellPx ?? DEFAULT_CELL_PX;
  const seed = opts.seed ?? 42;
  const scenesDir = path.join(opts.assetsDir, "scenes");
  const boardsDir = path.join(opts.assetsDir, "boards");
  fs.mkdirSync(scenesDir, { recursive: true });
  fs.mkdirSync(boardsDir, { recursive: true });
  const board = path.join(boardsDir, `scene-${slug(opts.name)}.png`);
  await lane.edit({
    prompt: sceneBoardPrompt({ name: opts.name, desc: opts.desc, grade: opts.grade }),
    images: [],
    width: cellPx * 2,
    height: cellPx * 2,
    seed,
    outFile: board,
    recordJson: board.replace(/\.png$/, ".u15_edit.json"),
  });
  const size = await probePngSize(board);
  const half = { w: Math.floor(size.width / 2), h: Math.floor(size.height / 2) };
  const cells: string[] = [];
  for (const [i, label] of ["wide", "mid", "detail", "reverse"].entries()) {
    const cutFile = path.join(scenesDir, `${slug(opts.name)}.${label}.cut.png`);
    await lane.cut(board, [{ file: cutFile, x: (i % 2) * half.w, y: Math.floor(i / 2) * half.h, w: half.w, h: half.h }]);
    const file = cutFile.replace(/\.cut\.png$/, ".png");
    await lane.rembg(cutFile, file);
    cells.push(file);
    opts.onEvent?.(`場景格 ${label} rembg 後入 Blender look-dev 參考`, { file, cutFile, board });
  }
  const manifest = path.join(scenesDir, `${slug(opts.name)}.lookdev.json`);
  fs.writeFileSync(
    manifest,
    JSON.stringify(
      {
        purpose: "blender-lookdev",
        redline:
          "場景/建築板只係 Blender 白模資產參考（照板起模／外觀 look），唔入 still refs，唔准成張餵 H3；正路 = blockout真場景 → U1.5 /edit keyframe still → H3。",
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
