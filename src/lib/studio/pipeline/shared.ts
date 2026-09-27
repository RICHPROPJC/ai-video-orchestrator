import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand } from "../audio";
import { readJob, writeJob, type JobOwner } from "../store";
import { relInJob } from "../isolate";
import { jobFile } from "../paths";
import { momentsForShot } from "../asset-board";
import type { QcRequire } from "../photo-qc";
import { buildProse, buildProsePositive } from "../h3-prose";
import { planH3Shot, assertH3Plan, assertH3SubmitWiring, type AnglePortrait } from "../h3-slots";
import type { H3GraphVariant } from "../h3-r2v-graph";
import type { AgentId, CallSheet, JobRecord, PictureQc, ProduceInput, ProviderTrace, Shot } from "../types";
import { floorLine } from "../crew";
import type { SlateConfig } from "../config";
import type { MotionSelection } from "../motion-select";
import type { Continuity } from "../continuity";
import type { PortraitResult } from "../portraits";
import type { PluggedShotWav } from "../shot-wav-plug";
import type { CutPlan } from "../cut-plan";

/** 拆層（SlateCrew pipeline split）：runPipeline 原本係一個 2,8xx 行 closure
 *  巨函——而家同一批 mutable 狀態（job／trace／speak／跨段產物）以單一 Ctx
 *  object 穿梭各段，語義等同 closure 變數：絕唔重排 call 次序、絕唔刪／合併
 *  任何 emit/speak/patch。`stopped` 係段內 early-return（blocked／dry-run／
 *  hop 完）嘅唯一訊號——對應原本 try-block 入面嘅 `return`。 */
export type Ctx = {
  jobId: string;
  input: ProduceInput;
  cfg: SlateConfig;
  job: JobRecord;
  trace: ProviderTrace;
  speak: (agent: AgentId, message: string, level?: "info" | "warn" | "pass" | "fail") => Promise<void>;
  think: (agent: AgentId) => Promise<void>;
  stopped?: boolean;
  continuity?: Continuity;
  locked?: CallSheet;
  timed?: CallSheet;
  motionSelections: Map<string, MotionSelection>;
  stillDir?: string;
  portraits?: PortraitResult;
  audioDir?: string;
  gapSec?: number;
  cloneRef?: string;
  plugged?: PluggedShotWav[];
  wavByShot: Map<string, string>;
  h3WavByShot: Map<string, string>;
  gapDelivered: Map<string, number>;
  cutPlan?: CutPlan;
  spineWav?: string;
  blockoutDir?: string;
  stillPlans?: { shot: Shot; first: boolean; prompt: string; require: QcRequire }[];
  stills: string[];
  geometry?: PictureQc;
  motionDir?: string;
  shotVideos: string[];
  receipts: string[];
  motionShots?: Shot[];
  segManifest?: { kind: string; shots: string[]; frames?: number; perShot?: number }[] | null;
  /** §9⑥：本輪凍結 expected revision——world 落 cut_plan/audio-timeline 兩份
   *  收據後 set；mux 三比（cutPlan＝timeline＝本輪快照）缺一 throw。 */
  callsheetDigest?: string;
};

/** V2c §8：材料指紋——parts 穩定序列化後 sha256 前 12 hex。keep 閘用嚟
 * 驗「碟上產物係用呢啲材料生出嚟」：材料變＝指紋變＝唔 keep。 */
export function depStampOf(parts: Record<string, unknown>): string {
  return createHash("sha256").update(stableJson(parts)).digest("hex").slice(0, 12);
}

/** V2c（PLAN-v2 0928）§8：穩定序列化——object key 排序後先 stringify，
 *  同內容唔理欄位次序都出同一段字（fingerprint 用）。 */
