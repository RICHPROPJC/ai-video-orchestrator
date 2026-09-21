import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  MOTION_LIB_ROOT,
  COMBAT_RANK_REL,
  buildCmuIndex,
  buildShortlist,
  parseCmuIndexText,
  parseCombatSweepRanking,
  parseDecisionLines,
  buildDecisionPrompt,
  chainConf,
  selectMotions,
  verbsForGate,
  verbGate,
  bakeFor,
  bvhClipFrames,
  decideSelection,
  writeSelections,
  blockoutPathFor,
  type Shortlist,
  type MotionShotLine,
  type CmuIndex,
} from "./motion-select";

const FIX = path.resolve(process.cwd(), "src/lib/studio/motion-select-fixtures");
const LIB = MOTION_LIB_ROOT;

function trialShortlist(): Shortlist {
  return JSON.parse(fs.readFileSync(path.join(FIX, "trial-shortlist.json"), "utf8")) as Shortlist;
}

function trialGold(): { rows: { shot: string; pick: string; pick_id: string; conf: number; reason: string; runner_detail: { id: string | null }[] }[] } {
  return JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-gold.json"), "utf8"));
}

/** mock :8015 replaying the frozen trial token stream: logprobs.content is
 *  rebuilt position-by-position from decision_raw.json (tokens × top-20) */
