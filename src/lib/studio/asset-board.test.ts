import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { runCommand } from "./audio";
import { QC_FORMULA, photoQcEyesFromEnv } from "./photo-qc";
import { liveLane } from "./portraits";
import type { Character, ShotProp } from "./types";
import {
  DEFAULT_CELL_PX,
  PORTRAIT_BOARD_REQUIRE,
  angleBoardPrompt,
  turnaroundCrop,
  ensureAngleBoard,
  chunkMomentSheets,
  chunkFrameMoments,
  fullFrameMoments,
  ensureKeyframeSheet,
  ensurePropBoard,
  ensureSceneBoard,
  keyframeSheetPrompt,
  liveBoardLane,
  momentsForShot,
  produceBoard,
  propBoardPrompt,
  sceneBoardPrompt,
  storyboardBoardPrompt,
  swapWardrobeBoard,
  wardrobeSwapBoardPrompt,
  type BoardLane,
} from "./asset-board";

/** One file, three doors (store.test.ts idiom). */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

/** W4 批量資產板：one /edit board → strict 2×2 → ffmpeg cut → per-cell QC →
 *  rembg → RGBA 入庫. Real ffmpeg/ffprobe run in here (small 64×64 fixtures,
 *  fast); only the U1.5 wire and the eye are faked. */

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "asset-board-"));
}

async function makePng(file: string, size: number, color: string, rgba = false) {
  const pix = rgba ? "-pix_fmt" : "";
  const args = ["-y", "-f", "lavfi", "-i", `color=c=${color}:s=${size}x${size}`, "-frames:v", "1"];
  if (rgba) args.push(pix, "rgba");
  args.push(file);
  const r = await runCommand("ffmpeg", args);
  if (r.code !== 0) throw new Error(`fixture png failed: ${r.stderr.slice(0, 200)}`);
}

async function pngInfo(file: string) {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height,pix_fmt", "-of", "json", file,
  ]);
  assert.equal(r.code, 0, r.stderr);
  const st = (JSON.parse(r.stdout).streams ?? [])[0] as { width: number; height: number; pix_fmt: string };
  return st;
}

const CHAR: Character = {
  id: "A",
  name: "角色一",
  role: "主角",
  wardrobe: "深色軍裝",
  palette: ["#111111", "#222222", "#333333"],
  voice: { pitchHz: 190, gender: "m" },
};

const PROPS: ShotProp[] = [
  { name: "軍大衣", heldBy: "A", shape: ["披", "肩"], forbid: ["木犁"] },
  { name: "通緝令", shape: ["紙", "字"], forbid: ["木犁"] },
  { name: "鐵犁", shape: ["木柄", "鐵鏵"], forbid: ["長槍"] },
  { name: "長槍", shape: ["木托", "槍管"], forbid: ["鐵犁"] },
];

type EditWire = { prompt: string; images: string[]; width: number; height: number; seed: number };

/** fake the U1.5 wire with a real 64×64 board png; cut/qc/rembg seams are real
 *  ffmpeg/ffprobe so the geometry and alpha locks bite. */
function fakeLane(opts: { boardSize?: number; qc?: (png: string, call: number) => "GREEN" | "FAIL" } = {}): {
  lane: BoardLane;
  edits: EditWire[];
  qcCalls: { png: string; require: unknown }[];
  boardSize: number;
} {
  const boardSize = opts.boardSize ?? 64;
  const edits: EditWire[] = [];
  const qcCalls: { png: string; require: unknown }[] = [];
  let qcCount = 0;
  const lane: BoardLane = {
    edit: async (o) => {
      edits.push({ prompt: o.prompt, images: o.images, width: o.width, height: o.height, seed: o.seed });
      await makePng(o.outFile, boardSize, "gray");
    },
    qc: async (png, outJson, require) => {
      qcCount += 1;
      qcCalls.push({ png, require });
      const verdict = opts.qc ? opts.qc(png, qcCount) : "GREEN";
      fs.writeFileSync(outJson, JSON.stringify({ tool: "slatecrew.photo_qc", status: verdict, checks: { status: verdict, fail_reasons: verdict === "GREEN" ? [] : ["fixture fail"] } }));
      return { status: verdict, checks: { status: verdict, fail_reasons: verdict === "GREEN" ? [] : ["fixture fail"] } };
    },
    cut: async (boardPng, cells) => {
      for (const c of cells) {
        const r = await runCommand("ffmpeg", ["-y", "-i", boardPng, "-vf", `crop=${c.w}:${c.h}:${c.x}:${c.y}`, "-frames:v", "1", c.file]);
        assert.equal(r.code, 0, r.stderr);
      }
    },
    rembg: async (input, output) => {
      // real RGBA conversion — the alpha lock below bites on real bytes
      const r = await runCommand("ffmpeg", ["-y", "-i", input, "-pix_fmt", "rgba", output]);
      assert.equal(r.code, 0, r.stderr);
    },
  };
  return { lane, edits, qcCalls, boardSize };
}

