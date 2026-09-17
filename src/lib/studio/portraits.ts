import fs from "node:fs";
import path from "node:path";
import type { CallSheet, Character } from "./types";
import { buildGeneratePayload, u15Generate, type GeneratePayload } from "./u15-generate";
import { runPhotoQc, type PhotoQcRecord, type QcRequire } from "./photo-qc";

/** One face, alone, no placeholders — the same eye that gates the keyframes. */
export const PORTRAIT_REQUIRE: QcRequire = { people_count: 1, grey_blocks: false };

/** T43 (Chau: embed 同一張垃圾圖一路塞返 /edit，源頭 1＝肖像抄 world night/neon):
 * a portrait is a face reference, not a scene — the sheet's world line
 * (location/timeOfDay/weather/grade) NEVER enters it. Only: 一人半身、wardrobe、
 * palette、Plain background. The signature takes no sheet so the leak cannot
 * come back by accident. */
export function portraitPrompt(character: Character): string {
  return [
      `Photoreal portrait, one person alone, head and shoulders, facing camera, neutral expression.`,
    `${character.role}: ${character.wardrobe}.`,
    `Palette ${character.palette.join(", ")}.`,
    `Single frame only. Plain background. No collage, no split panels. No other people, no text, no captions, no grey mannequins, no props held.`,
  ].join(" ");
}

export type PortraitLane = {
  generate: (opts: { payload: GeneratePayload; outFile: string; recordJson: string }) => Promise<unknown>;
  qc: (png: string, outJson: string, require: QcRequire) => Promise<Pick<PhotoQcRecord, "status" | "checks">>;
};

function liveLane(server: string): PortraitLane {
  return {
    generate: (o) => u15Generate({ server, ...o }),
    qc: (png, outJson, require) => runPhotoQc(png, outJson, require),
  };
}

export type PortraitResult = { files: Record<string, string>; made: string[]; plugged: string[] };

/** A plugged portrait is honoured as-is; anything missing is cast by the stills
 *  seat and must pass the blind eye before it can anchor a keyframe. */
export async function ensurePortraits(opts: {
  sheet: CallSheet;
  outDir: string;
  plugDir?: string;
  server?: string;
  seed?: number;
  /** when set, only cast these ids (scene hop) */
  onlyIds?: string[];
  lane?: PortraitLane;
  onEvent?: (message: string, data?: Record<string, unknown>) => void;
}): Promise<PortraitResult> {
  const lane = opts.lane ?? liveLane(opts.server ?? "");
  const seed = opts.seed ?? 42;
  fs.mkdirSync(opts.outDir, { recursive: true });
  const files: Record<string, string> = {};
  const made: string[] = [];
  const plugged: string[] = [];
  const cast = opts.onlyIds?.length
    ? opts.sheet.characters.filter((c) => opts.onlyIds!.includes(c.id))
    : opts.sheet.characters;

  for (const character of cast) {
    const plug = opts.plugDir ? path.join(opts.plugDir, `${character.id}.png`) : "";
    if (plug && fs.existsSync(plug)) {
      files[character.id] = plug;
      plugged.push(character.id);
      opts.onEvent?.(`${character.id} 用返 plug 肖像`, { file: plug });
      continue;
    }
    const outFile = path.join(opts.outDir, `${character.id}.png`);
    const prompt = portraitPrompt(character);
    let last = "";
    for (const [attempt, trySeed] of [seed, seed + 1].entries()) {
      await lane.generate({
        payload: buildGeneratePayload({ prompt, seed: trySeed }),
        outFile,
        recordJson: path.join(opts.outDir, `${character.id}.u15_generate.json`),
      });
      const verdict = await lane.qc(outFile, path.join(opts.outDir, `${character.id}.photo_qc.json`), PORTRAIT_REQUIRE);
      if (verdict.status !== "FAIL") {
        files[character.id] = outFile;
        made.push(character.id);
        opts.onEvent?.(`${character.id} 肖像 GREEN（seed ${trySeed}）`, { file: outFile, attempt: attempt + 1 });
        break;
      }
      last = verdict.checks.fail_reasons.join("; ") || "not GREEN";
      opts.onEvent?.(`${character.id} 肖像未過：${last}`, { seed: trySeed });
    }
    if (!files[character.id]) {
      throw new Error(`portrait for ${character.id} failed the eye twice (seeds ${seed}, ${seed + 1}): ${last}`);
    }
  }
  return { files, made, plugged };
}
