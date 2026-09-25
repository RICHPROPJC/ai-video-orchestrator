/**
 * U1.5 stills are 4K masters. H3 keyframes ingest a 2K proxy —
 * downscale retains more detail than generating 2K natively.
 */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { STILLS_EDIT } from "./u15-edit";

/** Legacy 2K ÷32 — H3 LoadImage / ref short-edge contract. */
export const H3_KEYFRAME = {
  width: 2048,
  height: 1152,
} as const;

export function h3KeyframePath(stillPng: string): string {
  if (stillPng.endsWith(".h3.png")) return stillPng;
  if (!stillPng.endsWith(".png")) {
    throw new Error(`h3KeyframePath expects .png, got ${stillPng}`);
  }
  return stillPng.replace(/\.png$/i, ".h3.png");
}

export type H3ProxyReceipt = {
  tool: "slatecrew.still_h3_proxy";
  source: string;
  output: string;
  source_wh: [number, number];
  output_wh: [number, number];
  reason: "4k_master_downscale_for_h3";
};

/** Write stills/SH01.h3.png from 4K master. Idempotent if already correct size. */
export async function writeH3KeyframeProxy(stillPng: string): Promise<H3ProxyReceipt> {
  if (!fs.existsSync(stillPng)) throw new Error(`missing 4K still: ${stillPng}`);
  const out = h3KeyframePath(stillPng);
  const meta = await sharp(stillPng).metadata();
  const sw = meta.width ?? 0;
  const sh = meta.height ?? 0;
  if (sw !== STILLS_EDIT.width || sh !== STILLS_EDIT.height) {
    throw new Error(
      `H3 proxy expects 4K master ${STILLS_EDIT.width}×${STILLS_EDIT.height}, got ${sw}×${sh} (${stillPng})`,
    );
  }
  await sharp(stillPng)
    .resize(H3_KEYFRAME.width, H3_KEYFRAME.height, { fit: "fill", kernel: "lanczos3" })
    .png()
    .toFile(out);
  const got = await sharp(out).metadata();
  if (got.width !== H3_KEYFRAME.width || got.height !== H3_KEYFRAME.height) {
    throw new Error(`H3 proxy resize failed: ${got.width}×${got.height}`);
  }
  const receipt: H3ProxyReceipt = {
    tool: "slatecrew.still_h3_proxy",
    source: stillPng,
    output: out,
    source_wh: [sw, sh],
    output_wh: [H3_KEYFRAME.width, H3_KEYFRAME.height],
    reason: "4k_master_downscale_for_h3",
  };
  fs.writeFileSync(`${out}.json`, JSON.stringify(receipt, null, 2));
  return receipt;
}