async function seedBoard(dir: string, name = "A.angles.png", size = 64) {
  fs.mkdirSync(path.join(dir, "boards"), { recursive: true });
  const board = path.join(dir, "boards", name);
  await makePng(board, size, "gray");
  return board;
}

test("W4 角度板：one /edit call → 4 cut cells 2×2（front/45/side/back），wire 板面 4608×4608（2304×2304級）", async () => {
  const dir = tmp();
  const front = path.join(dir, "A.png");
  await makePng(front, 32, "red");
  const { lane, edits } = fakeLane({ boardSize: 64 });
  const res = await produceBoard({
    id: "A",
    prompt: angleBoardPrompt(CHAR, { styleBible: { grade: "冷青低飽和" } }),
    images: [front],
    pinDir: dir,
    boardsDir: path.join(dir, "boards"),
    boardName: "A.angles.png",
    require: PORTRAIT_BOARD_REQUIRE,
    lane,
  });

  assert.equal(edits.length, 1, "one board = one /edit call");
  assert.equal(edits[0]!.width, DEFAULT_CELL_PX * 2, "板面＝2×2304");
  assert.equal(edits[0]!.height, DEFAULT_CELL_PX * 2);
  assert.deepEqual(edits[0]!.images, [front], "Image-1 係正面肖像（ref驅動保身份）");

  assert.equal(res.cells.length, 4, "切格數＝4");
  assert.deepEqual(res.cells.map((c) => c.angle), ["front", "45", "side", "back"]);
  for (const c of res.cells) {
    const info = await pngInfo(c.cutFile);
    assert.equal(info.width, 32, "cell = board/2");
    assert.equal(info.height, 32);
    assert.equal(c.pinned, true);
    assert.ok(fs.existsSync(c.file), `RGBA 入庫 ${c.file}`);
    const rgba = await pngInfo(c.file);
    assert.equal(rgba.pix_fmt, "rgba", `rembg 輸出 RGBA＋alpha 通道存在（${c.angle}）`);
    assert.ok(fs.existsSync(c.cutFile), "RGB cut 保留（QC sha 企喺度）");
    assert.ok(fs.existsSync(c.cutFile.replace(/\.png$/, ".photo_qc.json")), "逐張 QC json");
  }
  // SHEETREF red line: the whole board never leaves boards/ as a pin
  const pinPaths = res.cells.map((c) => c.file);
  assert.ok(pinPaths.every((p) => !p.includes("boards")), "釘嘅係切格，唔係成張板");
  assert.ok(fs.existsSync(path.join(dir, "boards", "A.angles.png")), "成張板只住 boards/");
});

test("轉面帶只切頂條，半張會切到下面嘅剪影帶", () => {
  const crop = turnaroundCrop(4608, 4608, 0);
  assert.equal(crop.y, 0);
  assert.equal(crop.w, 1152);
  assert.ok(crop.h < 2064);
  assert.ok(crop.h > 1600);
});

