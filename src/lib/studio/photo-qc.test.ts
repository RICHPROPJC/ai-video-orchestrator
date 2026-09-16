import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import * as nodeTest from "node:test";
import {
  judge,
  judgeSecondEye,
  pinQcAccepted,
  resolveSecondEye,
  runPhotoQc,
  runSecondEye,
  sameRequire,
} from "./photo-qc";
import { keyframeRequire } from "./keyframe-prompt";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom) */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

const DESC = "兩個人企喺茶餐廳門口，一個着深藍乾濕褸，一個着白襯衫，地面濕，背景係霓虹燈。";

test("people mismatch fails", () => {
  const v = judge(DESC, { people_count: 3, grey_blocks: false }, { people_count: 2, grey_blocks: false });
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.includes("people_count")));
});

test("灰色方块 in the write-up fails grey_blocks", () => {
  const v = judge(`${DESC} 左邊嗰個係灰色方块。`, { people_count: 2, grey_blocks: false }, { people_count: 2, grey_blocks: false });
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.includes("grey_blocks")));
});

test("i-mannequin / placard / silhouette in write-up fails grey_blocks", () => {
  for (const extra of [
    "畫面係 Blender i-mannequin 占位。",
    "面前有塊 placard 標牌。",
    "兩個白色人形剪影。",
  ]) {
    const v = judge(`${DESC} ${extra}`, { people_count: 1, grey_blocks: false }, { people_count: 1, grey_blocks: false });
    assert.equal(v.status, "FAIL", extra);
    assert.ok(v.checks.fail_reasons.some((r) => r.includes("grey_blocks")), extra);
  }
});

test("empty require fails", () => {
  const v = judge(DESC, { people_count: 2 }, {});
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.includes("no require")));
});

test("matching write-up is GREEN", () => {
  const v = judge(DESC, { people_count: 2, grey_blocks: false }, { people_count: 2, grey_blocks: false });
  assert.equal(v.status, "GREEN");
  assert.deepEqual(v.checks.fail_reasons, []);
});

test("location / action / size from the sheet fail a street write-up", () => {
  const street = "人数：一人。姿势：站立。手里的物件：无。地面：湿的。背景：夜晚城市街景，高楼，霓虹灯招牌。";
  const v = judge(
    street,
    { people_count: 1, grey_blocks: false, pose_notes: "站立" },
    { people_count: 1, grey_blocks: false, location: "茶餐廳卡位", action: "坐低飲茶", size: "closeup" },
  );
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("location:")), v.checks.fail_reasons.join(" | "));
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("action:")), v.checks.fail_reasons.join(" | "));
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("size:")), v.checks.fail_reasons.join(" | "));
});

test("matching location and action stay GREEN", () => {
  const v = judge(DESC, { people_count: 2, grey_blocks: false }, {
    people_count: 2,
    grey_blocks: false,
    location: "茶餐廳門口",
    action: "企喺門口", // T35: a 2-char action has no judgeable bigrams -> unparseable FAIL
    size: "medium",
  });
  assert.equal(v.status, "GREEN");
  assert.deepEqual(v.checks.fail_reasons, []);
});

test("traditional location hits simplified morgue write-up", () => {
  const morgue =
    "一人。坐姿。双手拉着一块白布。地面有水渍。背景是地下停尸间，两侧金属床架，白色床单。";
  const v = judge(
    morgue,
    { people_count: 1, grey_blocks: false, pose_notes: "坐姿", location_notes: "地下停尸间", action_notes: "从钢床上挣扎坐起，伸手扯下白布", size_notes: "medium" },
    { people_count: 1, grey_blocks: false, location: "首都地下停屍間", action: "重生者喺鋼床掙扎坐起，扯下白布", size: "medium" },
  );
  assert.equal(v.status, "GREEN", v.checks.fail_reasons.join(" | "));
});

test("street write-up still fails 首都地下停屍間", () => {
  const street = "人数：一人。姿势：站立。手里的物件：无。地面：湿的。背景：夜晚城市街景，高楼，霓虹灯招牌。";
  const v = judge(
    street,
    { people_count: 1, grey_blocks: false, pose_notes: "站立" },
    { people_count: 1, grey_blocks: false, location: "首都地下停屍間", action: "坐起", size: "medium" },
  );
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("location:")), v.checks.fail_reasons.join(" | "));
});