function trialFetch(raw: { tokens: string[]; top_logprobs: { token: string; logprob: number }[][] }, content: string) {
  let calls = 0;
  const impl = (async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    void init;
    return new Response(
      JSON.stringify({
        choices: [
          {
            message: { content },
            logprobs: {
              content: raw.tokens.map((token, i) => ({ token, top_logprobs: raw.top_logprobs[i] ?? [] })),
            },
          },
        ],
        usage: {},
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }) as unknown as typeof fetch;
  return { impl, count: () => calls };
}

function goldRaw(): string {
  return (JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-gold.json"), "utf8")) as { raw: string }).raw;
}

function liveIndex(): CmuIndex | null {
  if (!fs.existsSync(path.join(LIB, "cmu-mocap/cmu-mocap-index-text.txt"))) return null;
  return buildCmuIndex(LIB);
}

test("index parse: subject headers + clip lines, zero-padded ids", () => {
  const text = [
    "Some preamble",
    "Subject #1 (category one)",
    "01_02\tplayground - climb",
    "1_3\tplayground - jump",
    "Subject #142 (occlusion)",
    "142_05\t",
  ].join("\n");
  const entries = parseCmuIndexText(text);
  assert.deepEqual([...entries.keys()].sort(), ["01_02", "01_03", "142_05"]);
  assert.equal(entries.get("01_03")!.subject, 1);
  assert.equal(entries.get("142_05")!.desc, "");
});

test("live index counts: 2548 BVH on disk / 2435 covered (trial receipt)", { skip: !fs.existsSync(path.join(LIB, "cmu-mocap/cmu-mocap-index-text.txt")) && "motion library not mounted" }, () => {
  const idx = liveIndex()!;
  assert.equal(idx.bvhOnDisk, 2548);
  assert.equal(idx.indexCovered, 2435);
  // no-description clips say so honestly, never silently blank
  const undescribed = idx.clips.filter((c) => c.desc === "(no CMU index description)");
  assert.equal(undescribed.length, 2548 - 2435);
  const i19 = idx.clips.find((c) => c.id === "111_19");
  assert.equal(i19!.category, "Pregnant Woman", "111_19 subject category rides the index (S1 lesson ①)");
});

test("combat sweep ranking: 73 clips, arm-axis numbers parse", { skip: !fs.existsSync(path.join(LIB, COMBAT_RANK_REL)) && "motion library not mounted" }, () => {
  const rank = parseCombatSweepRanking(fs.readFileSync(path.join(LIB, COMBAT_RANK_REL), "utf8"));
  assert.equal(rank.size, 73);
  assert.equal(rank.get("74_06")!.meanDeg, 20.2);
  assert.equal(rank.get("74_06")!.frames, 326);
});

test("live buildShortlist: caps exactly the trial caps, siblings deduped, codes unique", { skip: !fs.existsSync(path.join(LIB, "cmu-mocap/cmu-mocap-index-text.txt")) && "motion library not mounted" }, () => {
  const idx = liveIndex()!;
  const rank = parseCombatSweepRanking(fs.readFileSync(path.join(LIB, "out/combat_sweep_ranking.txt"), "utf8"));
  const sl = buildShortlist(idx, rank, []);
  assert.equal(sl.nCandidates, 120);
  const fams: Record<string, number> = {};
  for (const c of sl.candidates) fams[c.family] = (fams[c.family] ?? 0) + 1;
  assert.deepEqual(fams, { martial: 34, walk: 22, run: 14, bend_pick: 20, sit: 18, stand_idle: 12 });
  // trial lesson ②: same subject + same desc collapses to one (07_01 stays, 07_02/07_03 gone)
  const walk = sl.candidates.filter((c) => c.family === "walk").map((c) => c.id);
  assert.ok(walk.includes("07_01"), "the trial-picked sibling survives");
  assert.ok(!walk.includes("07_02") && !walk.includes("07_03"), "identical-desc siblings dedupe to one");
  const siblingGroups = new Map<string, number>();
  for (const c of sl.candidates) {
    const key = `${c.id.split("_")[0]}|${c.desc}`;
    siblingGroups.set(key, (siblingGroups.get(key) ?? 0) + 1);
  }
  assert.equal([...siblingGroups.values()].filter((v) => v > 1).length, 0, "zero sibling groups remain");
  // codes C01..C120 unique
  const codes = sl.candidates.map((c) => c.code);
  assert.equal(new Set(codes).size, 120);
  assert.equal(codes[119], "C120");
  // martial seeded by arm-axis ranking: C01 is rank #1 (74_06, mean 20.2)
  assert.equal(sl.candidates[0]!.id, "74_06");
  assert.match(sl.candidates[0]!.arm, /arm-axis mean 20deg/);
});

test("decision prompt lines carry the category (111_19 Pregnant Woman lesson)", () => {
  const sl = trialShortlist();
  const shots: MotionShotLine[] = [{ id: "SH01", heading: "FULL / x", action: "打兩拳再踢", durationSec: 4.82 }];
  const { user, system } = buildDecisionPrompt(sl, shots);
  const i19 = sl.candidates.find((c) => c.id === "111_19")!;
  assert.ok(user.includes(`${i19.code} 111_19 | Pregnant Woman |`), "category rides every candidate line");
  assert.ok(system.includes("one line per shot"));
  assert.ok(user.includes("[SH01] FULL / x"));
  assert.ok(user.includes("(4.82s"));
});

test("parseDecisionLines: strict rows incl. the three-digit C101 case", () => {
  const rows = parseDecisionLines(
    [
      "SH01 C13 | C44 C45 | covers the punch-kick sequence",
      "SX3 C101 | C102 C103 | sits on a stepstool and stays",
      "noise line without pipes",
      "SX2 C58 | C59 | only one runner-up is tolerated",
      "",
    ].join("\n"),
  );
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.pick, "C13");
  assert.deepEqual(rows[0]!.runner, ["C44", "C45"]);
  assert.equal(rows[1]!.pick, "C101");
  assert.equal(rows[2]!.runner.length, 1);
});

test("golden replay: frozen trial stream → picks, runners and chain-rule conf all hit", async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-raw.json"), "utf8")) as {
    tokens: string[];
    top_logprobs: { token: string; logprob: number }[][];
  };
  const gold = trialGold();
  const goldRawText = (JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-gold.json"), "utf8")) as { raw?: string }).raw;
  const content = goldRawText ?? "";
  assert.ok(content.includes("SH01 C13"), "gold carries the raw text for the mock");
  const mock = trialFetch(raw, content);
  const shots: MotionShotLine[] = [
    { id: "SH01", heading: "FULL / 地下室檔案室：拳腳收勢", action: "沈北辰企定打出兩記右直拳，轉身起左腳側踢，落地收勢。", durationSec: 4.82 },
    { id: "SH02", heading: "MEDIUM / 地下室檔案室：收拳定神", action: "沈北辰行前兩步停低，收拳定神。", durationSec: 4.82 },
    { id: "SX1", heading: "MEDIUM / 房間：跪低執嘢", action: "角色蹲低半跪，執起紙條，起身企直。", durationSec: 4.0 },
    { id: "SX2", heading: "FULL / 走廊：跑向門", action: "角色全速跑向門口，接近時減速。", durationSec: 4.0 },
    { id: "SX3", heading: "MEDIUM / 房間：坐低嘆氣", action: "角色拖椅坐低，垂頭嘆氣，坐定。", durationSec: 4.0 },
  ];
  const { rows, calls } = await selectMotions({ shots, shortlist: trialShortlist(), fetchImpl: mock.impl });
  assert.equal(calls, 1, "F2 one-call assertion: the frozen complete stream answers in ONE call");
  assert.equal(rows.length, 5);
  const expect: Record<string, { id: string; conf: number; runners: string[] }> = {
    SH01: { id: "111_19", conf: 0.7502, runners: ["113_13", "86_01"] },
    SH02: { id: "07_01", conf: 0.1501, runners: ["07_02", "07_03"] },
    SX1: { id: "02_06", conf: 0.8354, runners: ["14_20", "13_29"] },
    SX2: { id: "09_01", conf: 0.7485, runners: ["09_02", "09_03"] },
    SX3: { id: "13_04", conf: 0.3274, runners: ["13_05", "13_06"] },
  };
  for (const row of rows) {
    const e = expect[row.shot]!;
    assert.equal(row.pickId, e.id, `${row.shot} pick`);
    assert.equal(row.pick, gold.rows.find((g) => g.shot === row.shot)!.pick);
    assert.equal(row.conf, e.conf, `${row.shot} chain-rule conf`);
    const runnerIds = row.runner.map((code) => trialShortlist().candidates.find((c) => c.code === code)?.id ?? code);
    assert.deepEqual(runnerIds, e.runners, `${row.shot} runner-ups`);
  }
});

test("chain-rule math: three-digit C101 renormalizes over still-valid digits only", () => {
  // valid set C100/C101/C102/C120 → digit positions:
  //  pos1 (C_): only '1' is valid → any board renormalizes to p=1
  //  pos2 (C1_): '0' (C10x) or '2' (C120)
  //  pos3 (C10_): '0' or '1'
  const board: { token: string; logprob: number }[][] = [
    [{ token: "C", logprob: -0.01 }, { token: "X", logprob: -5 }],
    [{ token: "1", logprob: -0.2 }, { token: "0", logprob: -1.0 }], // '0' invalid here → p('1')=1
    [{ token: "0", logprob: -0.5 }, { token: "9", logprob: -2.0 }],  // '9' invalid → p('0')=1
    [{ token: "1", logprob: -0.1 }, { token: "0", logprob: -3.0 }],  // both valid → real renorm
  ];
  const tokens = ["C", "1", "0", "1"];
  const valid = new Set(["C100", "C101", "C102", "C120"]);
  const got = chainConf(board, tokens, "C101", valid);
  assert.equal(got.fail, null);
  const p3 = Math.exp(-0.1) / (Math.exp(-0.1) + Math.exp(-3.0));
  assert.ok(Math.abs(got.conf! - p3) < 0.001, `conf ${got.conf} ≈ ${p3.toFixed(4)} (0.9478)`);
  assert.deepEqual(
    got.detail.map((d) => d.p),
    [1, 1, Math.round(p3 * 1e4) / 1e4],
  );
  // emitted digit outside top-20 floors at best-6.0 and is flagged (pos3: only
  // the other valid digit shows up in the top-20)
  const floorBoard = structuredClone(board);
  floorBoard[3] = [{ token: "0", logprob: -0.5 }];
  const floored = chainConf(floorBoard, tokens, "C101", valid);
  assert.equal(floored.detail[2]!.floor, true);
  assert.ok(floored.conf! > 0 && floored.conf! < 1, "floored digit still yields a (penalised) probability");
  // a code never emitted → no conf, named failure (the digit chain spells C99)
  const none = chainConf(board, ["C", "9", "9"], "C101", valid);
  assert.equal(none.conf, null);
  assert.match(none.fail!, /emitted_not_found/);
});

test("one-call hard constraint: short parse retries ONCE, then fails loud; per-shot calls would count >1", async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-raw.json"), "utf8")) as {
    tokens: string[];
    top_logprobs: { token: string; logprob: number }[][];
  };
  const goldRawText = goldRaw();
  const sl = trialShortlist();
  const shots: MotionShotLine[] = [
    { id: "SH01", heading: "h", action: "打拳踢腿", durationSec: 4.8 },
    { id: "SH02", heading: "h", action: "行兩步停低", durationSec: 4.8 },
  ];
  // retry path: first response mangled, second complete → 2 calls total, still zero per-shot traffic
  let n = 0;
  const retryFetch = (async () => {
    n += 1;
    const content = n === 1 ? "SH01 C13 | C44 C45 | ok but the model dropped a line" : goldRawText;
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content }, logprobs: { content: raw.tokens.map((token, i) => ({ token, top_logprobs: raw.top_logprobs[i] ?? [] })) } },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  const got = await selectMotions({ shots, shortlist: sl, fetchImpl: retryFetch });
  assert.equal(got.calls, 2);
  assert.equal(got.rows.length, 5, "complete replay parses all five trial lines");
  // fail-loud path: both calls short → throw, never a silent partial
  let m = 0;
  const shortFetch = (async () => {
    m += 1;
    void m;
    return new Response(
      JSON.stringify({
        choices: [
          { message: { content: "SX3 C101 | C102 C103 | only this" }, logprobs: { content: [] } },
        ],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  await assert.rejects(() => selectMotions({ shots, shortlist: sl, fetchImpl: shortFetch }), /parse incomplete after 2 calls/);
});

test("verb gate: any-of must hit desc or category; all-of partial flags but stays green", () => {
  const gate = verbGate({ desc: "punch, kick", category: "martial arts" }, verbsForGate("打出兩記右直拳再起腳側踢"));
  assert.equal(gate.pass, true);
  assert.ok(gate.hitAny.includes("punch"));
  const bend = verbGate({ desc: "bend over, scoop up, rise" }, verbsForGate("蹲低半跪執起紙條起身企直"));
  assert.equal(bend.pass, true);
  assert.equal(bend.partial, true, "rise/scoop hit but 'stand up'/'pick' miss → partial flag");
  const miss = verbGate({ desc: "walk forward" }, verbsForGate("打出兩記右直拳"));
  assert.equal(miss.pass, false);
});

test("bake window: 4.82s → start 1, len 578 source frames, step 2 (trial bake receipt)", () => {
  assert.deepEqual(bakeFor(4.82), { start: 1, len: 578, step: 2, auto_anchor: true });
  assert.deepEqual(bakeFor(4.0), { start: 1, len: 480, step: 2, auto_anchor: true });
});

test("bvh frame read: 111_19=1025, 07_01=317 (Frames: sits ~4KB in, not the first KB)", { skip: !fs.existsSync(path.join(LIB, "cmu-mocap/data/111/111_19.bvh")) && "motion library not mounted" }, () => {
  assert.equal(bvhClipFrames("data/111/111_19.bvh"), 1025);
  assert.equal(bvhClipFrames("data/007/07_01.bvh"), 317);
  assert.equal(bvhClipFrames("data/999/99_99.bvh"), null, "missing clip reads null, never throws");
});

test("decideSelection: conf ≥0.7 auto; verb-miss walks runner-ups; three misses fail loud", async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-raw.json"), "utf8")) as {
    tokens: string[];
    top_logprobs: { token: string; logprob: number }[][];
  };
  const goldRawText = goldRaw();
  const mock = trialFetch(raw, goldRawText);
  const sl = trialShortlist();
  const shots: MotionShotLine[] = [
    { id: "SH01", heading: "FULL", action: "企定打出兩記右直拳，轉身起左腳側踢，落地收勢。", durationSec: 4.82 },
    { id: "SH02", heading: "MEDIUM", action: "行前兩步停低，收拳定神。", durationSec: 4.82 },
  ];
  const { rows } = await selectMotions({ shots, shortlist: sl, fetchImpl: mock.impl });
  const rank = fs.existsSync(path.join(LIB, "out/combat_sweep_ranking.txt"))
    ? parseCombatSweepRanking(fs.readFileSync(path.join(LIB, "out/combat_sweep_ranking.txt"), "utf8"))
    : new Map();
  const sh01 = decideSelection(rows.find((r) => r.shot === "SH01")!, sl, rank, shots[0]!, bvhClipFrames("data/111/111_19.bvh"));
  // SH01: conf 0.7502 auto, 111_19, bake 1+578 step2, Pregnant-Woman metadata flag
  assert.equal(sh01.auto, true);
  assert.equal(sh01.bvh, "data/111/111_19.bvh");
  assert.deepEqual(sh01.bake, { start: 1, len: 578, step: 2, auto_anchor: true });
  assert.ok(sh01.flags.some((f) => f.startsWith("subject-metadata: Pregnant Woman")));
  assert.ok(!sh01.flags.some((f) => f.startsWith("clip_short")), "1025f/120=8.5s covers the 4.82s shot");

  // SH02: conf 0.15 → tie-break. 07_01/02/03 have no arm evidence and share
  // subject 7, so clip length decides: 07_03 (416f) is nearest 4.82s — and the
  // choice is recorded, auto stays false
  const sh02 = decideSelection(rows.find((r) => r.shot === "SH02")!, sl, rank, shots[1]!, bvhClipFrames("data/007/07_01.bvh"));
  assert.equal(sh02.auto, false);
  assert.ok(sh02.tie_break, "the tie-break path leaves a record (F4)");
  assert.equal(sh02.bvh, "data/007/07_03.bvh");
  assert.deepEqual(sh02.runners, ["07_01", "07_02"]);
  assert.ok(sh02.flags.includes("low-conf tie-break"));

  // verb-miss swap: a martial pick judged against a walk shot walks runner-ups
  const walkShot: MotionShotLine = { id: "SH09", heading: "M", action: "行兩步停低", durationSec: 3 };
  const badRow = { shot: "SH09", pick: rows[0]!.pick, runner: rows.filter((r) => r.shot === "SH02").flatMap((r) => r.runner).slice(0, 1), reason: "x", conf: 0.9, pickId: "111_19", pickDesc: "punch, kick", pickFamily: "martial", pickBvh: "data/111/111_19.bvh" } as const;
  const swapped = decideSelection(badRow as never, sl, rank, walkShot, null);
  assert.equal(swapped.bvh, "data/007/07_02.bvh", "runner-up walk clip takes over the verb-missed martial pick");
  assert.ok(swapped.flags.some((f) => f.startsWith("verb-miss swap")));
  // all three miss → fail loud
  const worse = { ...badRow, runner: [rows[0]!.pick] } as never;
  assert.throws(() => decideSelection(worse, sl, rank, walkShot, null), /verb gate fail/);
});

test("selection schema + job-dir write + §5b blockout path convention", async () => {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-raw.json"), "utf8")) as {
    tokens: string[];
    top_logprobs: { token: string; logprob: number }[][];
  };
  const goldRawText = goldRaw();
  const mock = trialFetch(raw, goldRawText);
  const sl = trialShortlist();
  const shots: MotionShotLine[] = [{ id: "SH01", heading: "FULL", action: "打拳側踢收勢", durationSec: 4.82 }];
  const { rows } = await selectMotions({ shots, shortlist: sl, fetchImpl: mock.impl });
  const sel = decideSelection(rows[0]!, sl, new Map(), shots[0]!, 1025);
  assert.deepEqual(Object.keys(sel).sort(), ["auto", "bake", "bvh", "conf", "flags", "reason", "runners", "shot"].sort());
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-motsel-"));
  const file = writeSelections(dir, [sel], { one_call: true, model: "qwen38" });
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(onDisk.shots[0].shot, "SH01");
  assert.equal(onDisk.model, "qwen38");
  assert.doesNotMatch(sel.bvh, /^data\/data\//, "bvh is relative to cmu-mocap/ — never the double-data docstring path");
  // the §5b Video 1 landing convention the CFORM router reads
  assert.equal(blockoutPathFor(path.join(dir, "blockout"), "SH01"), path.join(dir, "blockout", "SH01.mp4"));
});

test("F4 dry-run: SC-0921-9V4Y callsheet → selection.json (SH01=111_19 auto, SH02 tie-break record)", { skip: !fs.existsSync("/mnt/ssd/ai-video-orchestrator-crew/data/jobs/SC-0921-9V4Y/callsheet.json") && "9V4Y job dir not mounted" }, async () => {
  const sheet = JSON.parse(fs.readFileSync("/mnt/ssd/ai-video-orchestrator-crew/data/jobs/SC-0921-9V4Y/callsheet.json", "utf8")) as {
    shots: { id: string; heading: string; action: string; durationSec: number; marks?: { gait: string; stance?: string }[] }[];
  };
  const shots: MotionShotLine[] = sheet.shots.map((s) => ({
    id: s.id,
    heading: s.heading,
    action: s.action,
    durationSec: s.durationSec,
    gait: s.marks?.[0]?.gait,
    stance: s.marks?.[0]?.stance,
  }));
  assert.deepEqual(shots.map((s) => s.id), ["SH01", "SH02"], "the 9V4Y slate is the two-shot E2E sheet");
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, "trial-decision-raw.json"), "utf8")) as {
    tokens: string[];
    top_logprobs: { token: string; logprob: number }[][];
  };
  const goldRawText = goldRaw();
  const mock = trialFetch(raw, goldRawText);
  const sl = trialShortlist();
  const { rows, calls } = await selectMotions({ shots, shortlist: sl, fetchImpl: mock.impl });
  assert.equal(calls, 1);
  const rank = parseCombatSweepRanking(fs.readFileSync(path.join(LIB, "out/combat_sweep_ranking.txt"), "utf8"));
  const selections = shots.map((s) => decideSelection(rows.find((r) => r.shot === s.id)!, sl, rank, s, null));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-motsel-f4-"));
  const file = writeSelections(outDir, selections, { job: "SC-0921-9V4Y", dry_run: true });
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")) as { shots: typeof selections };
  const sh01 = onDisk.shots.find((s) => s.shot === "SH01")!;
  assert.equal(sh01.bvh, "data/111/111_19.bvh");
  assert.equal(sh01.auto, true);
  assert.equal(sh01.conf, 0.7502);
  assert.deepEqual(sh01.bake, { start: 1, len: 578, step: 2, auto_anchor: true });
  const sh02 = onDisk.shots.find((s) => s.shot === "SH02")!;
  assert.ok(sh02.tie_break || sh02.needs_human, "SH02 low-conf leaves a tie-break/needs_human record (F4)");
  assert.equal(sh02.auto, false);
  // §5b supply hand-off: the bake lands where the C-form router looks
  for (const s of onDisk.shots) {
    assert.ok(!s.bvh.startsWith("data/data/"));
    assert.equal(blockoutPathFor(outDir, s.shot), path.join(outDir, `${s.shot}.mp4`));
  }
});
