import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import sharp from "sharp";
import {
  assertGlbFile,
  assertMeshPlate,
  importMeshCall,
  meshPlateFacts,
  sf3dGenerate,
  sf3dHealth,
} from "./mesh-provider";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sf3d-provider-"));
}

/** synthetic 去背方塊: transparent border ring, opaque core block. */
async function makePlate(dir: string, name = "plate.png", opts?: { square?: boolean; opaqueBorder?: boolean; noAlpha?: boolean; emptyCore?: boolean }) {
  const size = 256;
  const rgba = Buffer.alloc(size * size * 4, 0);
  if (!opts?.emptyCore) {
    for (let y = Math.floor(size * 0.3); y < size * 0.7; y += 1) {
      for (let x = Math.floor(size * 0.3); x < size * 0.7; x += 1) {
        const i = (y * size + x) * 4;
        rgba[i] = 120;
        rgba[i + 1] = 120;
        rgba[i + 2] = 120;
        rgba[i + 3] = 255;
      }
    }
  }
  if (opts?.opaqueBorder) {
    for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
  }
  let img = sharp(rgba, { raw: { width: size, height: size, channels: 4 } });
  if (opts?.noAlpha) img = img.flatten({ background: "#808080" });
  if (opts?.square === false) {
    img = sharp(await img.png().toBuffer()).extract({ left: 0, top: 0, width: 200, height: 256 });
  }
  const file = path.join(dir, name);
  await img.png().toFile(file);
  return file;
}

function tinyGlb(): Buffer {
  const json = Buffer.from('{"asset":{"version":"2.0"},"scenes":[]}');
  const head = Buffer.alloc(12);
  head.write("glTF", 0, "ascii");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + json.length, 8);
  const chunk = Buffer.alloc(8 + json.length);
  chunk.writeUInt32LE(json.length, 0);
  chunk.write("JSON", 4, "ascii");
  json.copy(chunk, 8);
  return Buffer.concat([head, chunk]);
}

type MockServer = {
  url: string;
  requests: { method: string; path: string; body?: unknown }[];
  behaviour: { canonicalized?: boolean; badGlb?: boolean; notReady?: boolean };
  close(): Promise<void>;
};

async function mockSf3d(): Promise<MockServer> {
  const state: MockServer = {
    url: "",
    requests: [],
    behaviour: {},
    close() {
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : undefined;
      state.requests.push({ method: req.method ?? "", path: req.url ?? "", body });
      const json = (code: number, obj: unknown) => {
        const b = Buffer.from(JSON.stringify(obj));
        res.writeHead(code, { "Content-Type": "application/json", "Content-Length": b.length });
        res.end(b);
      };
      if (req.url === "/health") {
        return json(200, { ready: !state.behaviour.notReady, gpu_mem_mb: 4056, served: 1, busy: false, err: null });
      }
      if (req.url === "/generate" && req.method === "POST") {
        const b = body as { image: string; out_dir: string };
        const out0 = path.join(b.out_dir, "0");
        fs.mkdirSync(out0, { recursive: true });
        const glbPath = path.join(out0, "mesh_front.glb");
        fs.writeFileSync(glbPath, state.behaviour.badGlb ? Buffer.from("not a glb at all..") : tinyGlb());
        fs.writeFileSync(path.join(out0, "canonical_receipt.json"), JSON.stringify({ best_az: 180, iou: 0.7 }));
        return json(200, {
          mesh: path.join(out0, "mesh.glb"),
          mesh_front: glbPath,
          canonicalized: state.behaviour.canonicalized !== false,
          bytes: 4096,
          peak_mem_mb: 6100,
          plate_bg_std: 0.4,
          elapsed_s: 5.2,
        });
      }
      json(404, { err: "not found" });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  state.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return state;
}

test("去背方塊 passes the plate gate; facts recorded", async () => {
  const dir = tmp();
  const plate = await makePlate(dir);
  const facts = await assertMeshPlate(plate);
  assert.equal(facts.square, true);
  assert.ok(facts.borderAlphaMean <= 0.02);
  assert.equal(facts.opaqueCore, true);
});

test("non-square / opaque-border / no-alpha / empty-core plates are refused", async () => {
  const dir = tmp();
  await assert.rejects(makePlate(dir, "wide.png", { square: false }).then((f) => assertMeshPlate(f)), /square/);
  await assert.rejects(makePlate(dir, "opaque.png", { opaqueBorder: true }).then((f) => assertMeshPlate(f)), /transparent/);
  await assert.rejects(makePlate(dir, "rgb.png", { noAlpha: true }).then((f) => assertMeshPlate(f)), /alpha/);
  await assert.rejects(makePlate(dir, "ghost.png", { emptyCore: true }).then((f) => assertMeshPlate(f)), /opaque subject/);
});

test("sf3dGenerate: one POST, server canonicalize accepted, receipt + hashes written", async () => {
  const dir = tmp();
  const plate = await makePlate(dir);
  const mock = await mockSf3d();
  try {
    const receipt = await sf3dGenerate({ plate, outDir: path.join(dir, "run1"), endpoint: mock.url });
    assert.equal(receipt.status, "succeeded");
    assert.equal(receipt.mesh_front, path.join(dir, "run1", "0", "mesh_front.glb"));
    assert.ok(receipt.mesh_front_sha256);
    assert.ok(receipt.canonical_sha256);
    const posts = mock.requests.filter((r) => r.path === "/generate");
    assert.equal(posts.length, 1, "exactly one generate POST — client never re-canonicalizes");
    const body = posts[0].body as Record<string, unknown>;
    assert.equal(body.no_rembg, true, "pre-去背 plate skips server rembg (D1)");
    assert.equal(body.canonicalize, true);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "run1", "mesh-receipt.json"), "utf8"));
    assert.equal(onDisk.status, "succeeded");
  } finally {
    await mock.close();
  }
});

