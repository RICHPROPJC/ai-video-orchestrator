import assert from "node:assert/strict";
import * as nodeTest from "node:test";
import type { JobEvent } from "./types";

/** One file, three doors: bun's node:test shim only works under `bun test`,
 *  so bare `bun <this file>` self-drives the collected cases; `bun test` and
 *  `tsx --test` use the real runner. (store.test.ts idiom) */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

// ---- shape：gapEvent / gapMessage / throwGap -------------------------------------------------

test("gapEvent: blocked gap → system/error event, message 跟 capability_gap[domain]：what——why", async () => {
  const { gapEvent } = await import("./capability-gap");
  const ev = gapEvent("SC-0927-X", {
    domain: "motion",
    what: "CMU 庫無手部接觸動作 clip（擰蓋/飲/抹）",
    why: "needs_human 揀片未有人手接",
    impact: "blocked",
    shot: "SH03",
  });
  // emit-able：結構上就係 JobEvent 減 ts（tsc 層面鎖死）
  const asEvent: Omit<JobEvent, "ts"> = ev;
  assert.equal(asEvent.agent, "system");
  assert.equal(asEvent.level, "error", "blocked → level error");
  assert.match(
    asEvent.message,
    /^capability_gap\[motion\] SH03：CMU 庫無手部接觸動作 clip（擰蓋\/飲\/抹）——needs_human 揀片未有人手接$/,
  );
  const gap = (asEvent.data?.capability_gap ?? {}) as Record<string, unknown>;
  assert.equal(gap.domain, "motion");
  assert.equal(gap.impact, "blocked");
  assert.equal(gap.shot, "SH03");
  assert.equal(asEvent.data?.job, "SC-0927-X");
});

test("gapEvent: degraded gap → system/warn event，無 shot 就唔帶 shot 段", async () => {
  const { gapEvent } = await import("./capability-gap");
  const ev = gapEvent("SC-0927-X", {
    domain: "storyboard",
    what: "可見分鏡板 0 格",
    why: "出板經 runBoards storyboardBoardPrompt 條路，或者人手確認照行（--allow-no-storyboard）",
    impact: "degraded",
  });
  assert.equal(ev.agent, "system");
  assert.equal(ev.level, "warn", "degraded → level warn");
  assert.match(ev.message, /^capability_gap\[storyboard\]：可見分鏡板 0 格——出板經 runBoards storyboardBoardPrompt 條路/);
  const gap = (ev.data?.capability_gap ?? {}) as Record<string, unknown>;
  assert.equal("shot" in gap, false, "無 shot 唔好塞空 shot 落 data");
});

test("throwGap: 訊息以「停手等指示，唔准靜靜雞用替代品頂。」收尾，唔帶 shot 段", async () => {
  const { throwGap } = await import("./capability-gap");
  // validator 對 err.message 行 anchored regex（assert.throws 配 regex 係對
  // String(err) match，自帶 "Error: " 前綴，^ 錨會錯位）
  assert.throws(
    () =>
      throwGap({
        domain: "motion",
        what: "CMU 庫無手部接觸動作 clip（擰蓋/飲/抹）",
        why: "needs_human 揀片未有人手接",
        impact: "blocked",
        shot: "SH03",
      }),
    (err: unknown) =>
      err instanceof Error &&
      /^capability_gap\[motion\] CMU 庫無手部接觸動作 clip（擰蓋\/飲\/抹）——needs_human 揀片未有人手接。停手等指示，唔准靜靜雞用替代品頂。$/.test(
        err.message,
      ),
  );
});

// ---- 現場閘（純函數；pipeline 只接線，唔硬跑 runPipeline） -----------------------------------

test("motion 閘：needs_human selection 存在 → blocked gap（鏡 id 全列）；一個都冇 → null 照行", async () => {
  const { motionNeedsHumanGap, gapEvent } = await import("./capability-gap");
  const sel = (shot: string, needsHuman?: boolean) => ({ shot, ...(needsHuman ? { needs_human: true } : {}) });
  assert.equal(motionNeedsHumanGap([sel("SH01"), sel("SH02")]), null, "全 auto → 唔閘");
  const gap = motionNeedsHumanGap([sel("SH01"), sel("SH03", true), sel("SH07", true)]);
  assert.ok(gap, "有 needs_human → 有 gap");
  assert.equal(gap.domain, "motion");
  assert.equal(gap.impact, "blocked");
  assert.match(gap.what, /^needs_human 揀片 2 鏡未有人手接：SH03、SH07$/);
  // pipeline 段組合：呢個 gap 經 gapEvent 就係 job blocked 嗰筆 error event
  const ev = gapEvent("SC-TEST", gap);
  assert.equal(ev.level, "error");
  assert.match(ev.message, /^capability_gap\[motion\]：needs_human 揀片 2 鏡未有人手接：SH03、SH07——/);
  assert.match(ev.message, /decider 冇權靜靜雞代揀$/);
});

test("storyboard 閘：零板 gap 係 blocked，訊息指明出板路同人手逃生門", async () => {
  const { storyboardZeroGap, gapEvent } = await import("./capability-gap");
  const gap = storyboardZeroGap();
  assert.equal(gap.domain, "storyboard");
  assert.equal(gap.impact, "blocked");
  assert.equal(gap.shot, undefined);
  const ev = gapEvent("SC-TEST", gap);
  assert.equal(ev.agent, "system");
  assert.equal(ev.level, "error", "零板 blocked → error 唔係 warn");
  assert.match(ev.message, /可見分鏡板 0 格/);
  assert.match(ev.message, /runBoards storyboardBoardPrompt/);
  assert.match(ev.message, /--allow-no-storyboard/);
});

test("blockout plug：degraded 唔阻行，但每鏡留一筆 warn（灰模係 plug 唔係真 render）", async () => {
  const { blockoutPlugGap, gapEvent } = await import("./capability-gap");
  const gap = blockoutPlugGap("SH04");
  assert.equal(gap.domain, "blockout");
  assert.equal(gap.impact, "degraded", "plug 係已知工作模式，照行");
  assert.equal(gap.shot, "SH04");
  const ev = gapEvent("SC-TEST", gap);
  assert.equal(ev.agent, "system");
  assert.equal(ev.level, "warn", "degraded → warn 唔係 error");
  assert.match(ev.message, /^capability_gap\[blockout\] SH04：呢條片嘅灰模係 plug 唔係真 render——/);
});

if (bareBun) {
  // IIFE, not top-level await: tsx transpiles this file as CJS
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
