import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { verifyJobStatus, ffprobeOk, sha256File, type FfprobeResult } from "./receipts";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "wb-rcpt-"));
const jobsDir = path.join(tmp, "jobs");
const okProbe = (): FfprobeResult => ({ ok: true, durationS: 4.2 });

function mkJob(job: string, spec: {
  status: string;
  outputs?: Record<string, unknown>;
  updatedAt?: string;
}) {
  const dir = path.join(jobsDir, job);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({ id: job, status: spec.status, updatedAt: spec.updatedAt ?? "2026-09-23T12:00:00.000Z", outputs: { stills: [], shots: [], blockout: [], receipts: [], ...spec.outputs } }, null, 2),
  );
  return dir;
}

test("receipts: verified——stills＋片（注入探針）件件存在，時長>0", () => {
  const dir = mkJob("SC-V", { status: "motion-ready", outputs: { stills: ["stills/SH01.png"], shots: ["motion/SH01.mp4"] } });
  fs.mkdirSync(path.join(dir, "stills"), { recursive: true });
  fs.writeFileSync(path.join(dir, "stills", "SH01.png"), "png-bytes");
  fs.mkdirSync(path.join(dir, "motion"), { recursive: true });
  fs.writeFileSync(path.join(dir, "motion", "SH01.mp4"), "mp4-bytes");
  const stamped = new Date(Date.now() + 60_000).toISOString();
  fs.writeFileSync(
    path.join(dir, "job.json"),
    JSON.stringify({ id: "SC-V", status: "motion-ready", updatedAt: stamped, outputs: { stills: ["stills/SH01.png"], shots: ["motion/SH01.mp4"], blockout: [], receipts: [] } }),
  );
  const r = verifyJobStatus("SC-V", { jobsDir, ffprobeImpl: okProbe });
  assert.equal(r.verdict, "verified");
  assert.equal(r.claimingStatus, true);
  assert.equal(r.artifacts.length, 2);
  assert.ok(r.artifacts.every((a) => a.sha256 && a.exists));
  assert.equal(r.artifacts.find((a) => a.path === "motion/SH01.mp4")!.durationS, 4.2);
  assert.match(r.why, /2 件實物過驗/);
});

test("receipts: contradicted——claim motion-ready 但片碟上唔存在（LM1L 式大話閘）", () => {
  const dir = mkJob("SC-L", { status: "motion-ready", outputs: { stills: ["stills/SH01.png"], shots: ["motion/SH01.mp4"] } });
  fs.mkdirSync(path.join(dir, "stills"), { recursive: true });
  fs.writeFileSync(path.join(dir, "stills", "SH01.png"), "png-bytes");
  const r = verifyJobStatus("SC-L", { jobsDir, ffprobeImpl: okProbe });
  assert.equal(r.verdict, "contradicted");
  assert.match(r.why, /碟上唔存在/);
  assert.equal(r.artifacts.find((a) => a.path === "stills/SH01.png")!.exists, true);
  assert.equal(r.artifacts.find((a) => a.path === "motion/SH01.mp4")!.exists, false);
});

test("receipts: contradicted——檔喺但 ffprobe 讀唔到時長（占位／爛片）", () => {
  const dir = mkJob("SC-F", { status: "blockout-ready", outputs: { blockout: ["blockout/SH01.mp4"] } });
  fs.mkdirSync(path.join(dir, "blockout"), { recursive: true });
  fs.writeFileSync(path.join(dir, "blockout", "SH01.mp4"), "not-a-video");
  const badProbe = (): FfprobeResult => ({ ok: false, durationS: 0, reason: "duration<=0 或 format 缺失" });
  const r = verifyJobStatus("SC-F", { jobsDir, ffprobeImpl: badProbe });
  assert.equal(r.verdict, "contradicted");
  assert.match(r.why, /ffprobe 實測失敗/);
});

test("receipts: no-receipt——outputs 全空冇嘢可驗", () => {
  mkJob("SC-E", { status: "failed" });
  const r = verifyJobStatus("SC-E", { jobsDir, ffprobeImpl: okProbe });
  assert.equal(r.verdict, "no-receipt");
  assert.equal(r.claimingStatus, false);
});

test("receipts: no-receipt——claim 話出齊但 outputs 全空（另一種大話形）", () => {
  mkJob("SC-E2", { status: "stills-ready" });
  const r = verifyJobStatus("SC-E2", { jobsDir, ffprobeImpl: okProbe });
  assert.equal(r.verdict, "no-receipt");
  assert.equal(r.claimingStatus, true);
  assert.match(r.why, /全空/);
});

test("receipts: stale——實物 mtime 晚過 updatedAt，碟上改過而 claim 未跟", () => {
  const dir = mkJob("SC-S", { status: "boarded", outputs: { receipts: ["callsheet.json"] } });
  fs.writeFileSync(path.join(dir, "callsheet.json"), "{}");
  const later = new Date(Date.parse("2026-09-23T12:00:00.000Z") + 60_000);
  fs.utimesSync(path.join(dir, "callsheet.json"), later, later);
  const r = verifyJobStatus("SC-S", { jobsDir, ffprobeImpl: okProbe });
  assert.equal(r.verdict, "stale");
  assert.match(r.why, /mtime 晚過/);
});

test("receipts: job.json 唔存在／解唔開——no-receipt，唔爆 exception", () => {
  assert.equal(verifyJobStatus("SC-NOTHING", { jobsDir, ffprobeImpl: okProbe }).verdict, "no-receipt");
  const dir = path.join(jobsDir, "SC-BAD");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "job.json"), "{爛json");
  assert.equal(verifyJobStatus("SC-BAD", { jobsDir, ffprobeImpl: okProbe }).verdict, "no-receipt");
});

test("receipts: 淨出報告——job.json 未被改寫", () => {
  const dir = mkJob("SC-RO", { status: "motion-ready", outputs: { shots: ["motion/SH01.mp4"] } });
  const before = fs.readFileSync(path.join(dir, "job.json"), "utf8");
  verifyJobStatus("SC-RO", { jobsDir, ffprobeImpl: okProbe });
  assert.equal(fs.readFileSync(path.join(dir, "job.json"), "utf8"), before);
});

test("receipts: ffprobeOk 真機——真片時長>0，假片 fail（有 ffmpeg 先行）", (t) => {
  let ffmpeg = "/usr/bin/ffmpeg";
  try {
    execFileSync(ffmpeg, ["-version"], { stdio: "pipe" });
  } catch {
    t.skip("冇 ffmpeg，跳過真機探針");
    return;
  }
  const real = path.join(tmp, "real.mp4");
  execFileSync(ffmpeg, [
    "-f", "lavfi", "-i", "color=c=black:s=64x64:d=0.5",
    "-frames:v", "12", "-y", real,
  ], { stdio: "pipe" });
  const p = ffprobeOk(real);
  assert.equal(p.ok, true);
  assert.ok(p.durationS > 0);
  const fake = path.join(tmp, "fake.mp4");
  fs.writeFileSync(fake, "text");
  const bad = ffprobeOk(fake);
  assert.equal(bad.ok, false);
});

test("receipts: sha256File 同 node crypto 對齊", () => {
  const f = path.join(tmp, "h.txt");
  fs.writeFileSync(f, "hello");
  assert.equal(sha256File(f), "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824");
});

after(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});
