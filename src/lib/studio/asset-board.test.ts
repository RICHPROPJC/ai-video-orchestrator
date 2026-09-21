import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { runCommand } from "./audio";
import type { Character, ShotProp } from "./types";
import {
  DEFAULT_CELL_PX,
  PORTRAIT_BOARD_REQUIRE,
  angleBoardPrompt,
  ensureAngleBoard,
  ensurePropBoard,
  ensureSceneBoard,
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

test("W4 角度板 prompt：版式規格式＋跨格一致＋純白flat底（唔准攝影棚灰）", () => {
  const p = angleBoardPrompt(CHAR, { styleBible: { grade: "冷青低飽和" } });
  for (const need of ["2列×2行", "尺寸嚴格一致、邊緣對齊、間距統一", "幼白色間隔線同黑色邊框", "01、02、03、04", "跨格面容髮型服裝完全一致唔走形", "純白flat底（#FFFFFF）", "禁止"]) {
    assert.ok(p.includes(need), `prompt 缺 ${need}`);
  }
  assert.ok(!/純色淺灰|淺灰攝影棚/.test(p), "唔准灰底（難key）");
  assert.ok(p.includes("01 正面全身企直") && p.includes("04 背面全身"), "四格角度規格");
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
    /零格 GREEN/,
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

test("W4 道具板：4 props 一板四格入 assets/，6 props 分兩板；逐格 QC people_count=0；FAIL 即死", async () => {
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

  // 6 props → two boards (4 + 2)
  const six = [...PROPS, { name: "斗篷", shape: ["披"], forbid: [] as string[] }, { name: "燈籠", shape: ["紙", "竹"], forbid: [] as string[] }];
  const dir2 = tmp();
  const two = fakeLane();
  const res6 = await ensurePropBoard({ props: six, assetsDir: dir2, lane: two.lane });
  assert.equal(two.edits.length, 2, "6 props＝兩板");
  assert.equal(res6.pinned.length, 6);

  // a FAIL prop kills the shelf (fail loud, never a partial asset set)
  const dir3 = tmp();
  const killer = fakeLane({ qc: (_png, call) => (call === 3 ? "FAIL" : "GREEN") });
  await assert.rejects(() => ensurePropBoard({ props: PROPS, assetsDir: dir3, lane: killer.lane }), /鐵犁 板格未過盲眼/);
});

test("W4 道具/場景板 prompt：純白flat底＋無人無手／跨格一致", () => {
  const p = propBoardPrompt(PROPS);
  assert.ok(p.includes("純白flat底（#FFFFFF）") && !/純色淺灰|淺灰攝影棚/.test(p));
  assert.ok(p.includes("禁止灰底、漸變底、攝影棚地台"), "灰底係禁詞唔係底色");
  assert.ok(p.includes("每格一件道具，居中擺放，無人無手"));

  const s = sceneBoardPrompt({ name: "檔案室", desc: "兩排高身金屬檔案櫃之間嘅窄道", grade: "冷青低飽和" });
  assert.ok(s.includes("2列×2行") && s.includes("01、02、03、04"));
  assert.ok(s.includes("純白flat底（#FFFFFF）"), "建築板照透明資產底色標準");
  assert.match(s, /檔案室/);
  assert.match(s, /唔入 still refs|跨格建築結構/);
});

test("W4 場景板分流：cells 入 assets/scenes/ 做 Blender look-dev（唔入 still refs），manifest 帶紅線", async () => {
  const dir = tmp();
  const { lane } = fakeLane();
  const res = await ensureSceneBoard({
    name: "檔案室",
    desc: "兩排高身金屬檔案櫃之間嘅窄道，慘白光管",
    grade: "冷青低飽和",
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
  assert.match(manifest.redline, /唔准成張餵 H3/);
  assert.match(manifest.redline, /blockout真場景 → U1\.5 \/edit keyframe still → H3/);
  assert.ok(manifest.board.includes("boards"), "成張板住 boards/");
});

test("W4 分鏡動作板 prompt＝pre-vis 層（整張用，唔切割）；唔強加資產白底", () => {
  const p = storyboardBoardPrompt({
    cells: ["男人企定喺檔案櫃之間", "弓步右直拳", "左腳側踢", "落地立正望鏡頭"],
    style: "寫實電影感、冷青低飽和",
  });
  assert.ok(p.includes("2列×2行") && p.includes("01 — 男人企定"));
  assert.ok(p.includes("禁止"));
  assert.ok(!p.includes("純白flat底"), "pre-vis 唔係資產板，底色跟場面唔跟白底標準");
});

test("W4 換衫板 prompt：版式照舊＋只換衫＋禁止部分格數", () => {
  const p = wardrobeSwapBoardPrompt(CHAR, "白色禮服");
  assert.ok(p.includes("版式照舊") && p.includes("只換衫") && p.includes("只換到部分格數"));
  assert.ok(p.includes("純白flat底（#FFFFFF）"), "換衫板照透明資產底色標準");
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
