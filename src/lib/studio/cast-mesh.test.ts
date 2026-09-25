import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import sharp from "sharp";
import { ensureCastOnce, freshMeshDir, refuseKeyframePlate, assertStoryPlatesReady } from "./cast-mesh";
import { bakeSelectionFrames, type MotionSelection } from "./motion-select";
import { keyframeSheetPrompt } from "./asset-board";
import type { runCommand } from "./audio";

async function plate(dir: string): Promise<string> {
  const size = 256;
  const rgba = Buffer.alloc(size * size * 4, 0);
  for (let y = Math.floor(size * 0.3); y < size * 0.7; y += 1) {
    for (let x = Math.floor(size * 0.3); x < size * 0.7; x += 1) {
      const i = (y * size + x) * 4;
      rgba[i] = 120;
      rgba[i + 1] = 120;
      rgba[i + 2] = 120;
      rgba[i + 3] = 255;
    }
  }
  const file = path.join(dir, "A.front.png");
  await sharp(rgba, { raw: { width: size, height: size, channels: 4 } }).png().toFile(file);
  return file;
}

test("rig stays shut until every story plate exists", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-ready-"));
  const pin = path.join(dir, "A.front.png");
  fs.writeFileSync(pin, "pin");
  assert.throws(
    () => assertStoryPlatesReady({
      characters: [{ id: "A", pin }, { id: "B" }],
      props: [{ name: "樽" }],
      scenes: [{ id: "木檯" }],
    }),
    /cast_incomplete: 故事元素未齊/,
  );
  const prop = path.join(dir, "bottle.png");
  const scene = path.join(dir, "desk.png");
  const b = path.join(dir, "B.front.png");
  fs.writeFileSync(prop, "p");
  fs.writeFileSync(scene, "s");
  fs.writeFileSync(b, "b");
  const items = assertStoryPlatesReady({
    characters: [{ id: "A", pin }, { id: "B", pin: b }],
    props: [{ name: "樽", file: prop }],
    scenes: [{ id: "木檯", file: scene }],
  });
  assert.deepEqual(items.map((i) => i.id), ["A", "B", "樽", "木檯"]);
});

test("a failed sf3d directory does not block the next attempt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-mesh-dir-"));
  const item = path.join(dir, "A");
  fs.mkdirSync(path.join(item, "sf3d"), { recursive: true });
  assert.equal(path.basename(freshMeshDir(item)), "sf3d-2");
  fs.mkdirSync(path.join(item, "sf3d", "0"), { recursive: true });
  fs.writeFileSync(path.join(item, "sf3d", "0", "mesh_front.glb"), "glb");
  assert.equal(path.basename(freshMeshDir(item)), "sf3d");
});

test("mesh refuses a keyframe and a Blender frame", () => {
  assert.throws(() => refuseKeyframePlate("/job/stills/SH01.png"), /成個 keyframe/);
  assert.throws(() => refuseKeyframePlate("/job/blockout/SH01.f0.png"), /Blender/);
  assert.throws(() => refuseKeyframePlate("/job/portraits/boards/A.angles.png"), /未切成張/);
  assert.doesNotThrow(() => refuseKeyframePlate("/job/portraits/A.front.png"));
});

test("ensureCastOnce rigs the plate inside one systemctl window", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cast-mesh-"));
  const src = await plate(dir);
  const mesh = path.join(dir, "cast", "A", "sf3d", "0", "mesh_front.glb");
  fs.mkdirSync(path.dirname(mesh), { recursive: true });
  fs.writeFileSync(mesh, "glb");
  const calls: string[] = [];
  const run: typeof runCommand = async (cmd, args) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    if (cmd === "nvidia-smi" && args.join(" ").includes("memory.free")) return { code: 0, stdout: "8192\n", stderr: "" };
    if (cmd === "nvidia-smi") return { code: 0, stdout: "\n", stderr: "" };
    if (args.includes("rig")) fs.writeFileSync(args[args.indexOf("rig") + 3]!, "rigged");
    return { code: 0, stdout: "", stderr: "" };
  };
  const rigs = await ensureCastOnce({
    characters: [{ id: "A" }],
    items: [{ id: "A", file: src }],
    meshRoot: path.join(dir, "cast"),
    endpoint: "http://127.0.0.1:9",
    runCmd: run,
  });
  assert.match(rigs.A!, /mesh_front_rigged\.glb$/);
  const stop = calls.findIndex((c) => c.includes("systemctl") && c.includes(" stop "));
  const rig = calls.findIndex((c) => c.includes(" --device auto "));
  const start = calls.findIndex((c) => c.includes("systemctl") && c.includes(" start "));
  assert.ok(stop >= 0 && rig > stop && start > rig, calls.join("\n"));
  assert.ok(calls.some((c) => c.includes("CUDA_VISIBLE_DEVICES=2")), calls.join("\n"));
  assert.equal(calls.some((c) => c.includes("127.0.0.1:9")), false);
});

test("bake carries the character rig and the rest of the set", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bake-set-"));
  const frames = path.join(dir, "frames");
  fs.mkdirSync(frames);
  fs.writeFileSync(path.join(frames, "frame_0001.png"), "x");
  const sel: MotionSelection = {
    shot: "SH01",
    bvh: "data/1/1.bvh",
    conf: 1,
    auto: true,
    bake: { start: 1, len: 2, step: 1, auto_anchor: true },
    runners: [],
    reason: "stand",
    flags: [],
  };
  let argv: string[] = [];
  await bakeSelectionFrames(sel, path.join(dir, "SH01.mp4"), {
    glb: "/tmp/hero.glb",
    set: ["/tmp/gate.glb", "/tmp/cup.glb"],
    runCmd: async (_cmd, args) => {
      argv = args;
      return { code: 0, stdout: `FULL_DONE dir=${frames} frames=2\n`, stderr: "" };
    },
  });
  const line = argv.join(" ");
  assert.match(line, /--glb \/tmp\/hero\.glb/);
  assert.match(line, /--set \/tmp\/gate\.glb/);
  assert.match(line, /--set \/tmp\/cup\.glb/);
});

test("keyframe sheet is created from the built world, not copied as the keyframe", () => {
  const text = keyframeSheetPrompt([{ at: "", text: "阿城企喺城門" }]);
  assert.match(text, /用呢個世界生出下面嘅分鏡/);
  assert.match(text, /唔好把參考圖直接抄成鍵格/);
});
