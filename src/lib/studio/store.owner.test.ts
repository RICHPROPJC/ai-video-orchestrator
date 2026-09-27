import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { acquireJob, emit, ownerIsStale, readJob, readOwner, releaseJob, takeoverJob, writeJob, OwnerLostError } from "./store";
import { dataRoot } from "./paths";
import type { JobRecord } from "./types";

/** V2a（PLAN-v2 0928）：唯一執行者行為鎖——原子取權／接管後舊 owner 失效／
 *  release 後可再取。cwd/data 指去 scratch（同 store.test.ts scratch pattern）。 */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

function blank(id: string): JobRecord {
  return {
    id,
    slate: id,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: "queued",
    input: { brief: "test", wavDir: "" },
    progress: 0,
    retries: { stills: 0, voice: 0, motion: 0 },
    outputs: { stills: [], shots: [], blockout: [], receipts: [] },
  };
}

async function scratch(fn: () => void | Promise<void>) {
  const cwd = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "owner-lock-"));
  process.chdir(tmp);
  try {
    await fn();
  } finally {
    process.chdir(cwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test("原子取權：兩個 process 同搶只有一個成功", () =>
  scratch(() => {
    fs.mkdirSync(path.join(dataRoot(), "J1"), { recursive: true });
    const a = acquireJob("J1", 111);
    const b = acquireJob("J1", 222);
    assert.ok(a.ok, "第一個 acquire 應成功");
    assert.ok(!b.ok, "第二個 acquire 應撞鎖");
    if (!b.ok) assert.equal(b.holder?.pid, 111, "撞鎖要報現行 holder");
  }));

test("接管後舊 owner 再寫＝OwnerLostError；新 owner 寫過", () =>
  scratch(() => {
    fs.mkdirSync(path.join(dataRoot(), "J2"), { recursive: true });
    writeJob(blank("J2"));
    const a = acquireJob("J2", 111);
    assert.ok(a.ok);
    if (!a.ok) return;
    const ownerA = a.owner;
    writeJob({ ...blank("J2"), status: "running" }, ownerA);

    const ownerB = takeoverJob("J2", "test takeover");
    assert.ok(ownerB.epoch > ownerA.epoch, "epoch 單調遞增");

    assert.throws(
      () => writeJob({ ...blank("J2"), status: "running" }, ownerA),
      OwnerLostError,
      "舊 owner 恢復後唔准再寫",
    );
    writeJob({ ...blank("J2"), status: "running" }, ownerB);
    const onDisk = JSON.parse(fs.readFileSync(path.join(dataRoot(), "J2", "job.json"), "utf8")) as JobRecord;
    assert.equal(onDisk.ownerEpoch, ownerB.epoch, "job.json 記錄當時 epoch");
    void readOwner;
  }));

test("release 後可再取；ownerIsStale 對冇鎖 job 返 true", () =>
  scratch(() => {
    assert.ok(ownerIsStale("J3"), "冇 owner 檔＝可取");
    fs.mkdirSync(path.join(dataRoot(), "J3"), { recursive: true });
    const a = acquireJob("J3", 111);
    assert.ok(a.ok);
    releaseJob("J3");
    const again = acquireJob("J3", 333);
    assert.ok(again.ok, "release 後再取應成功");
  }));

test("V3: emit data.blocked 自動入 blockedShots；pass verdict 清返", () =>
  scratch(() => {
    fs.mkdirSync(path.join(dataRoot(), "JB"), { recursive: true });
    writeJob(blank("JB"));
    emit("JB", { agent: "motion", level: "warn", message: "SH01 blocked", data: { shot: "SH01", stage: "motion", blocked: "identity_sheet_missing" } });
    let job = readJob("JB");
    assert.equal(job.blockedShots?.length, 1, "blocked 入帳");
    assert.equal(job.blockedShots![0]!.reason, "identity_sheet_missing");
    emit("JB", { agent: "motion", level: "warn", message: "SH02 blocked", data: { shot: "SH02", stage: "mux", blocked: "motion-missing:SH02" } });
    job = readJob("JB");
    assert.equal(job.blockedShots?.length, 2, "第二鏡 upsert");
    emit("JB", { agent: "pictureQc", level: "pass", message: "SH01 GREEN", data: { shot: "SH01", stage: "require", verdict: "pass" } });
    job = readJob("JB");
    assert.equal(job.blockedShots?.length, 1, "pass 清返嗰鏡");
    assert.equal(job.blockedShots![0]!.shot, "SH02", "淨返未解嗰鏡");
  }));

if (bareBun) {
  for (const c of cases) {
    Promise.resolve(c.fn()).catch(() => {});
  }
}