test("closeup with 胸口 and size_notes medium is GREEN", () => {
  const desc = "一人。右手按在胸口。背景是室内金属走廊。";
  const v = judge(
    desc,
    { people_count: 1, grey_blocks: false, size_notes: "medium" },
    { people_count: 1, grey_blocks: false, size: "closeup" },
  );
  assert.equal(v.status, "GREEN", v.checks.fail_reasons.join(" | "));
});

test("consecutive stills that share the same write-up fail distinct", () => {
  const v = judge(DESC, { people_count: 2, grey_blocks: false }, { people_count: 2, grey_blocks: false }, { prevDesc: DESC });
  assert.equal(v.status, "FAIL");
  assert.ok(v.checks.fail_reasons.some((r) => r.startsWith("distinct:")));
});

test("sameRequire is structural", () => {
  assert.equal(sameRequire({ people_count: 1 }, { people_count: 1 }), true);
  assert.equal(sameRequire({ people_count: 1 }, { people_count: 1, location: "x" }), false);
});

function qcDir(status: string, sha: string | null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-qc-"));
  const pngBytes = Buffer.from("89504e470d0a1a2a0000", "hex");
  fs.writeFileSync(path.join(dir, "SH01.png"), pngBytes);
  fs.writeFileSync(
    path.join(dir, "SH01.photo_qc.json"),
    JSON.stringify({
      tool: "slatecrew.photo_qc",
      status,
      sha256: sha ?? crypto.createHash("sha256").update(pngBytes).digest("hex"),
      blind: "描述",
      require: { people_count: 2 },
    }),
  );
  return dir;
}

test("pinQcAccepted: GREEN + sha match", () => {
  assert.equal(pinQcAccepted(qcDir("GREEN", null), "SH01"), true);
});

test("pinQcAccepted: sha mismatch is false", () => {
  assert.equal(pinQcAccepted(qcDir("GREEN", "0".repeat(64)), "SH01"), false);
});

test("pinQcAccepted: FAIL status is false", () => {
  assert.equal(pinQcAccepted(qcDir("FAIL", null), "SH01"), false);
});

test("runPhotoQc: GREEN write-once keeps existing record when sha matches", async () => {
  const { runPhotoQc } = await import("./photo-qc");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-qc-wo-"));
  const png = path.join(dir, "SH01.png");
  const qc = path.join(dir, "SH01.photo_qc.json");
  const bytes = Buffer.from("89504e470d0a1a2a0000", "hex");
  fs.writeFileSync(png, bytes);
  const sha = crypto.createHash("sha256").update(bytes).digest("hex");
  const existing = {
    tool: "slatecrew.photo_qc",
    ts: "2020-01-01T00:00:00.000Z",
    image: png,
    sha256: sha,
    endpoint: "http://fixture",
    model: "fixture",
    require: { people_count: 1, grey_blocks: false },
    status: "GREEN",
    blind: "fixture",
    summary: { people_count: 1, grey_blocks: false },
    checks: { status: "GREEN", fail_reasons: [], people_count: true, grey_blocks: true },
  };
  fs.writeFileSync(qc, JSON.stringify(existing));
  const before = fs.readFileSync(qc, "utf8");
  const result = await runPhotoQc(png, qc, { people_count: 1, grey_blocks: false });
  assert.equal(fs.readFileSync(qc, "utf8"), before);
  assert.equal(result.status, "GREEN");
  assert.equal(result.sha256, sha);
});

test("keyframeRequire adds tool keys when the shot carries a prop", () => {
  const shot = {
    id: "SH01",
    index: 0,
    heading: "1",
    size: "medium",
    location: "x",
    action: "a",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
      { characterId: "B", start: { x: 70, y: 50 }, end: { x: 70, y: 50 }, facing: 1, handL: { x: 66, y: 45 }, handR: { x: 74, y: 45 }, footL: { x: 68, y: 80 }, footR: { x: 72, y: 80 }, gait: "plant" },
    ],
    props: [{ name: "曲轅犁", heldBy: "A", shape: ["弯", "木", "插入"], forbid: ["锹", "铲", "锄"] }],
    stillPrompt: "",
    motionPrompt: "",
  } as const;
  const req = keyframeRequire(shot as unknown as Parameters<typeof keyframeRequire>[0]);
  assert.equal(req.people_count, 2);
  assert.equal(req.grey_blocks, false);
  assert.equal(req.location, "x");
  assert.equal(req.action, "a");
  assert.equal(req.size, "medium");
  assert.equal(req.tool, "曲轅犁");
  assert.deepEqual(req.tool_shape, ["弯", "木", "插入"]);
  assert.deepEqual(req.tool_forbid, ["锹", "铲", "锄"]);
});

