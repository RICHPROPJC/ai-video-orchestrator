import fs from "node:fs";
import path from "node:path";
import type { CallSheet, Character, RefAngle } from "./types";
import { buildGeneratePayload, u15Generate, type GeneratePayload } from "./u15-generate";
import { runPhotoQc, type PhotoQcRecord, type QcRequire } from "./photo-qc";

/** One face, alone, no placeholders, no scene — the same eye that gates the
 *  keyframes, plus the portrait-only plain-background gate (T43b: a night
 *  street behind the face is a scene still, not a portrait anchor). */
export const PORTRAIT_REQUIRE: QcRequire = { people_count: 1, grey_blocks: false, plain_background: true };

/** T43 (Chau: embed 同一張垃圾圖一路塞返 /edit，源頭 1＝肖像抄 world night/neon):
 * a portrait is a face reference, not a scene — the sheet's world line
 * (location/timeOfDay/weather/grade) NEVER enters it. Only: 一人半身、wardrobe、
 * palette、Plain background. The sheet param rides for the lane/crew call
 * shape but is never read — the leak cannot come back by accident.
 *
 * angle "45" (card C2, §0b 0920) returns the /edit sentence that turns the
 * FRONT portrait into the three-quarter ref — it is fed to u15Edit with
 * Image-1 = the front portrait, never to t2i generate (that's why it names
 * the character: identity rides the image). The verified v2 formula must
 * name the eye guard and the 90° ban — without it U1.5 runs to a pure
 * profile (angle-test-45 receipt: v1 without the ban came out 90°). */
export function portraitPrompt(character: Character, sheet?: CallSheet, angle: RefAngle = "front"): string {
  if (angle === "45") {
    return [
      `【編輯】Image-1係角色${character.name}嘅正面參考圖（${character.wardrobe}、純色studio底）。`,
      `將佢嘅頭部同身體輕微轉側45度（three-quarter三份一側面）：同一個人——面容輪廓、髮型、成套衫著全部照Image-1不變；`,
      `頭轉向畫面左前方約45度，唔好轉成90度純側面，要仍然見到雙眼同兩邊面頰，鼻樑喺兩眼之間突出嚟。`,
      `身體微微轉側唔好完全側晒。背景照舊純色。唔好加嘢唔好變第二個人。`,
    ].join("");
  }
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
