/** PR-2：Editor 席（阿剪／剪接）——從 pipeline.ts :911-1085 抽出
 * 照 core/delivery-template.ts 席位遷移標準：SeatModule + SeatContext + SeatResult。
 * concat gate + per-shot mux + picture-lock concat。唔改共享模組。 */

import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { AgentId } from "../types";
import type { SeatModule, SeatContext, SeatResult } from "../core/orchestrator";
import type { CutPlan } from "../cut-plan";
import { open, packetLine, seal } from "../dispatch";
import { checkGate } from "../concat-gate";
import { jobDir, jobFile } from "../paths";
import { assertNativeFfmpeg, concatCopyArgs } from "../native-cut";
import { localPictureQc } from "../providers";
import { pinVideoQcAccepted } from "../video-qc";
import { wavSeconds } from "../frame-grid";
import { loadCallSheet } from "../writer";
import {
  ffmpeg,
  mediaSeconds,
  patch,
  shotsForScene,
  stableJson,
} from "../pipeline/shared";

/** H3's ref-audio clock must equal the video clock: pad the wav with trailing
 *  silence to the snapped frame length; the same file feeds the mux.
 *  （原 pipeline.ts :162-169——editor 席專用 helper，跟席搬走） */
export async function padH3Wav(src: string, dst: string, frames: number): Promise<number> {
  const seconds = frames / 24;
  await ffmpeg(["-i", src, "-af", `apad=whole_dur=${seconds.toFixed(6)}`, "-c:a", "pcm_s16le", dst]);
  const got = await wavSeconds(dst);
  if (Math.abs(got - seconds) > 1 / 48) {
    throw new Error(`${dst}: padded to ${got.toFixed(4)}s, wanted ${seconds.toFixed(4)}s (${frames}f/24)`);
  }
  return got;
}

/** per-shot mux: own padded wav, level-matched; H3's own audio is dropped
 *  （原 pipeline.ts :172-185） */
export function muxArgs(mp4: string, h3Wav: string, out: string): string[] {
  const args = [
    "-i", mp4,
    "-i", h3Wav,
    "-map", "0:v", "-map", "1:a",
    "-af", "loudnorm=I=-18:TP=-1.5:LRA=11",
    "-c:v", "copy", "-c:a", "aac", "-b:a", "128k",
    "-shortest",
    out,
  ];
  assertNativeFfmpeg(args);
  return args;
}

type SegManifest = { kind: string; shots: string[]; frames?: number; perShot?: number }[];

function loadCutPlan(jobId: string): CutPlan & { callsheetDigest?: string } {
  const file = jobFile(jobId, "cut_plan.json");
  if (!fs.existsSync(file)) throw new Error(`editor_missing_cut_plan: ${file}`);
  return JSON.parse(fs.readFileSync(file, "utf8")) as CutPlan & { callsheetDigest?: string };
}

function loadSegManifest(motionDir: string): SegManifest | null {
  const segmentsFile = path.join(motionDir, "segments.json");
  if (!fs.existsSync(segmentsFile)) return null;
  return JSON.parse(fs.readFileSync(segmentsFile, "utf8")) as SegManifest;
}

function h3WavMap(jobId: string, cut: string[]): Map<string, string> {
  const audioDir = path.join(jobDir(jobId), "audio");
  const map = new Map<string, string>();
  for (const id of cut) {
    const h3 = path.join(audioDir, `${id}.h3.wav`);
    if (fs.existsSync(h3)) map.set(id, h3);
  }
  return map;
}

function listShotVideos(motionDir: string): string[] {
  if (!fs.existsSync(motionDir)) return [];
  return fs.readdirSync(motionDir)
    .filter((f) => f.endsWith(".mp4") && !f.includes(".muxed.") && !f.includes(".qc."))
    .map((f) => path.join(motionDir, f));
}

function emptyResult(status: SeatResult["status"], stopped: boolean, extra?: Partial<SeatResult>): SeatResult {
  return {
    status,
    stopped,
    artifacts: [],
    receipts: [],
    gaps: [],
    violations: [],
    ...extra,
  };
}