test("W4 角度板 prompt：版式規格式＋跨格一致＋純白flat底；grade同角標黑框唔准入肖像板（W4C）", () => {
  const p = angleBoardPrompt(CHAR, { styleBible: { grade: "冷青低飽和" } });
  for (const need of ["只出一張", "成張未切嘅板就係呢套片嘅角色參考", "上方一條嚴格四等分", "正面全身企直", "背面全身", "幼白色間隔線", "剪影", "表情八種", "微表情", "頭部多角度", "面部特寫", "姿勢三個", "手部動作", "色板", "純白flat底（#FFFFFF）", "表情、手、配件特寫只留喺成張板上"]) {
    assert.ok(p.includes(need), `prompt 缺 ${need}`);
  }
  assert.ok(!/純色淺灰|淺灰攝影棚/.test(p), "唔准灰底（難key）");
  assert.ok(!p.includes("冷青低飽和"), "T43/W4C：world grade 永遠唔入肖像板");
  for (const ban of ["黑色邊框", "左上角", "01、02", "禁止"]) {
    assert.ok(!p.includes(ban), `資產板唔准有「${ban}」（燒入cell跟rembg落庫／負面token入燃料）`);
  }
});

test("W4 逐張QC：FAIL 格唔入庫（RGBA 缺席），其餘格照釘；零 GREEN 兩 seed 後 throw", async () => {
  const dir = tmp();
  const front = path.join(dir, "A.png");
  await makePng(front, 32, "red");
  const { lane } = fakeLane({
    qc: (_png, call) => (call === 2 ? "FAIL" : "GREEN"), // 02 = 45° 格未過
  });
  const res = await produceBoard({
    id: "A",
    prompt: angleBoardPrompt(CHAR, { styleBible: { grade: "" } }),
    images: [front],
    pinDir: dir,
    boardsDir: path.join(dir, "boards"),
    boardName: "A.angles.png",
    require: PORTRAIT_BOARD_REQUIRE,
    lane,
  });
  const byAngle = Object.fromEntries(res.cells.map((c) => [c.angle, c]));
  assert.equal(byAngle["45"]!.pinned, false, "FAIL 格唔入庫");
  assert.equal(fs.existsSync(byAngle["45"]!.file), false, "RGBA 缺席");
  assert.ok(fs.existsSync(byAngle["45"]!.cutFile), "cut 留底俾盲眼覆盤");
  assert.ok(fs.existsSync(byAngle.front!.file) && fs.existsSync(byAngle.back!.file), "其餘格照釘");

  // zero GREEN on both seeds → ensureAngleBoard throws
  const dead = fakeLane({ qc: () => "FAIL" });
  await assert.rejects(
    () =>
      ensureAngleBoard({
        character: CHAR,
        frontPng: front,
        outDir: path.join(dir, "cast"),
        sheet: { styleBible: { grade: "" } },
        lane: dead.lane,
      }),
    /冇正面全身格/,
  );
  assert.equal(dead.edits.length, 2, "兩個 seed 都試過先准死");
});

test("W4 角度板 resume：四角度 GREEN pin 已齊就唔重板", async () => {
  const dir = tmp();
  const front = path.join(dir, "A.png");
  await makePng(front, 32, "red");
  const first = fakeLane();
  await ensureAngleBoard({ character: CHAR, frontPng: front, outDir: dir, sheet: { styleBible: { grade: "" } }, lane: first.lane });
  assert.equal(first.edits.length, 1);

  const again = fakeLane();
  const res = await ensureAngleBoard({ character: CHAR, frontPng: front, outDir: dir, sheet: { styleBible: { grade: "" } }, lane: again.lane });
  assert.equal(again.edits.length, 0, "已齊＝零 wire");
  assert.equal(res.made.length, 0);
  assert.ok(fs.existsSync(res.pinned["45"]));
});

