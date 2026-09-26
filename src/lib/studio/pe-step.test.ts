import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as nodeTest from "node:test";
import { assertLocalPeBrain, runPeStep, validateFacts, type PeConfig, type WigoloReport } from "./pe-step";

/** One file, three doors (store.test.ts idiom). */
const bareBun = !!process.versions.bun && process.env.BUN_TEST !== "1";
const cases: { name: string; fn: () => void | Promise<void> }[] = [];
const test = bareBun
  ? (name: string, fn: () => void | Promise<void>) => cases.push({ name, fn })
  : nodeTest.test;

/** Card D 掣3: the search-first PE step — wigolo evidence → local PE brain
 *  (nex effort-none + official sampling, qwen38 backup, GLM banned) → facts
 *  rows {claim, source, fetched_at} + Render JSON. Real wigolo calls are
 *  allowed in production; these tests run entirely on fixtures. */

const CONFIG: PeConfig = {
  endpoint: "http://127.0.0.1:8017",
  model: "nex-n2.5",
  fallbackEndpoint: "http://127.0.0.1:8015",
  fallbackModel: "qwen38",
  maxTokens: 6000,
  wigoloClient: "/nonexistent/wigolo_research.py",
  timeoutMs: 5_000,
};

const EVIDENCE: WigoloReport = {
  report: "差餉物業估價署公布，2026年6月私人住宅售價指數報323.2點，連升13個月。",
  citations: [{ url: "https://example.hk/rvd", title: "差估署售價指數" }],
};

const BRAIN_OK = JSON.stringify({
  facts: [{ claim: "2026年6月私人住宅售價指數323.2點", source: "https://example.hk/rvd", fetched_at: "2026-09-19" }],
  render: {
    主體: "樓價指數數據卡",
    場景: "辦公室桌面螢幕，日光",
    風格光照: "冷白屏光，低對比，無濾鏡",
    約束: "可見文案逐字：「2026年6月 私人住宅售價指數 323.2點」「連升13個月」；單一數據卡版式；排除其他文字",
  },
});

type Wire = { url: string; body: Record<string, unknown> };

function okResponse(content: string) {
  return {
    ok: true,
    status: 200,
    async json() {
      return { choices: [{ message: { content }, finish_reason: "stop" }] };
    },
    async text() {
      return "";
    },
  };
}

test("PE step: mock wigolo → nex brain, official call-shape on the wire, facts + render out, receipt on disk", async () => {
  const wires: Wire[] = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pe-step-"));
  const res = await runPeStep({
    shotId: "SH03",
    action: "螢幕顯示樓價指數圖表",
    context: "fixture｜office｜day｜plain",
    config: CONFIG,
    deps: {
      wigolo: async () => EVIDENCE,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        wires.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return okResponse(BRAIN_OK) as unknown as Response;
      }) as unknown as typeof fetch,
    },
    receiptFile: path.join(tmp, "SH03.pe_step.json"),
  });
  assert.equal(res.brain, "nex-n2.5", "primary brain used");
  assert.equal(res.facts.length, 1);
  assert.equal(res.facts[0]!.claim, "2026年6月私人住宅售價指數323.2點");
  assert.ok(res.render.includes("323.2"));
  // the law's call-shape, asserted on the actual wire body
  const wire = wires[0]!;
  assert.equal(wire.url, "http://127.0.0.1:8017/v1/chat/completions");
  const system = (wire.body.messages as { role: string; content: string }[])[0]!.content;
  for (const key of ["主體", "場景", "風格光照", "約束"]) {
    assert.ok(system.includes(key), `PE 結構要求帶四要素 key：${key}（U1.5 官方配方）`);
  }
  assert.deepEqual(wire.body.chat_template_kwargs, { reasoning_effort: "none" }, "nex effort none");
  assert.equal(wire.body.temperature, 0.7);
  assert.equal(wire.body.top_p, 0.95);
  assert.equal(wire.body.top_k, 40);
  assert.equal(wire.body.max_tokens, 6000);
  const receipt = JSON.parse(fs.readFileSync(path.join(tmp, "SH03.pe_step.json"), "utf8")) as { tool: string; facts: unknown[] };
  assert.equal(receipt.tool, "slatecrew.pe_step");
  assert.equal(receipt.facts.length, 1);
});

