import test from "node:test";
import assert from "node:assert/strict";
import { defaultConfig } from "./config";
import {
  formatFleet,
  modelMatches,
  normalizeModel,
  probeFleet,
  gateReady,
  blockersForGate,
  type FetchLike,
  type FleetReport,
} from "./fleet";

function jsonOk(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
}

function http(status: number, body = ""): Response {
  return new Response(body, { status });
}

function mockFetch(routes: Record<string, Response | (() => Response)>): FetchLike {
  return async (input) => {
    const hit = routes[input];
    if (!hit) return http(404, "missing");
    return typeof hit === "function" ? hit() : hit.clone();
  };
}

test("normalizeModel strips weight suffix", () => {
  assert.equal(normalizeModel("SenseNova-U1.5-8B-MoT.safetensors"), "sensenova-u1.5-8b-mot");
});

test("modelMatches is stem-exact: spoof 35b ≠ live 27b", () => {
  assert.equal(modelMatches("qwen38", ["qwen38"]), true);
  assert.equal(modelMatches("qwen3.6-35b", ["qwen38"]), false);
  assert.equal(modelMatches("mars-fa2", ["qwen38"]), false);
  assert.equal(modelMatches("nex-n2.5", ["nex-n2.5"]), true);
  assert.equal(modelMatches("nex-n2.5", ["qwen38"]), false);
  assert.equal(modelMatches("SenseNova-U1.5-8B-MoT.safetensors", ["SenseNova-U1.5-8B-MoT"]), true);
  assert.equal(modelMatches("FunAudioLLM/SenseVoiceSmall", ["FunAudioLLM/SenseVoiceSmall"]), true);
  assert.equal(modelMatches("FunAudioLLM/SenseVoiceSmall", ["SenseVoiceSmall"]), true);
});