test("W4 換衫板：Image-1＝現有板，一板過換晒四角度（全部 GREEN 先准收）", async () => {
  const dir = tmp();
  await seedBoard(dir);
  // seed the four RGBA pins so swap has something to overwrite
  const seed = fakeLane();
  await ensureAngleBoard({ character: CHAR, frontPng: path.join(dir, "seed-front.png"), outDir: dir, sheet: { styleBible: { grade: "" } }, lane: seed.lane }).catch(
    () => {}, // seed front missing is fine — write pins by hand below
  );
  for (const a of ["front", "45", "side", "back"]) await makePng(path.join(dir, `A.${a}.png`), 32, "blue", true);

  const { lane, edits } = fakeLane();
  const res = await swapWardrobeBoard({ character: CHAR, wardrobe: "白色禮服", outDir: dir, lane });
  assert.equal(edits.length, 1);
  assert.ok(edits[0]!.images[0]!.includes("boards"), "Image-1 係現有多角度板");
  assert.match(edits[0]!.prompt, /白色禮服/);
  assert.match(edits[0]!.prompt, /只換衫/);
  assert.equal(res.made.length, 4, "四角度一板過");
  for (const a of ["front", "45", "side", "back"]) {
    const info = await pngInfo(res.pinned[a as "front"]);
    assert.equal(info.pix_fmt, "rgba", `換衫後 ${a} 仍係 RGBA 入庫`);
  }

  // missing board → throw before any wire
  const nowhere = tmp();
  await assert.rejects(
    () => swapWardrobeBoard({ character: CHAR, wardrobe: "x", outDir: nowhere, lane: fakeLane().lane }),
    /先行 ensureAngleBoard/,
  );
});

test("W4 道具板：4 props 一板四格入 assets/，6 props 同一張板再切；逐格 QC people_count=0；FAIL 即死", async () => {
  const dir = tmp();
  const { lane, edits, qcCalls } = fakeLane();
  const res = await ensurePropBoard({ props: PROPS, assetsDir: dir, lane });
  assert.equal(edits.length, 1);
  assert.equal(res.pinned.length, 4);
  for (const [i, f] of res.pinned.entries()) {
    assert.ok(!f.includes("cut"), `入庫檔唔帶 .cut：${f}`);
    assert.ok(fs.existsSync(f), f);
    const rgba = await pngInfo(f);
    assert.equal(rgba.pix_fmt, "rgba");
    assert.ok(fs.existsSync(res.pinned[i]!.replace(/\.png$/, ".cut.png")), "RGB cut 留底");
  }
  assert.match(path.basename(res.pinned[0]!), /^01-軍大衣\.png$/);
  assert.equal(qcCalls.every((c) => (c.require as { people_count: number }).people_count === 0), true, "道具格 people_count 0");

  // 6 props → one board (chunk of 10)
  const six = [...PROPS, { name: "斗篷", shape: ["披"], forbid: [] as string[] }, { name: "燈籠", shape: ["紙", "竹"], forbid: [] as string[] }];
  const dir2 = tmp();
  const two = fakeLane();
  const res6 = await ensurePropBoard({ props: six, assetsDir: dir2, lane: two.lane });
  assert.equal(two.edits.length, 1, "6 props＝一板");
  assert.equal(res6.pinned.length, 6);

  // a FAIL prop kills the shelf (fail loud, never a partial asset set)
  const dir3 = tmp();
  const killer = fakeLane({ qc: (_png, call) => (call === 3 ? "FAIL" : "GREEN") });
  await assert.rejects(() => ensurePropBoard({ props: PROPS, assetsDir: dir3, lane: killer.lane }), /鐵犁 板格未過盲眼/);
});

test("W4 道具/場景板 prompt：純白flat底＋純道具靜物／跨格一致；內容negative掃除（W4B）", () => {
  const p = propBoardPrompt(PROPS);
  assert.ok(p.includes("純白flat底（#FFFFFF）") && !/純色淺灰|淺灰攝影棚/.test(p));
  assert.ok(!p.includes("禁止"), "W4B：負面token照入燃料，全正面寫法");
  assert.ok(p.includes("每格一件道具，居中擺放，純道具靜物"));
  assert.ok(p.includes("左上格軍大衣") && p.includes("右下格長槍"), "方位點名代替數字");

  const types = ["城門", "宮殿", "民居", "兵營"];
  const s = sceneBoardPrompt({ era: "秦代", types });
  assert.ok(s.includes("2列×2行") && s.includes("左上格秦代城門"));
  assert.ok(!s.includes("黑色邊框") && !s.includes("左上角") && !s.includes("禁止"), "資產板無角標黑框無negative");
  assert.ok(s.includes("純白flat底（#FFFFFF）"), "建築板照透明資產底色標準");
  assert.match(s, /秦代/);
  assert.ok(!/漢代|現代|唐代/.test(s), "只點同一代");
  const ten = sceneBoardPrompt({
    era: "秦代",
    types: ["城門", "宮殿", "民居", "兵營", "倉廩", "市肆", "官署", "闕樓", "亭", "塢壁"],
  });
  assert.ok(ten.includes("2列×5行") && ten.includes("全部係秦代"));
});