export const editorSeat: SeatModule = {
  seatId: "editor" as AgentId,

  async run(ctx: SeatContext): Promise<SeatResult> {
    const { jobId, input } = ctx;
    const motionDir = path.join(jobDir(jobId), "motion");
    const audioDir = path.join(jobDir(jobId), "audio");
    const spineFile = path.join(audioDir, "spine.wav");

    ctx.think("editor");

    try {
      const cutPlanRaw = loadCutPlan(jobId);
      const cut = cutPlanRaw.shots.map((s) => s.id);
      const plan: CutPlan = {
        gap_s: cutPlanRaw.gap_s,
        shots: cutPlanRaw.shots,
        ...(cutPlanRaw.spine_duration_s != null ? { spine_duration_s: cutPlanRaw.spine_duration_s } : {}),
      };
      const callsheetDigest = cutPlanRaw.callsheetDigest ?? ctx.job.callsheetDigest;
      const segManifest = loadSegManifest(motionDir);
      const shotVideos = listShotVideos(motionDir);
      const h3WavByShot = h3WavMap(jobId, cut);

      // editor: machine gate, per-shot mux (own wav, drop H3 audio), concat only after gate
      // MULTISHOT_WIRE: a multi-shot segment muxes ONCE against its concatenated
      // wav — the segment is one continuous take
      const toEditor = seal({
        slate: jobId,
        from: "boards",
        to: "editor",
        payload: { cut },
      });
      const { cut: openedCut } = open(toEditor, { slate: jobId, to: "editor" });
      ctx.speak("editor", `${packetLine(toEditor)} · 照分鏡接：${openedCut.join(" → ")}。唔重排。`);

      const segGateSegments = segManifest?.length ? segManifest : undefined;
      const gate = await checkGate({
        plan,
        motionDir,
        spineWav: fs.existsSync(spineFile) ? spineFile : undefined,
        outFile: jobFile(jobId, "concat_gate.json"),
        ...(segGateSegments ? { segments: segGateSegments.map((s) => ({ shots: s.shots, frames: s.frames, perShot: s.perShot, kind: s.kind })) } : {}),
      });
      if (!gate.ok) {
        throw new Error(`concat gate FAIL: ${gate.reason}`);
      }

      const concatWav = async (wavs: string[], out: string): Promise<string> => {
        const list = out.replace(/\.wav$/, ".wavlist.txt");
        fs.writeFileSync(list, wavs.map((w) => `file '${w.replaceAll("'", "'\\''")}'`).join("\n"));
        await ffmpeg(["-f", "concat", "-safe", "0", "-i", list, "-c", "copy", out]);
        return out;
      };

      // R18：motion＝H3 per-shot 出完停——唔入 mux/交付。
      if (input.until === "motion") {
        ctx.speak("producer", `--until motion：H3 per-shot mp4 已落盤，停喺 motion 位（唔入 mux/交付）。`);
        return emptyResult("PASSED", true);
      }

      // mux targets in cut order: manifest segments first, then legacy solo files
      const inManifest = new Set((segManifest ?? []).flatMap((s) => s.shots));
      const muxTargets = [
        ...(segManifest ?? []).map((s) => ({ id: s.shots.join("-"), shots: s.shots })),
        ...openedCut.filter((id) => !inManifest.has(id)).map((id) => ({ id, shots: [id] })),
      ].sort((a, b) => openedCut.indexOf(a.shots[0]!) - openedCut.indexOf(b.shots[0]!));
      const muxed: string[] = [];
      const blockedCauses = new Map<string, string>();
      // §29-3（B2 #3）實際剪接收據：每段 source（H3 產出檔＋sha256＋實際 in/out）
      // ＋destination（concat 序實際 in/out）＋covered shotIds；callsheetDigest＝
      // 採用 cut 版本。整段使用明示 wholeFile＋實際尾點（ffprobe 實測，唔由檔名/
      // 故事時長猜——§29 原文）；blocked 段唔入收據（events 已具名）。
      const editReceipts: {
        id: string; shots: string[];
        source: { file: string; sha256: string; muxMode: string; sourceDurSec: number | null; sourceConsumedInOut: "unknown"; note: string; h3SubmitRefs: { shot: string; file?: string; promptId?: string | null; outputSha256?: string | null; missing?: string; unparsable?: boolean }[] };
        muxedOutput: { file: string; sha256: string; durationSec: number | null };
        wav: { file: string; sha256: string };
        destination: { inOut: [number | null, number | null]; basis: string; note: string };
        shotBoundaries: string;
      }[] = [];
      let destCursor: number | null = 0;
      for (const t of muxTargets) {
        const mp4 = shotVideos.find((v) => path.basename(v, ".mp4") === t.id)
          ?? path.join(motionDir, `${t.id}.mp4`);
        // 0927 停法手術：motion 段 blocked（per-shot skip 落嚟冇 mp4）→呢段 mux
        // blocked skip 繼續其他段；wav 缺同罪。成片少嗰段係事實，events 有列明。
        const wavs = t.shots.map((id) => h3WavByShot.get(id));
        if (!fs.existsSync(mp4) || wavs.some((w) => !w)) {
          const message = `${!fs.existsSync(mp4) ? `cut ${t.id} missing from motion` : `${t.id} wav 缺`}——呢段 blocked，繼續其他段`;
          ctx.speak("motion", message, "warn");
          // §32-2：omitted 對帳消費同份結構化 cause（唔硬寫兩個可能理由字串）
          blockedCauses.set(t.id, !fs.existsSync(mp4) ? `motion-missing:${t.id}` : `wav-missing:${t.id}`);
          continue;
        }
        const wav = t.shots.length === 1
          ? wavs[0]!
          : await concatWav(wavs as string[], path.join(motionDir, `${t.id}.wav`));
        const marked = segManifest?.find((s) => s.shots.join("-") === t.id);
        const clockWav = marked?.frames
          ? path.join(motionDir, `${t.id}.clock.wav`)
          : wav;
        if (marked?.frames) await padH3Wav(wav, clockWav, marked.frames);
        const out = path.join(motionDir, `${t.id}.muxed.mp4`);
        await ffmpeg(muxArgs(mp4, clockWav, out));
        // §30（0928）深修：①來源消費區間冇足夠證據＝具名 unknown——容器 duration
        // 係探測參考值，唔反寫成「已證 source 全長消費」（-shortest 下實際終點
        // 由聲軌決定，精確 trim 點要剪接層契約）；②dest 累計用原始浮點（顯示先
        // round，唔中間 round 當精確全片鐘），prefix 未知傳導；③muxed/wav hash＋
        // h3_submit 引用入收據；④段內 shot 實際邊界未證明示（segment 拆分資料
        // 缺＝未證，唔均分秒數猜）。
        const srcDur = await mediaSeconds(mp4).catch(() => null);
        const muxedDur = await mediaSeconds(out).catch(() => null);
        editReceipts.push({
          id: t.id,
          shots: t.shots,
          source: {
            file: path.basename(mp4),
            sha256: createHash("sha256").update(fs.readFileSync(mp4)).digest("hex"),
            muxMode: "ffmpeg-shortest",
            sourceDurSec: srcDur,
            sourceConsumedInOut: "unknown",
            note: "-shortest 下實際使用終點由聲軌決定（≤ muxedDurSec）；來源消費區間未證＝unknown，容器 duration 只係探測參考",
            h3SubmitRefs: t.shots.map((id) => {
              const sf = path.join(motionDir, `${id}.h3_submit.json`);
              if (!fs.existsSync(sf)) return { shot: id, missing: "h3_submit receipt 不存在（named-missing，唔猜路徑）" };
              try {
                const r = JSON.parse(fs.readFileSync(sf, "utf8")) as { prompt_id?: string | null; output?: { sha256?: string } };
                return { shot: id, file: `motion/${id}.h3_submit.json`, promptId: r.prompt_id ?? null, outputSha256: r.output?.sha256 ?? null };
              } catch {
                return { shot: id, file: `motion/${id}.h3_submit.json`, unparsable: true };
              }
            }),
          },
          muxedOutput: {
            file: path.basename(out),
            sha256: createHash("sha256").update(fs.readFileSync(out)).digest("hex"),
            durationSec: muxedDur,
          },
          wav: {
            file: path.basename(clockWav),
            sha256: createHash("sha256").update(fs.readFileSync(clockWav)).digest("hex"),
          },
          destination: {
            inOut: [
              destCursor === null ? null : Number(destCursor.toFixed(3)),
              destCursor === null || muxedDur === null ? null : Number((destCursor + muxedDur).toFixed(3)),
            ],
            basis: "container-duration-cumulative",
            note: "容器時長累計＝粗略拼接估計，唔宣稱精確 video PTS 位置；前綴未知則後續同 null",
          },
          shotBoundaries: "unverified",
        });
        destCursor = destCursor === null || muxedDur === null ? null : destCursor + muxedDur;
        muxed.push(out);
      }
      // §30-4：blocked 省略對帳——planned cut 中冇入 concat 嘅段連 events blocked
      // 理由（同一 job/attempt/revision 下 planned vs 省略可對；引用既有 events
      // 理由字串，唔重造狀態真源）。
      const includedIds = new Set(editReceipts.map((r) => r.id));
      const omittedFromConcat = muxTargets.filter((t) => !includedIds.has(t.id)).map((t) => ({
        id: t.id,
        shots: t.shots,
        cause: blockedCauses.get(t.id) ?? "unknown（skip 分支冇記錄——數據源斷，唔猜）",
      }));
      const muxList = jobFile(jobId, "motion", "mux-list.txt");
      fs.writeFileSync(muxList, muxed.map((v) => `file '${v.replaceAll("'", "'\\''")}'`).join("\n"));
      const pictureLock = jobFile(jobId, "delivery", "picture-lock.mp4");
      await ffmpeg(concatCopyArgs(muxList, pictureLock));
      // §29-3（review 修正）：edit-receipts 喺 concat 成功後先寫（concat throw＝
      // 零收據＝「concat 未完成」與「實際交付」天然分開）；頂層綁真 cut digest
      // （cutOrder＋段組成 stableJson——唔用 callsheetDigest 冒充 cut 內容版本）
      // ＋交付路徑明示。
      fs.writeFileSync(jobFile(jobId, "delivery", "edit-receipts.json"), JSON.stringify({
        // §32-1：真 sha256（stableJson 淨係排序序列化——直接 slice 前 16 字＝JSON
        // 前綴碰撞，唔係 digest）；canonical payload＝cutOrder＋段組成
        cutDigest: createHash("sha256").update(stableJson({ cutOrder: openedCut, segments: editReceipts.map((r) => ({ id: r.id, shots: r.shots })) })).digest("hex").slice(0, 16),
        // §32-4：run 識別——resume 舊 receipt 由 UI 憑呢啲欄位判 current（檔案
        // 存在唔自動＝採納；本 run 蓋寫＝新證據取代舊，歷史在 events/git）
        run: { jobId, callsheetDigest: callsheetDigest ?? null, writtenAt: new Date().toISOString() },
        callsheetDigest: callsheetDigest ?? null,
        cutOrder: openedCut,
        delivery: {
          pictureLock: "delivery/picture-lock.mp4",
          pictureLockSha256: createHash("sha256").update(fs.readFileSync(pictureLock)).digest("hex"),
          outcome: "concat-delivered",
        },
        segments: editReceipts,
        ...(omittedFromConcat.length ? { omittedFromConcat } : {}),
      }, null, 2));

      const callsheetPath = jobFile(jobId, "callsheet.json");
      if (fs.existsSync(callsheetPath)) {
        const timed = loadCallSheet(callsheetPath);
        const stillDir = path.join(jobDir(jobId), "stills");
        const stills = fs.existsSync(stillDir)
          ? fs.readdirSync(stillDir).filter((f) => /\.png$/i.test(f)).map((f) => path.join(stillDir, f))
          : [];
        const markGeometry = localPictureQc({
          stills,
          sheet: input.scene ? { ...timed, shots: shotsForScene(timed.shots, input.scene) } : timed,
          target: "video",
        });
        // video_qc pins are per SHOT (segment slices pin under their own ids)
        void openedCut.every((id) => pinVideoQcAccepted(motionDir, id));
        patch(ctx.job, {
          pictureQcVideo: markGeometry,
          progress: 92,
          outputs: { ...ctx.job.outputs, concatGate: "concat_gate.json", pictureLock: "delivery/picture-lock.mp4" },
        });
      } else {
        patch(ctx.job, {
          progress: 92,
          outputs: { ...ctx.job.outputs, concatGate: "concat_gate.json", pictureLock: "delivery/picture-lock.mp4" },
        });
      }

      ctx.speak("editor", `剪接完成：picture-lock · ${openedCut.join(" → ")}`, "pass");
      return emptyResult("PASSED", false);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      ctx.speak("editor", `剪接失敗：${message}`, "fail");
      return emptyResult("FAILED_TERMINAL", true, {
        violations: [{ step: "editor", constraint: "editor", severity: "hard", saw: message, expected: "no throw" }],
      });
    }
  },
};
