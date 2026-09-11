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

test("tailnet and docker-bridge fleet URLs produce no loopback WARN", () => {
  const warns = configWarns(structuredClone(defaultConfig));
  assert.ok(!warns.some((w) => w.includes("loopback")));
});

test("formatDoctor prints report.warns as WARN lines", () => {
  const cfg = structuredClone(defaultConfig);
  cfg.motion.comfyUrl = "http://localhost:8188";
  const warns = configWarns(cfg);
  const text = formatDoctor(report(cfg, warns));
  assert.ok(text.split("\n").some((line) => line.startsWith("WARN") && line.includes("localhost")));
});