test("W4 場景板分流：cells 入 assets/scenes/ 做 Blender look-dev（唔入 still refs），manifest 帶紅線", async () => {
  const dir = tmp();
  const { lane } = fakeLane();
  const res = await ensureSceneBoard({
    era: "秦代",
    types: ["城門", "宮殿", "民居", "兵營"],
    assetsDir: dir,
    lane,
  });
  assert.equal(res.cells.length, 4);
  for (const c of res.cells) {
    assert.ok(c.includes(`${path.sep}scenes${path.sep}`), `cells 住 assets/scenes/：${c}`);
    assert.ok(!c.includes("stills"), "唔入 still refs");
    const rgba = await pngInfo(c);
    assert.equal(rgba.pix_fmt, "rgba");
  }
  const manifest = JSON.parse(fs.readFileSync(res.manifest, "utf8")) as { purpose: string; redline: string; board: string };
  assert.equal(manifest.purpose, "blender-lookdev");
  assert.match(manifest.redline, /白模外觀參考/);
  assert.match(manifest.redline, /照板起模/);
  assert.ok(manifest.board.includes("boards"), "成張板住 boards/");
});

test("W4 分鏡動作板 prompt＝pre-vis 層（整張用，唔切割）；唔強加資產白底", () => {
  const p = storyboardBoardPrompt({
    cells: ["男人企定喺檔案櫃之間", "弓步右直拳", "左腳側踢", "落地立正望鏡頭"],
    style: "寫實電影感、冷青低飽和",
  });
  assert.ok(p.includes("2列×2行") && p.includes("01 — 男人企定"));
  assert.ok(p.includes("黑色邊框") && p.includes("每格左上角依次標注01、02、03、04"), "分鏡板閱讀用唔切割入庫，角標黑框照舊");
  assert.ok(!p.includes("禁止"), "W4B：內容negative掃除（霓虹等）；格式項正寫");
  assert.ok(!p.includes("純白flat底"), "pre-vis 唔係資產板，底色跟場面唔跟白底標準");
});

test("W4 換衫板 prompt：版式照舊＋只換衫＋四格齊換（W4B正面寫法）", () => {
  const p = wardrobeSwapBoardPrompt(CHAR, "白色禮服");
  assert.ok(p.includes("版式照舊") && p.includes("只換衫") && p.includes("轉面帶四格全部完成換衫"));
  assert.ok(p.includes("由左至右係正面"), "Image-1 板面描述跟轉面帶");
  assert.ok(!p.includes("禁止"), "W4B：內容negative掃除");
  assert.ok(p.includes("純白flat底（#FFFFFF）"), "換衫板照透明資產底色標準");
});

test("W4C P0：live 兩條lane嘅qc交eyes——armed second令stale cache必MISS（漏交＝hit假GREEN死鎖）", async () => {
  const dir = tmp();
  const png = path.join(dir, "cell.png");
  await makePng(png, 32, "red");
  const outJson = path.join(dir, "cell.photo_qc.json");
  // stale GREEN收據（second.model 唔係本run個model）：有交eyes⇒cache MISS重跑；
  // 漏交eyes⇒secondCfg null⇒cache HIT靜靜收假GREEN——WGTT死鎖嘅機制本身。
  const sha = crypto.createHash("sha256").update(fs.readFileSync(png)).digest("hex");
  fs.writeFileSync(
    outJson,
    JSON.stringify({
      tool: "slatecrew.photo_qc",
      ts: new Date().toISOString(),
      formula: QC_FORMULA,
      sha256: sha,
      require: PORTRAIT_BOARD_REQUIRE,
      status: "GREEN",
      checks: { status: "GREEN", fail_reasons: [] },
      judgeOutput: { stale: true },
      second: { model: "stale-model" },
    }),
  );

  const saved = { ...process.env };
  process.env.NEX_URL = "http://127.0.0.1:9"; // 死port：eyes有交→cache MISS→probe即場ECONNREFUSED
  process.env.SLATECREW_SECOND_ENDPOINT = "http://127.0.0.1:9";
  process.env.SLATECREW_SECOND_MODEL = "w4c-probe";
  try {
    const eyes = photoQcEyesFromEnv();
    assert.equal(eyes.second?.secondEndpoint, "http://127.0.0.1:9", "armed env⇒eyes非空");
    await assert.rejects(() => liveBoardLane("").qc(png, outJson, PORTRAIT_BOARD_REQUIRE), /fetch failed/);
    await assert.rejects(() => liveLane("").qc(png, outJson, PORTRAIT_BOARD_REQUIRE), /fetch failed/);
  } finally {
    for (const k of ["NEX_URL", "SLATECREW_SECOND_ENDPOINT", "SLATECREW_SECOND_MODEL"]) {
      if (k in saved) process.env[k] = saved[k]!;
      else delete process.env[k];
    }
  }
});

