import test from "node:test";
import assert from "node:assert/strict";
import { configWarns, formatDoctor, type DoctorReport } from "./doctor";
import { defaultConfig, type SlateConfig } from "./config";

function report(cfg: SlateConfig, warns: string[]): DoctorReport {
  return {
    ffmpeg: true,
    blender: true,
    sshpass: true,
    sshPassSource: null,
    motion: { up: false, url: cfg.motion.comfyUrl, nodesMissing: [] },
    stills: { up: false, url: cfg.stills.url },
    pictureQc: { up: false, url: cfg.pictureQc.endpoint, modelPresent: false, models: [] },
    mesher: { up: false, url: cfg.mesher.endpoint },
    config: cfg,
    warns,
  };
}

test("loopback fleet URL produces a loopback WARN", () => {
  const cfg = structuredClone(defaultConfig);
  cfg.stills.url = "http://127.0.0.1:8097";
  const warns = configWarns(cfg);
  assert.ok(warns.some((w) => w.includes("loopback") && w.includes("127.0.0.1")));
});

test("localhost motion URL produces a loopback WARN", () => {
  const cfg = structuredClone(defaultConfig);
  cfg.motion.comfyUrl = "http://localhost:8188";
  assert.ok(configWarns(cfg).some((w) => w.includes("loopback") && w.includes("localhost")));
});

test("tailnet stills/motion produce no loopback WARN; a local MARS :8015 may warn", () => {
  const warns = configWarns(structuredClone(defaultConfig));
  assert.ok(!warns.some((w) => w.includes("stills.url") && w.includes("loopback")));
  assert.ok(!warns.some((w) => w.includes("motion.comfyUrl") && w.includes("loopback")));
});

test("C10: unset crew.endpoint warns; a pinned LiteLLM :4000 endpoint does not", () => {
  const unset = structuredClone(defaultConfig);
  unset.crew.endpoint = "";
  assert.ok(configWarns(unset).some((w) => w.includes("crew.endpoint unset")));
  const pinned = structuredClone(defaultConfig);
  pinned.crew.endpoint = "http://127.0.0.1:4000";
  assert.ok(!configWarns(pinned).some((w) => w.includes("crew.endpoint unset")));
});

test("formatDoctor prints report.warns as WARN lines", () => {
  const cfg = structuredClone(defaultConfig);
  cfg.motion.comfyUrl = "http://localhost:8188";
  const warns = configWarns(cfg);
  const text = formatDoctor(report(cfg, warns));
  assert.ok(text.split("\n").some((line) => line.startsWith("WARN") && line.includes("localhost")));
});

test("mesher.endpoint is a local sf3d_server by design — never a loopback WARN", () => {
  const warns = configWarns(structuredClone(defaultConfig));
  assert.ok(!warns.some((w) => w.includes("mesher.endpoint") && w.includes("loopback")));
});