test("resolveSecondEye: opts arm :4000 glm-5.3-flash", () => {
  const cfg = resolveSecondEye({ secondEndpoint: "http://127.0.0.1:4000", secondModel: "glm-5.3-flash" });
  assert.deepEqual(cfg, { endpoint: "http://127.0.0.1:4000", model: "glm-5.3-flash" });
});

test("resolveSecondEye: empty endpoint ⇒ null (skip, not fail); env arms with default model", () => {
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  const prevM = process.env.SLATECREW_SECOND_MODEL;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_MODEL;
  try {
    assert.equal(resolveSecondEye(), null);
    assert.equal(resolveSecondEye({ secondEndpoint: "   " }), null);
    process.env.SLATECREW_SECOND_ENDPOINT = "http://127.0.0.1:4000";
    assert.deepEqual(resolveSecondEye(), { endpoint: "http://127.0.0.1:4000", model: "glm-5.3-flash" });
    assert.deepEqual(resolveSecondEye({ secondModel: "glm-5.3" }), { endpoint: "http://127.0.0.1:4000", model: "glm-5.3" });
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    if (prevM === undefined) delete process.env.SLATECREW_SECOND_MODEL;
    else process.env.SLATECREW_SECOND_MODEL = prevM;
  }
});

test("judgeSecondEye: glm grey on a grey-banned shot fails second_eye", () => {
  const v = judgeSecondEye(
    { people_count: 1, grey_blocks: false },
    { blind: "一個灰色人形剪影企喺房中間。", summary: { grey_blocks: true } },
  );
  assert.equal(v.ok, false);
  assert.ok(v.reason?.includes("second_eye"));
});

test("judgeSecondEye: blind-only grey also fails; clean stays ok", () => {
  assert.equal(
    judgeSecondEye({ grey_blocks: false }, { blind: "牆邊有幾個灰色方塊。", summary: { grey_blocks: false } }).ok,
    false,
  );
  assert.equal(
    judgeSecondEye({ grey_blocks: false }, { blind: "兩個人企喺茶餐廳門口。", summary: { grey_blocks: false } }).ok,
    true,
  );
});

test("judgeSecondEye: no grey ban or degraded summary ⇒ skip (first eye + machine grey still gate)", () => {
  assert.equal(
    judgeSecondEye({ people_count: 1 }, { blind: "灰色方塊", summary: { grey_blocks: true } }).ok,
    true,
  );
  assert.equal(
    judgeSecondEye({ grey_blocks: false }, { blind: "灰色方塊", summary: { parse_error: "boom", raw: "x" } }).ok,
    true,
  );
});

