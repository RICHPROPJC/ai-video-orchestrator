import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import sharp from "sharp";
import { runCli } from "./photo-qc-cli";

/** Same three-door idiom as photo-qc.test.ts (store.test.ts house pattern). */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

import http from "node:http";

/** Local stub eye with the same wire shape as the photo-qc.test fixtures:
 *  /v1/models serves mars-fa2; describe→desc, summarize→summary. */
function stubEyeNode(desc: string, summary: string) {
  let calls = 0;
  const server = http.createServer((_req, res) => {
    let body = "";
    _req.on("data", (c) => (body += c));
    _req.on("end", () => {
      if ((_req.url ?? "").includes("/v1/models")) {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ data: [{ id: "mars-fa2" }] }));
        return;
      }
      calls += 1;
      const content = (JSON.parse(body) as { messages: { content: unknown }[] }).messages[0]!.content;
      const reply = Array.isArray(content) ? desc : summary;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: reply } }] }));
    });
  });
  return { server, calls: () => calls };
}

const REQUIRE_JSON = { people_count: 1, grey_blocks: false, size: "medium" };

async function mkPng(dir: string, name: string, kind: "allblack" | "allwhite" | "portrait") {
  const file = path.join(dir, name);
  if (kind === "portrait") {
    const W = 640, H = 360, CUT = Math.floor(H * 0.7);
    const buf = Buffer.alloc(W * H * 3);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 3;
      if (y < CUT) { buf[o] = 122; buf[o + 1] = 122; buf[o + 2] = 122; }
      else { buf[o] = Math.floor(Math.random() * 256); buf[o + 1] = Math.floor(Math.random() * 256); buf[o + 2] = Math.floor(Math.random() * 256); }
    }
    await sharp(buf, { raw: { width: W, height: H, channels: 3 } }).png().toFile(file);
    return file;
  }
  const rgb = kind === "allblack" ? { r: 10, g: 10, b: 10 } : { r: 245, g: 245, b: 245 };
  await sharp({ create: { width: 640, height: 360, channels: 3, background: rgb } }).png().toFile(file);
  return file;
}

test("T40 E1: all-black still fails empty_frame through the CLI with exit 1", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t40-"));
  const png = await mkPng(dir, "SH09.png", "allblack");
  const requirePath = path.join(dir, "require.json");
  fs.writeFileSync(requirePath, JSON.stringify(REQUIRE_JSON));
  const eye = stubEyeNode("一个人企喺房中间。", '{"people_count":1,"grey_blocks":false,"size_notes":"medium"}');
  await new Promise<void>((r) => eye.server.listen(0, "127.0.0.1", r));
  const port = (eye.server.address() as { port: number }).port;
  const prev = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const res = await runCli([png, "--require", requirePath], { first: { url: `http://127.0.0.1:${port}`, model: "mars-fa2" } });
    assert.equal(res.code, 1);
    assert.equal(res.record?.status, "FAIL");
    assert.ok(
      (res.record?.checks?.fail_reasons ?? []).some((r) => r.startsWith("empty_frame: dark")),
      JSON.stringify(res.record?.checks?.fail_reasons),
    );
    // default --out lands beside the png as <stem>.photo_qc.json
    assert.ok(fs.existsSync(path.join(dir, "SH09.photo_qc.json")));
  } finally {
    if (prev === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prev;
    eye.server.close();
  }
});

test("T40 E2: plain-studio portrait does not grey-fail — exit 0 PASS_WITH_WARN", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t40-"));
  const png = await mkPng(dir, "PA.png", "portrait");
  const requirePath = path.join(dir, "require.json");
  fs.writeFileSync(requirePath, JSON.stringify(REQUIRE_JSON));
  const eye = stubEyeNode("一个人企喺净色背景前。", '{"people_count":1,"grey_blocks":false,"size_notes":"medium"}');
  await new Promise<void>((r) => eye.server.listen(0, "127.0.0.1", r));
  const port = (eye.server.address() as { port: number }).port;
  const prev = process.env.SLATECREW_SECOND_ENDPOINT;
  delete process.env.SLATECREW_SECOND_ENDPOINT;
  try {
    const res = await runCli([png, "--require", requirePath], { first: { url: `http://127.0.0.1:${port}`, model: "mars-fa2" } });
    assert.equal(res.code, 0, JSON.stringify(res.record?.checks));
    assert.equal(res.record?.status, "PASS_WITH_WARN");
    assert.ok((res.record?.checks?.warns as string[]).some((w) => w.includes("grey_watch")));
  } finally {
    if (prev === undefined) delete process.env.SLATECREW_SECOND_ENDPOINT;
    else process.env.SLATECREW_SECOND_ENDPOINT = prev;
    eye.server.close();
  }
});

test("T40: empty require object goes through the gate — exit 1 cannot accept", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t40-"));
  const png = await mkPng(dir, "SH10.png", "allblack");
  const requirePath = path.join(dir, "require.json");
  fs.writeFileSync(requirePath, "{}");
  // parseable summary so the parse_error path does not mask the gate's verdict
  const eye = stubEyeNode("x", '{"people_count":null}');
  await new Promise<void>((r) => eye.server.listen(0, "127.0.0.1", r));
  const port = (eye.server.address() as { port: number }).port;
  try {
    const res = await runCli([png, "--require", requirePath], { first: { url: `http://127.0.0.1:${port}`, model: "mars-fa2" } });
    assert.equal(res.code, 1);
    assert.ok((res.record?.checks?.fail_reasons ?? []).some((r) => r.includes("no require: cannot accept")));
  } finally {
    eye.server.close();
  }
});

test("T40: usage errors exit 2 without touching an eye", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-t40-"));
  assert.equal((await runCli([])).code, 2);
  assert.equal((await runCli(["--require", "x"])).code, 2);
  const missing = path.join(dir, "nope.png");
  assert.equal((await runCli([missing, "--require", path.join(dir, "r.json")])).code, 2);
  const png = await mkPng(dir, "SH11.png", "allblack");
  assert.equal((await runCli([png, "--require", path.join(dir, "absent.json")])).code, 2);
});

test("T40 E3: the CLI carries zero copied gates — rg lock", () => {
  const here = path.resolve("src/lib/studio"); // runner-neutral (import.meta.dir is bun-only)
  const cli = fs.readFileSync(path.join(here, "photo-qc-cli.ts"), "utf8");
  assert.ok(!/judge|gramMatch/.test(cli), "CLI must not name or reimplement gate internals");
  assert.ok(/runPhotoQc/.test(cli), "CLI must go through runPhotoQc");
  const mainCliPath = path.resolve("src/cli.ts");
  if (fs.existsSync(mainCliPath)) {
    const main = fs.readFileSync(mainCliPath, "utf8");
    assert.ok(!/judge|gramMatch/.test(main), "src/cli.ts must not reimplement gate internals either");
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