test("PE step: primary down → qwen38 backup answers without chat_template_kwargs", async () => {
  const wires: Wire[] = [];
  const res = await runPeStep({
    shotId: "SH03",
    action: "螢幕顯示樓價指數圖表",
    context: "fixture",
    config: CONFIG,
    deps: {
      wigolo: async () => EVIDENCE,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        wires.push({ url: String(url), body });
        if (String(url).includes("8017")) {
          return { ok: false, status: 503, async text() { return "down"; } } as unknown as Response;
        }
        return okResponse(BRAIN_OK) as unknown as Response;
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(res.brain, "qwen38", "fallback used");
  assert.equal(wires[1]!.url, "http://127.0.0.1:8015/v1/chat/completions");
  assert.equal(wires[1]!.body.chat_template_kwargs, undefined, "qwen38 runs plain official sampling");
  assert.equal(res.facts.length, 1);
});

test("PE step: GLM cloud brain is refused before any wire time", () => {
  assert.throws(() => assertLocalPeBrain("glm-5.3"), /GLM 雲腦/);
  assert.rejects(
    runPeStep({
      shotId: "SH03",
      action: "圖表",
      context: "x",
      config: { ...CONFIG, model: "glm-5.3-flash" },
      deps: { wigolo: async () => EVIDENCE },
    }),
    /GLM 雲腦/,
  );
});

test("PE step: both brains returning zero facts throws — the shot falls to the facts_missing gate, never a silent pass", async () => {
  const noFacts = JSON.stringify({ facts: [], render: "{}" });
  await assert.rejects(
    runPeStep({
      shotId: "SH03",
      action: "圖表",
      context: "x",
      config: CONFIG,
      deps: {
        wigolo: async () => EVIDENCE,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          void init;
          return okResponse(noFacts) as unknown as Response;
        }) as unknown as typeof fetch,
      },
    }),
    /PE step failed on both brains/,
  );
});

test("PE step: facts are cut to what the render actually paints (evidence table stays out)", async () => {
  const brain = JSON.stringify({
    facts: [
      { claim: "2026年6月私人住宅售價指數323.2點", source: "https://example.hk/rvd", fetched_at: "2026-09-19" },
      { claim: "2025年全年註冊量約33,500宗從未上屏", source: "https://example.hk/other", fetched_at: "2026-09-19" },
    ],
    render: {
      主體: "樓價指數數據卡",
      場景: "辦公室桌面螢幕，日光",
      風格光照: "冷白屏光，低對比",
      約束: "文案逐字：「2026年6月 私人住宅售價指數 323.2點」；單一數據卡版式；排除其他文字",
    },
  });
  const res = await runPeStep({
    shotId: "SH03",
    action: "螢幕顯示樓價指數圖表",
    context: "x",
    config: CONFIG,
    deps: {
      wigolo: async () => EVIDENCE,
      fetchImpl: (async (_url: string, init?: RequestInit) => {
        void init;
        return okResponse(brain) as unknown as Response;
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(res.facts.length, 1, "only the painted row survives");
  assert.equal(res.facts[0]!.claim, "2026年6月私人住宅售價指數323.2點");
});

test("W3: render missing a structural key (場景/風格光照/約束) is refused — falls to backup or throws", async () => {
  const half = JSON.stringify({
    facts: [{ claim: "2026年6月私人住宅售價指數323.2點", source: "https://example.hk/rvd", fetched_at: "2026-09-19" }],
    render: { 主體: "樓價指數數據卡", copy: ["323.2"] },
  });
  // primary incomplete → backup (BRAIN_OK) answers; the note carries the miss
  const res = await runPeStep({
    shotId: "SH03",
    action: "螢幕顯示樓價指數圖表",
    context: "fixture",
    config: CONFIG,
    deps: {
      wigolo: async () => EVIDENCE,
      fetchImpl: (async (url: string, init?: RequestInit) => {
        void init;
        return okResponse(String(url).includes("8017") ? half : BRAIN_OK) as unknown as Response;
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(res.brain, "qwen38", "incomplete render falls to the backup brain");
  assert.match(res.notes ?? "", /缺結構四要素.*風格光照/);

  // both brains incomplete → fail loud, never a structure-less mount
  await assert.rejects(
    runPeStep({
      shotId: "SH03",
      action: "螢幕顯示樓價指數圖表",
      context: "fixture",
      config: CONFIG,
      deps: {
        wigolo: async () => EVIDENCE,
        fetchImpl: (async (_url: string, init?: RequestInit) => {
          void init;
          return okResponse(half) as unknown as Response;
        }) as unknown as typeof fetch,
      },
    }),
    /缺結構四要素：場景、風格光照、約束/,
  );
});

test("validateFacts: drops rows without claim/source, repairs fetched_at to the run date", () => {
  const runDate = "2026-09-19";
  const facts = validateFacts(
    [
      { claim: "A", source: "s", fetched_at: "2026-09-01" },
      { claim: "", source: "s" },
      { claim: "C" },
      { claim: "D", source: "s2", fetched_at: "19/09/2026" },
      "junk",
    ],
    runDate,
  );
  assert.equal(facts.length, 2);
  assert.equal(facts[0]!.fetched_at, "2026-09-01", "a good date survives");
  assert.equal(facts[1]!.fetched_at, runDate, "a bad date falls back to the run date");
});

test("PE step: max_tokens below the 5000 law floor refuses to run", async () => {
  await assert.rejects(
    runPeStep({
      shotId: "SH03",
      action: "圖表",
      context: "x",
      config: { ...CONFIG, maxTokens: 2000 },
      deps: { wigolo: async () => EVIDENCE },
    }),
    /max_tokens 2000 < 5000/,
  );
});

test("PE rewrite: web search off calls 6.8 and never wigolo", async () => {
  let wigoloCalls = 0;
  const wires: Wire[] = [];
  const res = await runPeStep({
    shotId: "SH01",
    action: "男人行過走廊",
    context: "fixture",
    config: { ...CONFIG, rewriteEndpoint: "http://127.0.0.1:4000", rewriteModel: "sensenova-v6.8-flash-lite" },
    webSearch: false,
    deps: {
      wigolo: async () => {
        wigoloCalls += 1;
        return EVIDENCE;
      },
      fetchImpl: (async (url: string, init?: RequestInit) => {
        wires.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
        return okResponse(JSON.stringify({
          render: { 主體: "男人", 場景: "走廊", 風格光照: "日光", 約束: "一個人行過" },
        })) as unknown as Response;
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(wigoloCalls, 0);
  assert.equal(res.facts.length, 0);
  assert.equal(res.brain, "sensenova-v6.8-flash-lite");
  assert.equal(wires.length, 1);
  assert.match(wires[0]!.url, /127\.0\.0\.1:4000/);
  assert.equal(wires[0]!.body.max_tokens, 8000);
  assert.equal(wires[0]!.body.chat_template_kwargs, undefined);
});

test("PE rewrite: 已有四要素收據就唔再叫腦", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pe-rcpt-"));
  const receipt = path.join(dir, "SH06.pe_rewrite.json");
  const render = { 主體: "阿檸舉樽", 場景: "木檯", 風格光照: "冷調", 約束: "水珠滑落" };
  fs.writeFileSync(receipt, JSON.stringify({ tool: "slatecrew.pe_step", shot: "SH06", render: JSON.stringify(render), brain: "sensenova-v6.8-flash-lite", question: "舊" }));
  let calls = 0;
  const res = await runPeStep({
    shotId: "SH06",
    action: "再叫就錯",
    context: "fixture",
    config: { ...CONFIG, rewriteEndpoint: "http://127.0.0.1:4000", rewriteModel: "sensenova-v6.8-flash-lite" },
    webSearch: false,
    receiptFile: receipt,
    deps: {
      fetchImpl: (async () => {
        calls += 1;
        throw new Error("should not call");
      }) as unknown as typeof fetch,
    },
  });
  assert.equal(calls, 0);
  assert.equal(JSON.parse(res.render).主體, "阿檸舉樽");
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