test("鍵格板：一張 U1.5 裝多個分鏡，鍵格數量唔鎖死", async () => {
  const eight = ["0%", "12%", "25%", "37%", "50%", "62%", "75%", "100%"].map((at) => ({ at, text: "弓步" }));
  const p = keyframeSheetPrompt(eight);
  assert.ok(p.includes("2列×4行") && p.includes("這一次出齊8個時刻"));
  assert.ok(p.includes("0%") && p.includes("100%"));
  assert.ok(!p.includes("黑色邊框"));
  assert.doesNotThrow(() => keyframeSheetPrompt([{ at: "0%", text: "行" }, { at: "50%", text: "企" }, { at: "100%", text: "望" }]));

  const dir = tmp();
  const singles = Array.from({ length: 11 }, (_, i) =>
    momentsForShot({ id: `SH${String(i + 1).padStart(2, "0")}`, action: "行", heading: "h", stillPrompt: "" }, dir),
  );
  const batched = chunkMomentSheets(singles);
  assert.equal(batched.length, 1, "分鏡同一張 U1.5，冇數量鎖");
  assert.equal(batched[0]!.length, 11);

  const many = momentsForShot(
    { id: "SH01", action: "行", heading: "h", keyframePositions: "0%, 10%, 20%, 30%, 40%, 50%, 60%, 70%, 80%, 90%, 100%" },
    dir,
  );
  assert.equal(many.length, 11, "鍵格寫幾多留幾多");
  const own = chunkMomentSheets([many, ...singles.slice(0, 3)]);
  assert.equal(own[0]!.length, 11);
  assert.equal(own[1]!.length, 3);

  const frames = fullFrameMoments({ id: "SH01", action: "拉開冰箱", heading: "h" }, 56, dir);
  const batches = chunkFrameMoments(frames);
  assert.deepEqual(batches.map((b) => b.length), [16, 16, 16, 8]);
  assert.equal(batches[0]![0]!.file.endsWith("SH01.kf-000.png"), true);
  assert.equal(batches[3]![7]!.file.endsWith("SH01.kf-055.png"), true);
  const sixteen = keyframeSheetPrompt(batches[0]!);
  assert.ok(sixteen.includes("分鏡鍵格板") && sixteen.includes("4列×4行") && !sixteen.includes("Blender灰模"));

  const { lane, edits } = fakeLane();
  const outDir = tmp();
  const moments = momentsForShot(
    { id: "SH02", action: "企定", heading: "h", keyframePositions: "0%, 30%, 70%, 100%" },
    outDir,
  );
  const res = await ensureKeyframeSheet({
    moments,
    boardsDir: path.join(outDir, "boards"),
    name: "keyframes-01",
    images: [],
    lane,
  });
  assert.equal(edits.length, 1, "四格一次 spawn");
  assert.equal(res.cells.length, 4);
  for (const f of res.cells) assert.ok(fs.existsSync(f), f);
});

if (bareBun) {
  void (async () => {
    let failed = 0;
    for (const c of cases) {
      try {
        await c.fn();
        console.log(`ok - ${c.name}`);
      } catch (err) {
        failed += 1;
        console.error(`not ok - ${c.name}\n${err instanceof Error ? err.stack : String(err)}`);
      }
    }
    console.log(`# ${cases.length - failed}/${cases.length} passed`);
    if (failed > 0) process.exit(1);
  })();
}
