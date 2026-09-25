import fs from "node:fs";
import { spawnSync } from "node:child_process";

/** Installed 5.x. Never PATH `/usr/bin/blender` (Ubuntu 3.0.1). */
export const BLENDER_5 = "/home/c/applications/blender-5.1.2-linux-x64/blender";

export function resolveBlenderBin(explicit?: string): string {
  const bin = (explicit ?? process.env.BLENDER_BIN ?? BLENDER_5).trim();
  if (!bin) throw new Error("Blender bin empty");
  if (!fs.existsSync(bin)) {
    throw new Error(`Blender missing: ${bin} — need 5.x at ${BLENDER_5}, not /usr/bin 3.0.1`);
  }
  return bin;
}

export function blenderVersion(bin: string): string {
  const r = spawnSync(bin, ["-b", "--version"], { encoding: "utf8", timeout: 12_000 });
  const text = `${r.stdout}\n${r.stderr}`;
  return text.match(/Blender (\d+\.\d+(?:\.\d+)?)/)?.[1] ?? "";
}

export function assertBlender5(bin: string): string {
  const v = blenderVersion(bin);
  const major = Number(v.split(".")[0]);
  if (!Number.isFinite(major) || major < 5) {
    throw new Error(
      `refuse Blender ${v || "unknown"} at ${bin} — SlateCrew is 5.x (${BLENDER_5})`,
    );
  }
  return v;
}
