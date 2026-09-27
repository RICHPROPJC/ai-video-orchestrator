import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { runCommand, writeWav } from "./audio";
import { ensureAudibleShotWav, runAukTts, wavIsAudible, type RunAukTtsOpts } from "./auk-tts";
import type { AudioEvent, Shot } from "./types";

export type PluggedShotWav = {
  shotId: string;
  file: string;
  /** "copied" = given plug wav; "auk" = dialogue take; "silent" = picture beat, no
   *  line; "event" = 聲音事件切片（PROVENANCE_0927：一句一 take，本鏡淨係播
   *  自己窗口嗰段——take 本身可能源自 plug 或 AuK，事件 take 落 audio/events/） */
  source: "copied" | "auk" | "silent" | "event";
  /** dialogue text the AuK take reads ("" for plug and silent shots) */
  text: string;
  /** §8.1：實際音訊切片收據——本鏡播出邊句嘅邊段（take offset/dur），
   *  coverage 對照用呢份，唔另推一套算法 */
  slices?: { beatId: string; takeOffsetSec: number; durSec: number; relMs: number }[];
};

export type PlugShotWavsOpts = {
  boards: Shot[];
  /** --wav-dir plug; undefined = voice seat speaks every dialogue shot */
  wavDir?: string;
  audioDir: string;
  /** job-level clone ref (--clone upload); undefined falls back to tts.promptWav inside runAukTts */
  cloneRef?: string;
  synthesize?: (opts: RunAukTtsOpts) => Promise<unknown>;
  onShot?: (r: PluggedShotWav) => void | Promise<void>;
};

/** Voice hop, per shot: a plug wav is copied, dialogue goes to AuK, a picture
 *  beat with no line gets a silent take. The bed mix fills the locked clock;
 *  AuK is not padded with silence. A named --wav-dir that lacks the file still fails. */
export async function plugShotWavs(opts: PlugShotWavsOpts): Promise<PluggedShotWav[]> {
  const out: PluggedShotWav[] = [];
  for (const shot of opts.boards) {
    const src = opts.wavDir ? path.join(opts.wavDir, `${shot.id}.wav`) : undefined;
    if (src && !fs.existsSync(src)) {
      throw new Error(`--wav-dir 缺 ${shot.id}.wav（${src}）`);
    }
    const text = shot.dialogue.trim();
    const dst = path.join(opts.audioDir, `${shot.id}.wav`);
    let source: PluggedShotWav["source"];
    if (!src && !text) {
      fs.mkdirSync(opts.audioDir, { recursive: true });
      const seconds = Math.max(1 / 24, shot.durationSec);
      writeWav(dst, new Float32Array(Math.round(seconds * 22050)), 22050);
      source = "silent";
    } else {
      const base = opts.synthesize ?? runAukTts;
      const synth = ((o: RunAukTtsOpts) => base(opts.cloneRef ? { ...o, promptWav: opts.cloneRef } : o)) as typeof runAukTts;
      source = await ensureAudibleShotWav({ src, dst, text, synthesize: synth });
    }
    const row: PluggedShotWav = { shotId: shot.id, file: dst, source, text };
    out.push(row);
    await opts.onShot?.(row);
  }
  return out;
}

/** DIALOGUE_RULE_PROVENANCE_0927 — 聲音事件路徑。對白係事件（一句一條連續
 *  take），畫面係鏡：take 只生成一次（plug 鍵喺事件首鏡 id，或 AuK 逐句讀），
 *  每鏡淨係切自己窗口嗰段落盤——切鏡唔重新生成、唔重播、唔將講者改成被拍
 *  嘅聽者。一鏡多句＝多段 slice 疊埋；冇事件經過＝靜音 take（bed 照鋪）。
 *  事件窗口由 boards-expand 衍生（assertSheetGates 已驗連續＋夠講）。 */