test("runSecondEye: sequential describe then summarize against a local fixture", async () => {
  const http = await import("node:http");
  const calls: unknown[] = [];
  const server = http.createServer((_req, res) => {
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      const content = (JSON.parse(body) as { messages: { content: unknown }[] }).messages[0]!.content;
      calls.push(content);
      const reply = calls.length === 1
        ? "兩個人企喺茶餐廳門口，地面濕。"
        : '{"people_count":2,"grey_blocks":false}';
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  try {
    const png = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sc-se-")), "f.png");
    fs.writeFileSync(png, Buffer.from("89504e470d0a1a2a0000", "hex"));
    const rec = await runSecondEye(`http://127.0.0.1:${port}`, "glm-5.3-flash", png);
    assert.equal(calls.length, 2); // 拆步: exactly one describe + one summarize, awaited in order
    assert.ok(Array.isArray(calls[0]), "describe sends image parts");
    assert.equal(typeof calls[1], "string", "summarize sends the blind text only");
    assert.ok(rec.blind.includes("茶餐廳"));
    assert.equal((rec.summary as { grey_blocks?: boolean }).grey_blocks, false);
    assert.equal(rec.model, "glm-5.3-flash");
  } finally {
    server.close();
  }
});

test("keyframeRequire has no tool keys without props", () => {
  const shot = {
    id: "SH01",
    index: 0,
    heading: "1",
    size: "medium",
    location: "x",
    action: "a",
    dialogue: "",
    durationSec: 4,
    camera: { pos: { x: 0, y: -5, z: 1.7 }, lookAt: { x: 0, y: 0, z: 1.2 }, lensMm: 35 },
    marks: [
      { characterId: "A", start: { x: 30, y: 50 }, end: { x: 30, y: 50 }, facing: 1, handL: { x: 34, y: 45 }, handR: { x: 36, y: 45 }, footL: { x: 28, y: 80 }, footR: { x: 32, y: 80 }, gait: "plant" },
    ],
    stillPrompt: "",
    motionPrompt: "",
  } as const;
  const req = keyframeRequire(shot as unknown as Parameters<typeof keyframeRequire>[0]);
  assert.equal(req.people_count, 1);
  assert.equal(req.location, "x");
  assert.equal(req.action, "a");
  assert.equal(req.size, "medium");
  assert.equal("tool" in req, false);
  assert.equal("tool_shape" in req, false);
  assert.equal("tool_forbid" in req, false);
});

test("T35 A2: street write-up vs 總統府地下審判室 fails with hit counts", () => {
  const street = "两人跪在湿漉漉的街道上，远处有霓虹灯牌和路灯。";
  const v = judge(
    street,
    { grey_blocks: false, location_notes: "wet street, neon" },
    { grey_blocks: false, location: "總統府地下審判室" },
  );
  assert.equal(v.status, "FAIL");
  assert.ok(
    v.checks.fail_reasons.some((r) => r.startsWith("location: hits 0/4")),
    v.checks.fail_reasons.join(" | "),
  );
});

test("T35 A3: unparseable location require fails loud, never auto-passes", () => {
  const v = judge(DESC, { grey_blocks: false }, { grey_blocks: false, location: "府" });
  assert.equal(v.status, "FAIL");
  assert.ok(
    v.checks.fail_reasons.some((r) => r.includes("location: require unparseable")),
    v.checks.fail_reasons.join(" | "),
  );
  const v2 = judge(DESC, { grey_blocks: false }, { grey_blocks: false, action: "企" });
  assert.ok(
    v2.checks.fail_reasons.some((r) => r.includes("action: require unparseable")),
    v2.checks.fail_reasons.join(" | "),
  );
});

test("T35 item3: medium needs scale evidence; none => size: unmeasured", () => {
  const v1 = judge(
    "一人企喺房中间。",
    { grey_blocks: false, size_notes: "unknown" },
    { grey_blocks: false, size: "medium" },
  );
  assert.ok(
    v1.checks.fail_reasons.some((r) => r.includes("size: unmeasured")),
    v1.checks.fail_reasons.join(" | "),
  );
  const v2 = judge(DESC, { grey_blocks: false }, { grey_blocks: false, size: "medium" });
  assert.equal(v2.status, "GREEN", v2.checks.fail_reasons.join(" | "));
});

test("T35 A1: empty grey still fails grey_leak through runPhotoQc", async () => {
  const http = await import("node:http");
  const sharp = (await import("sharp")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35-a1-"));
  const png = path.join(dir, "SH01.png");
  await sharp({ create: { width: 640, height: 360, channels: 3, background: { r: 122, g: 122, b: 122 } } }).png().toFile(png);
  const server = http.createServer((_req, res) => {
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      if ((_req.url ?? "").includes("/v1/models")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "fixture-eye" }] }));
        return;
      }
      const content = (JSON.parse(body) as { messages: { content: unknown }[] }).messages[0]!.content;
      const reply = Array.isArray(content)
        ? "一个人企喺房中间。"
        : '{"people_count":1,"grey_blocks":false,"size_notes":"medium"}';
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const rec = await runPhotoQc(
      png,
      path.join(dir, "SH01.photo_qc.json"),
      { people_count: 1, grey_blocks: false, size: "medium" },
      {},
      { first: { url: `http://127.0.0.1:${port}`, model: "fixture-eye" } },
    );
    assert.equal(rec.status, "FAIL");
    assert.ok(
      rec.checks.fail_reasons.some((r) => r.startsWith("grey_leak:")),
      rec.checks.fail_reasons.join(" | "),
    );
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    server.close();
  }
});

