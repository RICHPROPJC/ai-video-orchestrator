import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bench, classifyError, failKindsFromReasons, markdownReport } from "./bench";

function tmpJobs(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bench-"));
}

function write(file: string, obj: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, typeof obj === "string" ? obj : JSON.stringify(obj));
}

function makeFixture(): string {
  const root = tmpJobs();

  // SC-A：燒咗兩鏡，一綠一 grey FAIL，blocked 喺 video_qc
  const a = path.join(root, "SC-A");
  write(path.join(a, "job.json"), { status: "blocked", error: "video_qc 未 GREEN（SH02）— 唔准 motion-ready" });
  write(path.join(a, "stills", "SH01.photo_qc.json"), { status: "GREEN" });
  write(path.join(a, "stills", "SH02.photo_qc.json"), { status: "FAIL" });
  write(path.join(a, "motion", "SH01.h3_submit.json"), { graph_variant: "a", steps: 4, seconds: 6.5 });
  write(path.join(a, "motion", "SH01.video_qc.json"), { status: "GREEN" });
  write(path.join(a, "motion", "SH02.h3_submit.json"), { graph_variant: "bkf", steps: 4, seconds: 8.0 });
  write(
    path.join(a, "motion", "SH02.video_qc.json"),
    {
      status: "FAIL",
      checks: { fail_reasons: ["f48: grey_blocks: 灰影入鏡", "f0: action: 漏 token", "f96: grey_blocks: 又灰"] },
    },
  );
  write(
    path.join(a, "violations.jsonl"),
    [
      JSON.stringify({ step_id: "boards", constraint_id: "c1", severity: "hard", saw: 1, expected: 2 }),
      JSON.stringify({ step_id: "keyframe-prompt", constraint_id: "c2", severity: "soft", saw: "x", expected: "x" }),
    ].join("\n") + "\n",
  );

  // SC-B：死喺 boards 席
  const b = path.join(root, "SC-B");
  write(path.join(b, "job.json"), { status: "failed", error: "seat boards could not produce valid SC02 after 3 attempts" });

  // SC-C：429
  const c = path.join(root, "SC-C");
  write(path.join(c, "job.json"), { status: "failed", error: "HTTP 429: RateLimitError tpm/rpm" });
  return root;
}

test("classifyError 分層", () => {
  assert.equal(classifyError("seat boards could not produce valid SC02 after 3 attempts"), "boards");
  assert.equal(classifyError("seat writer outline: HTTP 429 RateLimitError"), "llm-429");
  assert.equal(classifyError("video_qc 未 GREEN（SH02）— 唔准 motion-ready"), "video-qc-block");
  assert.equal(classifyError(undefined), null);
});

test("failKindsFromReasons：kind 去重", () => {
  assert.deepEqual(
    failKindsFromReasons(["f48: grey_blocks: a", "f0: action: b", "f96: grey_blocks: c", "冇 match"]),
    ["action", "grey_blocks"],
  );
});

test("bench 聚合：variant 綠率、直方圖、slate 死因、violations 計數", () => {
  const r = bench(makeFixture());
  assert.equal(r.slates.length, 3);

  const a = r.slates.find((s) => s.slate === "SC-A")!;
  assert.equal(a.status, "blocked");
  assert.equal(a.errorClass, "video-qc-block");
  assert.deepEqual(a.stills, { green: 1, fail: 1 });
  assert.equal(a.hard, 1);
  assert.equal(a.soft, 1);

  const va = r.variants["a"]!;
  assert.equal(va.shots, 1);
  assert.equal(va.green, 1);
  assert.equal(va.avgSeconds, 6.5);

  const vbkf = r.variants["bkf"]!;
  assert.equal(vbkf.shots, 1);
  assert.equal(vbkf.green, 0);
  assert.deepEqual(vbkf.failKinds, { grey_blocks: 1, action: 1 }); // grey_blocks 同鏡去重後計一

  assert.equal(r.slates.find((s) => s.slate === "SC-B")!.errorClass, "boards");
  assert.equal(r.slates.find((s) => s.slate === "SC-C")!.errorClass, "llm-429");
});

test("markdownReport 有兩張表、variant 行齊", () => {
  const md = markdownReport(bench(makeFixture()));
  assert.ok(md.includes("## graph variants"));
  assert.ok(md.includes("| bkf | 1 | 0 | 0%"));
  assert.ok(md.includes("## slates"));
  assert.ok(md.includes("| SC-A | blocked | video-qc-block | 1/1 | 1/1 | 1/1 |"));
});