export async function plugVoiceEvents(opts: {
  boards: Shot[];
  events: AudioEvent[];
  audioDir: string;
  /** --wav-dir plug：鍵＝事件「首個播出鏡」嘅 SH id（一句一條 take，唔係逐鏡） */
  wavDir?: string;
  cloneRef?: string;
  synthesize?: (opts: RunAukTtsOpts) => Promise<unknown>;
  onShot?: (r: PluggedShotWav) => void | Promise<void>;
}): Promise<{ perShot: PluggedShotWav[]; takes: { beatId: string; file: string }[] }> {
  const { wavSeconds } = await import("./frame-grid");
  fs.mkdirSync(path.join(opts.audioDir, "events"), { recursive: true });
  // 共同時間線（cut order 累計）——同 boards-expand deriveAudioEvents 同一算法
  let t = 0;
  const windows = opts.boards.map((shot) => {
    const w = { shotId: shot.id, start: t, end: t + shot.durationSec };
    t = w.end;
    return w;
  });
  const byId = new Map(opts.boards.map((s) => [s.id, s]));
  // 每事件一條 take（一次生成，全部覆蓋鏡共用）
  const synth = ((o: RunAukTtsOpts) => (opts.synthesize ?? runAukTts)(opts.cloneRef ? { ...o, promptWav: opts.cloneRef } : o)) as typeof runAukTts;
  const takes: { beatId: string; file: string }[] = [];
  for (const ev of opts.events) {
    const cover = windows.filter((w) => w.start < ev.endSec - 1e-9 && w.end > ev.startSec + 1e-9);
    if (cover.length === 0) throw new Error(`audio event ${ev.beatId} covers no shot（窗口 ${ev.startSec}–${ev.endSec}s）`);
    const dst = path.join(opts.audioDir, "events", `${ev.beatId}.wav`);
    // V2c（PLAN-v2 0928）§8：take 綁 utterance 文字——sidecar 記生成時原文；
    // 文字改咗（revise 後）就重新生成，唔會食舊 take 出舌聲。舊 take 冇
    // sidecar＝provenance-unknown：一律當文字對唔上重新過 ensure（plug 路
    // 重新 copy 同一個 src——plug 係外部錄音，內容真源喺人手嗰邊，呢度淨
    // 可以對 TTS 路嚴格；TTS 路文字改＝重新合成）。
    const textSidecar = path.join(opts.audioDir, "events", `${ev.beatId}.text.json`);
    // §11②：take cache 輸入指紋——text/speaker 之外綁實際生成輸入：plug 路
    // ＝src wav bytes sha；auk 路＝cloneRef bytes sha。同 speaker 換 clone 檔
    // 內容／外來 wav 同路徑換血→sha 變→重生成。舊 sidecar（淨 text/speaker）
    // 冇記輸入＝provenance-unknown，一律當 mismatch 明示重建（升級一次過）。
    const inputSha = (f?: string) => (f && fs.existsSync(f)
      ? createHash("sha256").update(fs.readFileSync(f)).digest("hex")
      : "none");
    const src = opts.wavDir ? path.join(opts.wavDir, `${cover[0]!.shotId}.wav`) : undefined;
    const curDeps = {
      text: ev.text,
      speaker: ev.speaker ?? "",
      via: src ? "plug" : "auk",
      srcSha: inputSha(src),
      cloneSha: inputSha(opts.cloneRef),
    };
    const depsMatch = () => {
      try {
        const prev = JSON.parse(fs.readFileSync(textSidecar, "utf8")) as typeof curDeps;
        return prev.text === curDeps.text && prev.speaker === curDeps.speaker
          && prev.via === curDeps.via && prev.srcSha === curDeps.srcSha && prev.cloneSha === curDeps.cloneSha;
      } catch {
        return false;
      }
    };
    if (!(fs.existsSync(dst) && wavIsAudible(dst) && depsMatch())) {
      if (src && !fs.existsSync(src)) {
        throw new Error(`--wav-dir 缺 ${cover[0]!.shotId}.wav（事件 ${ev.beatId} 首鏡 plug，${src}）`);
      }
      await ensureAudibleShotWav({ src, dst, text: ev.text, synthesize: synth });
      fs.writeFileSync(textSidecar, JSON.stringify({ ...curDeps, ts: new Date().toISOString() }, null, 2));
    }
    takes.push({ beatId: ev.beatId, file: dst });
  }
  const takeLen = new Map(takes.map((tk) => [tk.beatId, 0]));
  for (const tk of takes) takeLen.set(tk.beatId, await wavSeconds(tk.file));
  // 每鏡：切自己窗口內嘅事件段落（slice），冇就靜音
  const out: PluggedShotWav[] = [];
  for (const w of windows) {
    const shot = byId.get(w.shotId)!;
    const dst = path.join(opts.audioDir, `${w.shotId}.wav`);
    const slices = opts.events
      .map((ev) => {
        const s0 = Math.max(ev.startSec, w.start);
        const s1 = Math.min(ev.endSec, w.end);
        const takeOffset = Math.max(0, s0 - ev.startSec);
        const dur = Math.min(s1 - s0, (takeLen.get(ev.beatId) ?? 0) - takeOffset);
        return dur > 1e-3 && s1 > s0 + 1e-9 ? { ev, relMs: Math.round((s0 - w.start) * 1000), takeOffset, dur } : null;
      })
      .filter((s): s is { ev: AudioEvent; relMs: number; takeOffset: number; dur: number } => Boolean(s));
    const text = opts.events
      .filter((ev) => ev.startSec < w.end - 1e-9 && ev.endSec > w.start + 1e-9)
      .map((ev) => ev.text)
      .join(" ");
    let source: PluggedShotWav["source"];
    if (slices.length === 0) {
      const seconds = Math.max(1 / 24, shot.durationSec);
      writeWav(dst, new Float32Array(Math.round(seconds * 22050)), 22050);
      source = "silent";
    } else if (slices.length === 1 && slices[0]!.takeOffset < 1e-3
        && slices[0]!.dur >= (takeLen.get(slices[0]!.ev.beatId) ?? 0) - 1e-3) {
      // 真正「成條 take 由鏡頭開頭播晒」（單鏡一句舊形／事件首鏡且 take 唞夠）
      // 先直接落 take，bed 負責墊長——同舊路 byte-相容。relMs===0 唔夠：跨鏡
      // 連續句嘅後續鏡 s0=wStart 一樣 relMs===0，但 takeOffset>0——舊條件會
      // 成條 take 由句首再拷一次＝切鏡重播（C 統籌 0927 指正）。
      fs.copyFileSync(takes.find((tk) => tk.beatId === slices[0]!.ev.beatId)!.file, dst);
      source = "event";
    } else {
      const fileOf = (beatId: string) => takes.find((tk) => tk.beatId === beatId)!.file;
      const args: string[] = [];
      const filters: string[] = [];
      slices.forEach((sl, k) => {
        args.push("-ss", sl.takeOffset.toFixed(3), "-t", sl.dur.toFixed(3), "-i", fileOf(sl.ev.beatId));
        filters.push(`[${k}:a]aresample=22050,aformat=channel_layouts=mono,adelay=${sl.relMs}:all=1[a${k}]`);
      });
      const mix = slices.map((_, k) => `[a${k}]`).join("");
      const result = await runCommand("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error",
        ...args, "-filter_complex", `${filters.join(";")};${mix}amix=inputs=${slices.length}:normalize=0`,
        "-c:a", "pcm_s16le", dst]);
      if (result.code !== 0) throw new Error(result.stderr || `${dst} 事件切片混音失敗`);
      source = "event";
    }
    const row: PluggedShotWav = {
      shotId: w.shotId, file: dst, source, text,
      ...(slices.length ? { slices: slices.map((sl) => ({ beatId: sl.ev.beatId, takeOffsetSec: Number(sl.takeOffset.toFixed(3)), durSec: Number(sl.dur.toFixed(3)), relMs: sl.relMs })) } : {}),
    };
    out.push(row);
    await opts.onShot?.(row);
  }
  return { perShot: out, takes };
}