test("T35 item5: un-armed second eye caps GREEN at PASS_UNCONFIRMED; arming upgrades", async () => {
  const http = await import("node:http");
  const sharp = (await import("sharp")).default;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t35-pu-"));
  const png = path.join(dir, "SH02.png");
  // noisy frame: photoreal-ish so the grey/empty gate stays quiet
  const noise = Buffer.from(Array.from({ length: 640 * 360 * 3 }, () => Math.floor(Math.random() * 256)));
  await sharp(noise, { raw: { width: 640, height: 360, channels: 3 } }).png().toFile(png);
  const mkServer = (desc: string, summary: string) =>
    http.createServer((_req, res) => {
      let body = "";
      _req.on("data", (c) => (body += c));
      _req.on("end", () => {
        if ((_req.url ?? "").includes("/v1/models")) {
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ data: [{ id: "fixture-eye" }] }));
          return;
        }
        const content = (JSON.parse(body) as { messages: { content: unknown }[] }).messages[0]!.content;
        const reply = Array.isArray(content) ? desc : summary;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
      });
    });
  const eye = mkServer("两个人企喺茶餐厅门口，地面湿，背景霓虹灯。", '{"people_count":2,"grey_blocks":false,"size_notes":"medium"}');
  const second = mkServer("两个人企喺茶餐厅门口。", '{"people_count":2,"grey_blocks":false}');
  await new Promise<void>((r) => eye.listen(0, "127.0.0.1", r));
  await new Promise<void>((r) => second.listen(0, "127.0.0.1", r));
  const eyePort = (eye.address() as { port: number }).port;
  const sePort = (second.address() as { port: number }).port;
  const prevE = process.env.SLATECREW_SECOND_ENDPOINT;
  const prevM = process.env.SLATECREW_SECOND_MODEL;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_MODEL;
  const qc = path.join(dir, "SH02.photo_qc.json");
  try {
    const un = await runPhotoQc(png, qc, { people_count: 2, grey_blocks: false, size: "medium" }, {}, { first: { url: `http://127.0.0.1:${eyePort}`, model: "fixture-eye" } });
    assert.equal(un.status, "PASS_UNCONFIRMED", un.checks.fail_reasons.join(" | "));
    const before = fs.readFileSync(qc, "utf8");
    // un-armed re-run: PASS_UNCONFIRMED receipt is a valid cache hit (no re-run)
    const cached = await runPhotoQc(png, qc, { people_count: 2, grey_blocks: false, size: "medium" }, {}, { first: { url: `http://127.0.0.1:${eyePort}`, model: "fixture-eye" } });
    assert.equal(fs.readFileSync(qc, "utf8"), before);
    assert.equal(cached.status, "PASS_UNCONFIRMED");
    // PASS_UNCONFIRMED never pins - second eye is the acceptance floor
    assert.equal(pinQcAccepted(dir, "SH02"), false);
    // arming the second eye busts the cache and upgrades to GREEN
    process.env.SLATECREW_SECOND_ENDPOINT = `http://127.0.0.1:${sePort}`;
    const armed = await runPhotoQc(png, qc, { people_count: 2, grey_blocks: false, size: "medium" }, {}, { first: { url: `http://127.0.0.1:${eyePort}`, model: "fixture-eye" } });
    assert.equal(armed.status, "GREEN");
    assert.equal(armed.second?.model, "glm-5.3-flash");
    assert.notEqual(fs.readFileSync(qc, "utf8"), before);
    // armed GREEN pins again
    assert.equal(pinQcAccepted(dir, "SH02"), true);
  } finally {
    if (prevE === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prevE;
    if (prevM === undefined) delete process.env.SLATECREW_SECOND_MODEL;
    else process.env.SLATECREW_SECOND_MODEL = prevM;
    eye.close();
    second.close();
  }
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