test("sf3dGenerate fails loud when the server did not canonicalize", async () => {
  const dir = tmp();
  const plate = await makePlate(dir);
  const mock = await mockSf3d();
  mock.behaviour.canonicalized = false;
  try {
    const receipt = await sf3dGenerate({ plate, outDir: path.join(dir, "run2"), endpoint: mock.url });
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error ?? "", /never re-canonicalizes/);
  } finally {
    await mock.close();
  }
});

test("sf3dGenerate fails on a corrupt GLB payload", async () => {
  const dir = tmp();
  const plate = await makePlate(dir);
  const mock = await mockSf3d();
  mock.behaviour.badGlb = true;
  try {
    const receipt = await sf3dGenerate({ plate, outDir: path.join(dir, "run3"), endpoint: mock.url });
    assert.equal(receipt.status, "failed");
    assert.match(receipt.error ?? "", /GLB/);
  } finally {
    await mock.close();
  }
});

test("sf3dGenerate refuses a reused out_dir and a not-ready server", async () => {
  const dir = tmp();
  const plate = await makePlate(dir);
  const mock = await mockSf3d();
  try {
    const first = await sf3dGenerate({ plate, outDir: path.join(dir, "runA"), endpoint: mock.url });
    assert.equal(first.status, "succeeded");
    const reuse = await sf3dGenerate({ plate, outDir: path.join(dir, "runA"), endpoint: mock.url });
    assert.equal(reuse.status, "refused");
    assert.match(reuse.refused ?? "", /no reuse/);
    mock.behaviour.notReady = true;
    const notReady = await sf3dGenerate({ plate, outDir: path.join(dir, "runB"), endpoint: mock.url });
    assert.equal(notReady.status, "refused");
    assert.match(notReady.refused ?? "", /not ready/);
  } finally {
    await mock.close();
  }
});

test("sf3dHealth parses the server health shape", async () => {
  const mock = await mockSf3d();
  try {
    const h = await sf3dHealth(mock.url);
    assert.equal(h.ready, true);
    assert.equal(typeof h.gpu_mem_mb, "number");
  } finally {
    await mock.close();
  }
});

test("meshPlateFacts never throws on garbage — facts only", async () => {
  const dir = tmp();
  const plate = await makePlate(dir, "opaque2.png", { opaqueBorder: true });
  const facts = await meshPlateFacts(plate);
  assert.ok(facts.borderAlphaMean > 0.02);
});

test("assertGlbFile rejects a truncated header", () => {
  const dir = tmp();
  const file = path.join(dir, "bad.glb");
  fs.writeFileSync(file, Buffer.alloc(30, 1));
  assert.throws(() => assertGlbFile(file), /GLB/);
});

test("importMeshCall matches the SETTLE_SF3D_BLENDER_U15_0918 import-call shape", () => {
  assert.deepEqual(importMeshCall({ path: "/x/mesh_front.glb", name: "Sf3dHero", targetHeightM: 1.7 }), {
    tool: "object.import_mesh",
    args: { path: "/x/mesh_front.glb", name: "Sf3dHero", zUp: true, targetHeightM: 1.7 },
  });
  assert.throws(() => importMeshCall({ path: "/x", name: "n", targetHeightM: 0 }), /targetHeightM/);
});
