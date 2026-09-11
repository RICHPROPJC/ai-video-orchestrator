import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { AddressInfo } from "node:net";
import { assertPng, buildEditPayload, checkHealth, snap32, MAX_IMAGES } from "./u15-edit";

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
