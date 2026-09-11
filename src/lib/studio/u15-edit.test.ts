import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { assertPng, buildEditPayload, checkHealth, snap32, MAX_IMAGES } from "./u15-edit";
import { keyframeEditPrompt } from "./keyframe-prompt";
import type { CallSheet, Shot } from "./types";

const base = { prompt: "把灰色人偶換成角色", width: 2050, height: 1152 };

test("snap32 floors to ÷32", () => {
  assert.equal(snap32(2050), 2048);
  assert.equal(snap32(2048), 2048);
  assert.equal(snap32(2017), 2016);
});

test("one image → image_path", () => {
  const p = buildEditPayload({ ...base, images: ["/home/u/refs/a.png"] });
  assert.equal(p.image_path, "/home/u/refs/a.png");
  assert.equal(p.image_paths, undefined);
});

test("three images → image_paths", () => {
  const p = buildEditPayload({ ...base, images: ["/a.png", "/b.png", "/c.png"] });
  assert.equal(p.image_path, undefined);
  assert.deepEqual(p.image_paths, ["/a.png", "/b.png", "/c.png"]);
});

test(`more than ${MAX_IMAGES} images throws`, () => {
  const images = Array.from({ length: 6 }, (_, i) => `/r/${i}.png`);
  assert.throws(() => buildEditPayload({ ...base, images }), new RegExp(`${MAX_IMAGES}-image cap`));
});

test("payload has exactly the /edit defaults with receipts", () => {
  const p = buildEditPayload({ ...base, images: ["/a.png"], seed: 42 });
  assert.equal(p.num_steps, 8);
  assert.equal(p.cfg_scale, 1);
  assert.equal(p.img_cfg_scale, 1);
  assert.equal(p.use_edit_pe, true);
  assert.equal(p.width, 2048);
  assert.equal(p.height, 1152);
  assert.equal(p.seed, 42);
  assert.deepEqual(Object.keys(p).sort(), [
    "cfg_scale", "height", "image_path", "img_cfg_scale", "num_steps", "prompt", "seed", "use_edit_pe", "width",
  ]);
});

test("non-PNG body throws", () => {
  assert.throws(() => assertPng(Buffer.from("<html>oops")), /non-PNG/);
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest")]);
  assert.doesNotThrow(() => assertPng(png));
});

async function withServer(handler: http.RequestListener, fn: (url: string) => Promise<void>) {
  const server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

test("checkHealth: 200 + multi_image passes and returns info", async () => {
  await withServer((req, res) => {
    assert.equal(req.url, "/health");
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "SenseNova-U1.5-8B-MoT", multi_image: true, defaults: {} }));
  }, async (url) => {
    const info = await checkHealth(url, 3);
    assert.equal(info.model, "SenseNova-U1.5-8B-MoT");
  });
});

test("checkHealth: multi_image=false blocks multi-image edits", async () => {
  await withServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ model: "x", multi_image: false }));
  }, async (url) => {
    await assert.rejects(() => checkHealth(url, 2), /multi_image=false/);
    await checkHealth(url, 1); // single image still fine
  });
});

test("checkHealth: non-200 throws U1.5 node down", async () => {
  await withServer((_req, res) => {
    res.writeHead(503);
    res.end();
  }, async (url) => {
    await assert.rejects(() => checkHealth(url, 1), /U1\.5 node down.*503/);
  });
});

function promptSheet(): CallSheet {
  const mark = (characterId: string, x: number) => ({
    characterId,
    start: { x, y: 50 },
    end: { x, y: 50 },
    facing: 1,
    handL: { x: x + 4, y: 45 },
    handR: { x: x + 6, y: 45 },
    footL: { x: x - 2, y: 80 },
    footR: { x: x + 2, y: 80 },
    gait: "plant" as const,
  });
  return {
    title: "t",
    logline: "l",
    language: "zh-Hant",
    location: "茶餐廳門口",
    timeOfDay: "night",
    weather: "rain",
    mood: "m",
    durationSec: 4,
    aspect: "16:9",
    characters: [
      { id: "A", name: "阿月", role: "保險調查員", wardrobe: "深藍乾濕褸", palette: ["#111", "#222", "#333"], voice: { pitchHz: 200, gender: "f" } },
      { id: "B", name: "阿衡", role: "舊同事", wardrobe: "白襯衫", palette: ["#111", "#222", "#333"], voice: { pitchHz: 180, gender: "m" } },
    ],
    styleBible: { grade: "g", refs: [], stillModel: "u15", motionModel: "h3" },
    shots: [],
    voiceover: "",
  } satisfies CallSheet;
}

function promptShot(withProp: boolean): Shot {
  return {
    id: "SH02",
    index: 1,
    heading: "2",
    size: "medium",
    location: "茶餐廳門口",
    action: "a",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "B", start: { x: 70, y: 50 }, end: { x: 70, y: 50 }, facing: 1, handL: { x: 66, y: 45 }, handR: { x: 74, y: 45 }, footL: { x: 68, y: 80 }, footR: { x: 72, y: 80 }, gait: "plant" },
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
    ],
    ...(withProp ? { props: [{ name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] }] } : {}),
    stillPrompt: "",
    motionPrompt: "",
  } satisfies Shot;
}

test("first-appearance prompt names Image-1 (own f0) and Image-2.. (portraits)", () => {
  const text = keyframeEditPrompt(promptSheet(), promptShot(true), { first: true });
  assert.ok(text.includes("Image-1"), "names Image-1");
  assert.ok(text.includes("Image-2…Image-N 係上述角色嘅正面肖像"), "portrait refs line");
  assert.ok(text.includes("左起第1個人偶＝阿月"), "marks sorted by start.x — A (x30) is first");
  assert.ok(text.includes("左起第2個人偶＝阿衡"), "B (x70) is second");
  assert.ok(text.includes("深藍乾濕褸"), "wardrobe from sheet");
  assert.ok(text.includes("曲轅犁"), "prop name from sheet");
  assert.ok(text.includes("唔係锹、铲、锄"), "forbid list from sheet");
});

test("later-shot prompt names Image-1 (own f0) and Image-2 (previous keyframe)", () => {
  const text = keyframeEditPrompt(promptSheet(), promptShot(false), { first: false });
  assert.ok(text.includes("Image-1"), "names Image-1");
  assert.ok(text.includes("Image-2 係上一鏡嘅定格"), "prev-keyframe ref line");
  assert.ok(text.includes("唯獨姿勢跟 Image-1"), "posture follows the own f0");
  assert.ok(!text.includes("曲轅犁"), "no prop line without props");
  assert.ok(!text.includes("保持每個人偶嘅位置、姿勢、構圖同鏡頭完全不變"), "no single-image no-op phrasing");
});
