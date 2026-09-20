import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import {
  BLENDER_51_VERSION,
  blenderGateScript,
  meshGeometryVerdict,
  runMeshGeometryGate,
} from "./mesh-geometry-gate";

function tmp(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "sf3d-gate-"));
}

const anchors = { previewLumaSpan: 160, previewStdev: 40 };

test("verdict bands: hero figure 0.583 passes, chair prop 0.298 passes", () => {
  const hero = meshGeometryVerdict({ solidity: 0.583, thinness: 0.3, ...anchors }, "figure");
  assert.ok(hero.every((c) => c.pass), hero.map((c) => c.detail).join("; "));
  const chair = meshGeometryVerdict({ solidity: 0.298, thinness: 0.5, ...anchors }, "prop");
  assert.ok(chair.every((c) => c.pass));
});

test("verdict bands: melt-blob high solidity and latent-garbage low solidity both fail", () => {
  const blob = meshGeometryVerdict({ solidity: 0.93, thinness: 0.6, ...anchors }, "figure");
  assert.ok(blob.find((c) => c.name === "solidity")?.pass === false, "quasi-convex melt scores high — must fail");
  const garbage = meshGeometryVerdict({ solidity: 0.011, thinness: 0.2, ...anchors }, "prop");
  assert.ok(garbage.find((c) => c.name === "solidity")?.pass === false);
});

test("verdict bands: pancake thinness and flat preview render fail", () => {
  const pancake = meshGeometryVerdict({ solidity: 0.5, thinness: 0.01, ...anchors }, "figure");
  assert.ok(pancake.find((c) => c.name === "thinness")?.pass === false);
  const flat = meshGeometryVerdict({ solidity: 0.5, thinness: 0.3, previewLumaSpan: 5, previewStdev: 0.5 }, "figure");
  assert.ok(flat.find((c) => c.name === "preview")?.pass === false);
});

test("gate script: deterministic -90 X correction for canonical mesh_front, metre contract, CYCLES CPU preview", () => {
  const py = blenderGateScript();
  assert.match(py, /correction_degrees = -90/);
  assert.match(py, /import_scene\.gltf/);
  assert.match(py, /"CYCLES"/);
  assert.match(py, /"CPU"/);
  assert.match(py, /metre contract failed/);
  assert.match(py, /convex_hull/);
  assert.match(py, /calc_volume/);
  // metrics are written before the render — crash evidence survives
  const receiptAt = py.indexOf('gate_receipt.json").write_text');
  const renderAt = py.indexOf("bpy.ops.render.render");
  assert.ok(receiptAt > 0 && renderAt > receiptAt, "receipt written before render");
});

/** fake blender: --version prints 5.1.2; gate runs copy a preview PNG and
 *  write a receipt with the solidity/thinness the case needs. */
function fakeBlender(dir: string, opts?: { version?: string; solidity?: number; thinness?: number; crash?: boolean; noPreview?: boolean; preview?: string }) {
  const bin = path.join(dir, `blender-${Math.random().toString(36).slice(2)}`);
  const solidity = opts?.solidity ?? 0.583;
  const thinness = opts?.thinness ?? 0.3;
  const preview = opts?.preview ?? "";
  const script = `#!/bin/bash
case "$*" in
  *--version*) echo "${opts?.version ?? BLENDER_51_VERSION} commit fake"; exit 0;;
esac
if [ "${opts?.crash ? "1" : "0"}" = "1" ]; then echo "boom" >&2; exit 1; fi
out=""
prev=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) out="$2"; shift 2;;
    --glb) shift 2;;
    --height|--px) shift 2;;
    *) shift;;
  esac
done
cat > "$out/gate_receipt.json" <<EOF
{"source_sha256":"x","vertices":4820,"originalDimensions":[1,1,1],"dimensionsM":[0.5,0.3,1.7],"axisCorrectionDegX":-90,"targetHeightM":1.7,"heightCalibrated":true,"volumeM3":0.05,"hullVolumeM3":0.09,"solidity":${solidity},"thinness":${thinness},"preview":"$out/preview.png","blender":"5.1.2"}
EOF
if [ "${opts?.noPreview ? "1" : "0"}" = "0" ]; then cp "${preview}" "$out/preview.png"; fi
echo "SF3D_GATE_OK"
exit 0
`;
  fs.writeFileSync(bin, script);
  fs.chmodSync(bin, 0o755);
  return bin;
}

async function previewPng(dir: string): Promise<string> {
  const file = path.join(dir, "fixture-preview.png");
  const half = 160;
  await sharp({
    create: { width: 320, height: 320, channels: 3, background: "#101010" },
  }).composite([{
    input: await sharp({
      create: { width: 160, height: 320, channels: 3, background: "#e8e8e8" },
    }).png().toBuffer(),
    left: half,
    top: 0,
  }]).png().toFile(file);
  return file;
}

test("runMeshGeometryGate: fake 5.1.2 blender + good metrics -> ok verdict with receipt", async () => {
  const dir = tmp();
  const preview = await previewPng(dir);
  const bin = fakeBlender(dir, { preview });
  const verdict = await runMeshGeometryGate({
    glb: "/nonexistent/mesh_front.glb",
    outDir: path.join(dir, "gate-out"),
    blenderBin: bin,
  });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.metrics.solidity, 0.583);
  assert.ok(fs.existsSync(path.join(dir, "gate-out", "gate-verdict.json")));
});

test("runMeshGeometryGate refuses any blender that is not 5.1.2", async () => {
  const dir = tmp();
  const bin = fakeBlender(dir, { version: "Blender 3.0.1" });
  await assert.rejects(
    runMeshGeometryGate({ glb: "/x.glb", outDir: path.join(dir, "g"), blenderBin: bin }),
    /not Blender 5.1.2/,
  );
});

test("runMeshGeometryGate: blob solidity fails the gate even though blender exited 0", async () => {
  const dir = tmp();
  const preview = await previewPng(dir);
  const bin = fakeBlender(dir, { solidity: 0.93, preview });
  const verdict = await runMeshGeometryGate({
    glb: "/x.glb",
    outDir: path.join(dir, "gate-out"),
    blenderBin: bin,
    meshClass: "figure",
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checks.find((c) => c.name === "solidity")?.pass, false);
});

test("runMeshGeometryGate: crashed blender run throws with output tail", async () => {
  const dir = tmp();
  const bin = fakeBlender(dir, { crash: true });
  await assert.rejects(
    runMeshGeometryGate({ glb: "/x.glb", outDir: path.join(dir, "g"), blenderBin: bin }),
    /blender run failed/,
  );
});

test("runMeshGeometryGate: metrics surviving a render crash fail the preview check, not the run", async () => {
  const dir = tmp();
  const bin = fakeBlender(dir, { noPreview: true });
  const verdict = await runMeshGeometryGate({
    glb: "/x.glb",
    outDir: path.join(dir, "gate-out"),
    blenderBin: bin,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.checks.find((c) => c.name === "solidity")?.pass, true, "metrics still judged");
  assert.equal(verdict.checks.find((c) => c.name === "preview")?.pass, false, "missing preview fails the gate");
});
