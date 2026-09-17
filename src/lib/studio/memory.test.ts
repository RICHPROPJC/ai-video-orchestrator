import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  applyMemoryDistances,
  blockoutCopy,
  characterDrift,
  COPY_MIN,
  DRIFT_MAX,
  ingestVector,
  queryRefs,
  cosine,
  distance,
  type EmbedFn,
} from "./memory";
import type { VideoQcRecord } from "./video-qc";

const origCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "sc-mem-"));

test("cosine is 1 for identical vectors and drift/copy thresholds fire", () => {
  const a = [1, 0, 0, 0];
  const b = [1, 0, 0, 0];
  const far = [0, 1, 0, 0];
  assert.equal(cosine(a, b), 1);
  assert.equal(distance(a, b), 0);
  assert.equal(characterDrift(a, far).fail, true);
  assert.ok(characterDrift(a, far).distance > DRIFT_MAX);
  assert.equal(blockoutCopy(a, b).fail, true);
  assert.ok(blockoutCopy(a, b).distance < COPY_MIN);
  assert.equal(blockoutCopy(a, far).fail, false);
});

test("sqlite store query stills by REAL cosine under projects/<ep>/memory/", async (t) => {
  t.after(() => {
    process.chdir(origCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  process.chdir(tmp);
  ingestVector({
    ep: "SC-A2-MEM",
    shot: "SH01",
    kind: "still",
    character: "A",
    scene: "plaza",
    rel: "stills/SH01.png",
    vector: [1, 0, 0, 0],
  });
  ingestVector({
    ep: "SC-A2-MEM",
    shot: "SH02",
    kind: "still",
    character: "A",
    scene: "plaza",
    rel: "stills/SH02.png",
    vector: [1, 1, 0, 0],
  });
  ingestVector({
    ep: "SC-A2-MEM",
    shot: "SH03",
    kind: "still",
    character: "B",
    scene: "plaza",
    rel: "stills/SH03.png",
    vector: [0, 1, 0, 0],
  });
  // T44 R5: the hit score is computed against the query's own embedding —
  // a query of [2,0,0,0] ranks SH01 (cos 1) above SH02 (cos 1/√2); B is
  // filtered by character; no query file can never fabricate hits
  fs.writeFileSync(path.join(tmp, "query.png"), "png");
  const fakeEmbed: EmbedFn = async (file) =>
    path.basename(file) === "query.png" ? [2, 0, 0, 0] : [0, 0, 0, 0];
  const hits = await queryRefs("SC-A2-MEM", {
    queryFile: path.join(tmp, "query.png"),
    characters: ["A"],
    k: 3,
    embed: fakeEmbed,
  });
  assert.equal(hits.length, 2);
  assert.equal(hits[0]?.shot, "SH01");
  assert.equal(hits[0]?.cosine, 1);
  assert.ok(Math.abs((hits[1]?.cosine ?? 0) - 1 / Math.sqrt(2)) < 1e-9);
  assert.equal(hits[1]?.shot, "SH02");
  const noQuery = await queryRefs("SC-A2-MEM", { characters: ["A"], k: 3, embed: fakeEmbed });
  assert.equal(noQuery.length, 0);
  assert.ok(fs.existsSync(path.join(tmp, "projects", "SC-A2-MEM", "memory", "memory.sqlite")));
});

test("applyMemoryDistances FAILs video_qc on drift or blockout-copy", () => {
  const base: VideoQcRecord = {
    tool: "slatecrew.video_qc",
    ts: "t",
    video: "x.mp4",
    sha256: "0",
    endpoint: "fixture",
    model: "fixture",
    require: { people_count: 1 },
    status: "GREEN",
    frames: [],
    checks: { status: "GREEN", fail_reasons: [] },
  };
  const drifted = applyMemoryDistances(base, {
    drift: { distance: 0.9, fail: true, reason: "character_drift 0.900>0.45" },
  });
  assert.equal(drifted.status, "FAIL");
  assert.ok(drifted.checks.fail_reasons.some((r) => r.startsWith("character_drift")));
  assert.equal(drifted.memory?.character_drift?.fail, true);
  const copy = applyMemoryDistances(base, {
    copy: { distance: 0.01, fail: true, reason: "blockout_copy 0.010<0.12" },
  });
  assert.equal(copy.status, "FAIL");
  assert.ok(copy.checks.fail_reasons.some((r) => r.startsWith("blockout_copy")));
});