export function stableJson(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) ?? "null";
  if (Array.isArray(v)) return `[${v.map(stableJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableJson(o[k])}`).join(",")}}`;
}

// V2a（PLAN-v2 0928）：pipeline 期間所有狀態寫入帶 owner guard——舊 owner
// 恢復後（epoch 被接管）再 patch 即 throw owner_lost，唔可以靜靜覆蓋新 owner
// 嘅進度。activeOwner 由 runPipeline acquire 後 set（同 process 一次行一份；
// 將來同 process 並行兩 pipeline 要改顯式傳遞）。
/** §9④：聲畫 gap 修訂額度（跨 resume；author 攔截遞增，行內回修同樣食） */
export const GAP_BUDGET = 2;

let activeOwner: JobOwner | undefined;
export function setActiveOwner(owner?: JobOwner) {
  activeOwner = owner;
}
export function patch(job: JobRecord, partial: Partial<JobRecord>) {
  // §10.1：本輪明確提交嘅欄優先——own-property presence 分辨「未提交」與
  // 「明確 []」（attempts+1／新 gaps／清空唔再被磁碟舊值吞）；未提交該欄先
  // 由磁碟承接（emit/world 重算寫嘅狀態唔被舊 ctx 快照蓋走）。
  const disk = readJob(job.id);
  const next = { ...job, ...partial };
  if (!("blockedShots" in partial)) next.blockedShots = disk?.blockedShots ?? next.blockedShots;
  if (!("placementGaps" in partial)) next.placementGaps = disk?.placementGaps ?? next.placementGaps;
  // §14.1a：episode 同一規則承接——未提交＝磁碟最新（author 攔截 attempts+1
  // 唔被 authorStage 舊 ctx.job 覆寫）；明確提交 null＝閂（in 運算子計
  // own-property，null 唔當缺值復活舊 episode）。
  if (!("soundRepairEpisode" in partial)) next.soundRepairEpisode = disk?.soundRepairEpisode ?? next.soundRepairEpisode;
  writeJob(next, activeOwner);
  return next;
}

export function h3GraphVariant(input: ProduceInput): H3GraphVariant {
  return input.graphVariant ?? "a";
}

export function prevShotOf(sheet: CallSheet, shot: Shot): Shot | undefined {
  const i = sheet.shots.findIndex((s) => s.id === shot.id);
  return i > 0 ? sheet.shots[i - 1] : undefined;
}

export function writeH3Plan(
  jobId: string,
  timed: CallSheet,
  shot: Shot,
  wiring: {
    wav: string;
    blockout?: string;
    still: string;
    kfStart?: string;
    kfEnd?: string;
    refImageFiles?: string[];
    anglePortraits?: AnglePortrait[];
  },
) {
  const prev = prevShotOf(timed, shot);
  // plugged portraits live outside the slate — keep their absolute path
  const relOrAbs = (p: string) => {
    try {
      return relInJob(jobId, p);
    } catch {
      return p;
    }
  };
  const plan = planH3Shot({
    shot,
    prev,
    wav: relInJob(jobId, wiring.wav),
    blockout: wiring.blockout ? relInJob(jobId, wiring.blockout) : undefined,
    ourStill: relInJob(jobId, wiring.still),
    anglePortraits: wiring.anglePortraits?.map((p) => ({ ...p, file: relOrAbs(p.file) })),
  });
  assertH3Plan(plan);
  assertH3SubmitWiring(plan, {
    kfStart: wiring.kfStart,
    kfEnd: wiring.kfEnd,
    wav: wiring.wav,
    blockout: wiring.blockout,
    refImageFiles: wiring.refImageFiles,
    prevShotId: prev?.id,
  });
  fs.mkdirSync(path.dirname(jobFile(jobId, "motion", `${shot.id}.h3_plan.json`)), { recursive: true });
  fs.writeFileSync(jobFile(jobId, "motion", `${shot.id}.h3_plan.json`), JSON.stringify(plan, null, 2));
  return plan;
}

function existingKeyframeFiles(shot: Shot, stillDir: string): string[] {
  const listed = (shot.keyframeFiles ?? []).filter((file) => fs.existsSync(file));
  if (listed.length > 0) return listed;
  // resume 回填：callsheet 未寫 positions（sheet 段被 GREEN pin 跳過）但 KF 格
  // 已在盤——一樣返還佢哋；positions 缺席唔等於 KF 唔存在。呼叫者自帶
  // positions 閘（rideKf/rideCuts），呢度唔重複擋。
  return momentsForShot(shot, stillDir).map((moment) => moment.file).filter((file) => fs.existsSync(file));
}

/** KF+Video1 共存回填（Sol 0926 裁決 E）：callsheet 冇 positions 但 KF 格已在
 *  盤 → 按格數等分百份比行共存，並即時寫返 callsheet（唔寫返＝下次 resume 又
 *  丟；plan.positions 由 shot 起，本地變數傳唔到守閘）。單格照舊純 C-form。 */
export function kfRideFor(jobId: string, timed: CallSheet, shot: Shot, stillDir: string): { positions: string; cutFiles: string[] } {
  const written = shot.keyframePositions?.trim() ?? "";
  if (written) return { positions: written, cutFiles: existingKeyframeFiles(shot, stillDir) };
  const cutFiles = existingKeyframeFiles(shot, stillDir);
  if (cutFiles.length < 2) return { positions: "", cutFiles };
  const positions = cutFiles.map((_, i) => `${Math.round((i / (cutFiles.length - 1)) * 100)}%`).join(", ");
  shot.keyframePositions = positions;
  shot.keyframeFiles = cutFiles;
  fs.writeFileSync(jobFile(jobId, "callsheet.json"), JSON.stringify(timed, null, 2));
  return { positions, cutFiles };
}

/** §5b C-form identity refs: one angle-version portrait per marked character,
 *  left-to-right, the refAngle column picking front/45°. The 45° version
 *  comes from the job portraits dir or a plug dir ({id}_45.png, WR1Q shape);
 *  a 45° shot without it fails loud — the frontal version drags the face back
 *  to camera (the B-lane regression). */
export function anglePortraitsFor(
  shot: Shot,
  portraitFiles: Record<string, string>,
  portraitDir?: string,
  plugDir?: string,
): AnglePortrait[] {
  const ordered = [...new Set([...shot.marks].sort((a, b) => a.start.x - b.start.x).map((m) => m.characterId))];
  const find = (name: string) =>
    [portraitDir, plugDir].map((d) => (d ? path.join(d, name) : "")).find((p) => p && fs.existsSync(p));
  return ordered.map((id) => {
    const angle: "front" | "45" = shot.refAngle === "45" ? "45" : "front";
    if (angle === "45") {
      const angled = find(`${id}_45.png`);
      if (angled) return { characterId: id, angle, file: angled };
      throw new Error(
        `angle_portrait_missing: ${shot.id} refAngle=45 需要 ${id}_45.png（45°角度版肖像）— 正面版會將個面拉返向鏡頭（B-lane regression），唔准頂`,
      );
    }
    const fromMap = portraitFiles[id];
    if (fromMap && fs.existsSync(fromMap)) return { characterId: id, angle, file: fromMap };
    const onDisk = find(`${id}.png`);
    if (onDisk) return { characterId: id, angle, file: onDisk };
    throw new Error(`${shot.id}: C-form 冇${id}肖像 — ref_image_0 身份ref缺件（首次出場要有肖像）`);
  });
}

/** Uncut angle board only. A cut cell, a still, or a blockout frame is the wrong class. */
export function uncutIdentityFiles(
  shot: Shot,
  sheets: Record<string, string> | undefined,
  dirs: string[],
): string[] {
  const ordered = [...new Set([...shot.marks].sort((a, b) => a.start.x - b.start.x).map((m) => m.characterId))];
  return ordered.map((id) => {
    const candidates = [
      sheets?.[id] ?? "",
      ...dirs.filter(Boolean).map((dir) => path.join(dir, "boards", `${id}.angles.png`)),
    ];
    const file = candidates.find((p) => p && fs.existsSync(p));
    if (!file) throw new Error(`identity_sheet_missing: ${shot.id} ${id} 未切成張唔在，唔用切格頂`);
    const norm = file.replace(/\\/g, "/");
    if (/\/stills\/|\/blockout\/|\/cast\//.test(norm) || !norm.endsWith(`/boards/${id}.angles.png`)) {
      throw new Error(`identity_sheet_missing: ${shot.id} ${id} 唔係未切成張（${path.basename(file)}）`);
    }
    return file;
  });
}

export function h3MotionPack(
  timed: CallSheet,
  shot: Shot,
  variant: H3GraphVariant,
  stillPng: string,
  portraitFiles: Record<string, string>,
  prev?: Shot,
  opts?: { hasVideo1?: boolean; portraitDir?: string; plugDir?: string; sheets?: Record<string, string>; cformStillRef?: string },
) {
  // §5b: the Video 1 asset routes the form. Motion shots carry a blockout
  // (the blockout lane renders one per shot) → C-form; a shot with no Video 1
  // asset stays A-form still-to-video (H3Keyframes 0%/100%).
  const hasVideo1 = opts?.hasVideo1 !== false;
  if (variant === "a") {
    if (!shot.uiShot) {
      if (hasVideo1) {
        // Sol 0926 裁決 E：ref_image_0＝本鏡 GREEN 劇照一張（同一人同一場同一
        // 道具嘅實拍定格）——角度板今次退場（減 competing refs，唔係全局禁）。
        // KF×Video1 共存時 prose 唔加 gait/stance 演繹（同 KF 錨衝突）。
        const stillRef = opts?.cformStillRef;
        if (stillRef && fs.existsSync(stillRef)) {
          const firstChar = [...new Set([...shot.marks].sort((a, b) => a.start.x - b.start.x).map((m) => m.characterId))][0]
            ?? shot.marks[0]?.characterId ?? "";
          return {
            prose: buildProse(timed, shot, { prevLocation: prev?.location, prevShot: prev, form: "c", kfCoexist: true }),
            refImageFiles: [stillRef],
            anglePortraits: [{ characterId: firstChar, angle: "front" as const, file: stillRef }],
            uiPhotoFiles: undefined as string[] | undefined,
            kfEnd: undefined as string | undefined,
          };
        }
        // story motion shot, C-form: Picture N = the uncut sheet, not a cut cell
        const sheets = uncutIdentityFiles(shot, opts?.sheets, [opts?.portraitDir ?? "", opts?.plugDir ?? ""]);
        const anglePortraits = [...new Set([...shot.marks].sort((a, b) => a.start.x - b.start.x).map((m) => m.characterId))]
          .map((id, i) => ({ characterId: id, angle: "front" as const, file: sheets[i]! }));
        return {
          prose: buildProse(timed, shot, { prevLocation: prev?.location, prevShot: prev, form: "c" }),
          refImageFiles: sheets,
          anglePortraits,
          uiPhotoFiles: undefined as string[] | undefined,
          kfEnd: undefined as string | undefined,
        };
      }
      // no Video 1 asset: still-to-video — keyframes two ends, zero refs
      return {
        prose: buildProse(timed, shot, { prevLocation: prev?.location, prevShot: prev, form: "a" }),
        refImageFiles: undefined as string[] | undefined,
        anglePortraits: [] as AnglePortrait[],
        uiPhotoFiles: undefined as string[] | undefined,
        kfEnd: stillPng,
      };
    }
    // card ③b: UI/infographic shot — photo refs ride ref_images (law: 文字圖／
    // 手機畫面等 UI 反而可以俾 H3 ref) and the prose carries the mapping
    // table. uiShot is the only gate: story shots with stray uiRefs stay
    // ref-free. On the C-form the ui board keeps <Picture 1>; no keyframes.
    return {
      prose: buildProse(timed, shot, { ui: shot.uiSpec ?? {}, prevShot: prev, form: hasVideo1 ? "c" : "a" }),
      refImageFiles: undefined as string[] | undefined,
      anglePortraits: [] as AnglePortrait[],
      uiPhotoFiles: shot.uiRefs ?? [] as string[],
      kfEnd: hasVideo1 ? undefined : stillPng,
    };
  }
  const ids = [...new Set(shot.marks.map((m) => m.characterId))];
  const portraits = ids
    .map((id) => {
      const c = timed.characters.find((ch) => ch.id === id);
      return c ? { id, name: c.name } : null;
    })
    .filter((p): p is { id: string; name: string } => Boolean(p));
  const refImageFiles =
    variant === "b" || variant === "bkf"
      ? [stillPng, ...ids.map((id) => portraitFiles[id]).filter((p) => p && fs.existsSync(p))]
      : undefined;
  return {
    prose: buildProsePositive(timed, shot, { motionOnly: variant === "c", portraits }),
    refImageFiles,
    anglePortraits: [] as AnglePortrait[],
    uiPhotoFiles: undefined as string[] | undefined,
    kfEnd: undefined as string | undefined,
  };
}

export async function ffmpeg(args: string[]) {
  const result = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", ...args]);
  if (result.code !== 0) {
    throw new Error(result.stderr || "ffmpeg failed");
  }
}

/** Runtime of a delivered file as the container reports it. */
export async function mediaSeconds(file: string): Promise<number> {
  const r = await runCommand("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "json", file,
  ]);
  if (r.code !== 0) throw new Error(r.stderr || `ffprobe failed on ${file}`);
  const d = Number((JSON.parse(r.stdout).format ?? {}).duration);
  if (!Number.isFinite(d)) throw new Error(`ffprobe: no duration for ${file}`);
  return Number(d.toFixed(3));
}

/** C-scene-hop: `--scene SCxx` narrows the stills/picture-QC lanes and the H3
 *  lane to one scene's shots (scene field, else beatId prefix `SCxx.`).
 *  Omitted = every shot, the existing whole-slate path. Zero matches throws —
 *  never silently fall back to burning the full slate. */
export function shotsForScene(shots: Shot[], scene?: string): Shot[] {
  if (!scene) return shots;
  const kept = shots.filter(
    (s) => s.scene === scene || (s.beatId ?? "").startsWith(`${scene}.`),
  );
  if (!kept.length) {
    throw new Error(`--scene ${scene}：一鏡都對唔上（冇 shot 嘅 scene／beatId 係 ${scene}）— 唔靜靜哋燒成個 slate`);
  }
  return kept;
}

/** g6 hop geometry: a `--scene` hop's stills + picture-QC lanes only make the
 *  hop's shots, so the plan-geometry pre-check must score the hop's shots —
 *  never the full slate's list, which cried "Missing stills vs shot list" on a
 *  healthy SC01 hop (LD0F). Same no-match throw as the H3 crop. */
export function hopGeometrySheet(sheet: CallSheet, scene?: string): CallSheet {
  return scene ? { ...sheet, shots: shotsForScene(sheet.shots, scene) } : sheet;
}

export function describeFloor() {
  return floorLine();
}