test("empty optional ocr is UNCONFIG and does not block ready", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "http://crew.test";
  cfg.crew.writerModel = "glm-5.3-flash";
  cfg.crew.boardsModel = "glm-5.3-flash";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.tts.model = "auk-flash-1.5B";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.pictureQc.model = "qwen38";
  cfg.soundQc.endpoint = "";
  cfg.ocr.endpoint = "";
  const fetchImpl = mockFetch({
    "http://crew.test/v1/models": jsonOk({ data: [{ id: "glm-5.3-flash" }, { id: "nex-n2.5" }] }),
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT", vram_gb: 35.2 }),
    "http://motion.test/system_stats": jsonOk({ devices: [{ vram_total: 68e9, vram_free: 40e9 }] }),
    "http://tts.test/health": jsonOk({ ok: true, model: "auk-flash-1.5B" }),
    "http://qc.test/v1/models": jsonOk({ data: [{ id: "qwen38" }] }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  assert.equal(report.rows.find((r) => r.id === "ocr")?.status, "UNCONFIG");
  assert.equal(report.rows.find((r) => r.id === "soundQc")?.status, "UNCONFIG");
  assert.equal(report.rows.find((r) => r.id === "nex")?.status, "UNCONFIG");
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
});

test("config name ≠ live model is MISMATCH red and not ready", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "http://crew.test";
  cfg.crew.writerModel = "glm-5.3-flash";
  cfg.crew.boardsModel = "glm-5.3-flash";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.tts.model = "auk-flash-1.5B";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.pictureQc.model = "mars-fa2";
  cfg.soundQc.endpoint = "";
  cfg.ocr.endpoint = "";
  const fetchImpl = mockFetch({
    "http://crew.test/v1/models": jsonOk({ data: [{ id: "glm-5.3-flash" }, { id: "nex-n2.5" }] }),
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT" }),
    "http://motion.test/system_stats": jsonOk({}),
    "http://tts.test/health": jsonOk({ model: "auk-flash-1.5B" }),
    "http://qc.test/v1/models": jsonOk({ data: [{ id: "qwen38" }] }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  const qc = report.rows.find((r) => r.id === "pictureQc");
  assert.equal(qc?.status, "MISMATCH");
  assert.equal(qc?.up, true);
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((b) => b.includes("mars-fa2") && b.includes("qwen38")));
  const text = formatFleet(report);
  assert.ok(text.includes("MISMATCH"));
  assert.ok(text.includes("READY no"));
  assert.ok(text.split("\n").some((line) => line.startsWith("RED")));
});

test("dead required host is DOWN and not ready", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "http://crew.test";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.soundQc.endpoint = "";
  cfg.ocr.endpoint = "";
  const fetchImpl = mockFetch({
    "http://crew.test/v1/models": jsonOk({ data: [{ id: cfg.crew.writerModel }, { id: cfg.crew.boardsModel }] }),
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT" }),
    "http://tts.test/health": jsonOk({ model: cfg.tts.model }),
    "http://qc.test/v1/models": jsonOk({ data: [{ id: cfg.pictureQc.model }] }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  assert.equal(report.rows.find((r) => r.id === "motion")?.status, "DOWN");
  assert.equal(report.ready, false);
});

test("empty required crew.endpoint is UNCONFIG blocker", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.soundQc.endpoint = "";
  cfg.ocr.endpoint = "";
  const fetchImpl = mockFetch({
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT" }),
    "http://motion.test/system_stats": jsonOk({}),
    "http://tts.test/health": jsonOk({ model: cfg.tts.model }),
    "http://qc.test/v1/models": jsonOk({ data: [{ id: cfg.pictureQc.model }] }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  assert.equal(report.rows.find((r) => r.id === "crew")?.status, "UNCONFIG");
  assert.equal(report.ready, false);
  assert.ok(report.blockers.some((b) => b.includes("crew") && b.includes("unconfigured")));
});

test("formatFleet prints a live table matching row status", () => {
  const report: FleetReport = {
    probedAt: "2026-09-15T00:00:00.000Z",
    ready: false,
    blockers: ["pictureQc config mars-fa2 ≠ live qwen38"],
    degraded: [],
    rows: [
      {
        id: "pictureQc",
        label: "picture QC",
        configKey: "pictureQc.endpoint",
        url: "http://qc.test",
        required: true,
        unconfigured: false,
        up: true,
        mismatch: true,
        status: "MISMATCH",
        configured: ["mars-fa2"],
        live: ["qwen38"],
        vram: "",
        error: "",
      },
    ],
  };
  const text = formatFleet(report);
  assert.match(text, /^LAYER /m);
  assert.match(text, /pictureQc\s+MISMATCH/);
  assert.match(text, /READY no/);
});

test("nex DOWN covers with pictureQc 27B and stays READY", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "http://crew.test";
  cfg.crew.writerModel = "glm-5.3-flash";
  cfg.crew.boardsModel = "glm-5.3-flash";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.tts.model = "auk-flash-1.5B";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.pictureQc.model = "qwen38";
  cfg.nex.endpoint = "http://nex.test";
  cfg.nex.model = "nex-n2.5";
  cfg.soundQc.endpoint = "";
  cfg.ocr.endpoint = "";
  const fetchImpl = mockFetch({
    "http://crew.test/v1/models": jsonOk({ data: [{ id: "glm-5.3-flash" }, { id: "nex-n2.5" }] }),
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT" }),
    "http://motion.test/system_stats": jsonOk({}),
    "http://tts.test/health": jsonOk({ model: "auk-flash-1.5B" }),
    "http://qc.test/v1/models": jsonOk({ data: [{ id: "qwen38" }] }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  assert.equal(report.rows.find((r) => r.id === "nex")?.status, "DOWN");
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.degraded.some((d) => d.includes("nex") && d.includes("qwen38")));
  assert.match(formatFleet(report), /AMBER nex DOWN — covering qwen38/);
});

test("optional soundQc DOWN is AMBER not READY blocker", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "http://crew.test";
  cfg.crew.writerModel = "glm-5.3-flash";
  cfg.crew.boardsModel = "glm-5.3-flash";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.tts.model = "auk-flash-1.5B";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.pictureQc.model = "qwen38";
  cfg.soundQc.endpoint = "http://sound.test";
  cfg.soundQc.model = "FunAudioLLM/SenseVoiceSmall";
  cfg.ocr.endpoint = "";
  cfg.nex.endpoint = "";
  const fetchImpl = mockFetch({
    "http://crew.test/v1/models": jsonOk({ data: [{ id: "glm-5.3-flash" }, { id: "nex-n2.5" }] }),
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT" }),
    "http://motion.test/system_stats": jsonOk({}),
    "http://tts.test/health": jsonOk({ model: "auk-flash-1.5B" }),
    "http://qc.test/v1/models": jsonOk({ data: [{ id: "qwen38" }] }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  assert.equal(report.rows.find((r) => r.id === "soundQc")?.status, "DOWN");
  assert.equal(report.ready, true);
  assert.equal(report.blockers.length, 0);
  assert.ok(report.degraded.some((d) => d.includes("soundQc")));
  assert.match(formatFleet(report), /AMBER soundQc/);
});

test("boards gate only needs crew — pictureQc DOWN still gateReady", async () => {
  const cfg = structuredClone(defaultConfig);
  cfg.crew.endpoint = "http://crew.test";
  cfg.crew.writerModel = "glm-5.3-flash";
  cfg.crew.boardsModel = "glm-5.3-flash";
  cfg.stills.url = "http://stills.test";
  cfg.motion.comfyUrl = "http://motion.test";
  cfg.tts.endpoint = "http://tts.test";
  cfg.tts.model = "auk-flash-1.5B";
  cfg.pictureQc.endpoint = "http://qc.test";
  cfg.pictureQc.model = "qwen38";
  cfg.soundQc.endpoint = "";
  cfg.ocr.endpoint = "";
  cfg.nex.endpoint = "";
  const fetchImpl = mockFetch({
    "http://crew.test/v1/models": jsonOk({ data: [{ id: "glm-5.3-flash" }, { id: "nex-n2.5" }] }),
    "http://stills.test/health": jsonOk({ model: "SenseNova-U1.5-8B-MoT" }),
    "http://motion.test/system_stats": jsonOk({}),
    "http://tts.test/health": jsonOk({ model: "auk-flash-1.5B" }),
  });
  const report = await probeFleet(cfg, fetchImpl);
  assert.equal(report.ready, false);
  assert.equal(gateReady(report, "boards"), true);
  assert.equal(blockersForGate(report.rows, "boards").length, 0);
  assert.ok(blockersForGate(report.rows, "stills").some((b) => b.includes("pictureQc")));
});
