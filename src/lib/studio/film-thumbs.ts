"use client";

import { useEffect, useState } from "react";

/** 抽幀併發閘：同時最多 2 條 offscreen video（Chau 0928 卡死回報——
 *  幾十條 video 同 load 同 seek 個網死咗）。 */
const thumbSlots = { busy: 0, waiters: [] as (() => void)[] };
function takeThumbSlot(): Promise<void> {
  if (thumbSlots.busy < 2) {
    thumbSlots.busy += 1;
    return Promise.resolve();
  }
  return new Promise<void>((res) => thumbSlots.waiters.push(res)).then(() => {
    thumbSlots.busy += 1;
  });
}
function releaseThumbSlot() {
  thumbSlots.busy = Math.max(0, thumbSlots.busy - 1);
  const next = thumbSlots.waiters.shift();
  if (next) next();
}

/** 離屏 video 載入到 loadeddata（帶超時，塞死都放走個 slot）。 */
function loadVideo(v: HTMLVideoElement): Promise<void> {
  return new Promise<void>((res, rej) => {
    if (v.readyState >= 2) res();
    else {
      const done = () => {
        v.removeEventListener("loadeddata", done);
        res();
      };
      v.addEventListener("loadeddata", done);
      window.setTimeout(() => rej(new Error("load timeout")), 8000);
    }
  });
}

/** seek 去指定秒（帶超時）。 */
function seekTo(v: HTMLVideoElement, t: number): Promise<void> {
  return new Promise<void>((res) => {
    let settled = false;
    const fin = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(to);
      v.removeEventListener("seeked", fin);
      res();
    };
    const to = window.setTimeout(fin, 2500);
    v.addEventListener("seeked", fin);
    v.currentTime = t;
  });
}

/** 離屏抽幀：真片生成 filmstrip 縮圖（一鏡一個 video element 順序 seek→
 *  canvas→dataURL，逐張漸進顯示；併發閘+超時保護）。 */
export function useFilmThumbs(src: string | undefined, dur: number, count: number, onBad?: () => void) {
  const [thumbs, setThumbs] = useState<string[]>([]);
  useEffect(() => {
    if (!src || count <= 0) return;
    let stop = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.onerror = () => {
      if (!stop) onBad?.();
    };
    v.src = src;
    void (async () => {
      try {
        await takeThumbSlot();
        await loadVideo(v);
        if (stop) return;
        const W = 96;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = Math.max(Math.round((v.videoHeight || 54) * (W / (v.videoWidth || 171))), 40);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const out: string[] = [];
        for (let i = 0; i < count; i++) {
          if (stop) return;
          const t = ((i + 0.5) / count) * dur;
          await seekTo(v, Math.min(Math.max(t, 0.02), Math.max(dur - 0.05, 0.02)));
          if (stop) return;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.62));
          setThumbs([...out]);
        }
      } catch {
        /* 抽幀中途失敗：留低已抽到嗰啲 */
      } finally {
        releaseThumbSlot();
      }
    })();
    return () => {
      stop = true;
      v.onabort = null;
      v.onerror = null;
      v.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, dur, count]);
  return thumbs;
}

/** 抽指定百分比位嘅幀（灰模對帳牆用：每個 KF 釘位抽一格，格序＝片序）。
 *  回傳 array 同 pcts 對位——未抽到嗰格 index 冇值（長度漸進）。 */
export function useFramesAtPcts(src: string | undefined, dur: number, pcts: number[]): string[] {
  const [frames, setFrames] = useState<string[]>([]);
  const key = pcts.join(",");
  useEffect(() => {
    if (!src || dur <= 0 || pcts.length === 0) return;
    let stop = false;
    const v = document.createElement("video");
    v.muted = true;
    v.preload = "auto";
    v.src = src;
    void (async () => {
      try {
        await takeThumbSlot();
        await loadVideo(v);
        if (stop) return;
        const W = 128;
        const canvas = document.createElement("canvas");
        canvas.width = W;
        canvas.height = Math.max(Math.round((v.videoHeight || 54) * (W / (v.videoWidth || 171))), 48);
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        const out: string[] = [];
        for (let i = 0; i < pcts.length; i++) {
          if (stop) return;
          const t = (pcts[i]! / 100) * dur;
          await seekTo(v, Math.min(Math.max(t, 0.02), Math.max(dur - 0.05, 0.02)));
          if (stop) return;
          ctx.drawImage(v, 0, 0, canvas.width, canvas.height);
          out.push(canvas.toDataURL("image/jpeg", 0.66));
          setFrames([...out]);
        }
      } catch {
        /* 留低已抽到嗰啲 */
      } finally {
        releaseThumbSlot();
      }
    })();
    return () => {
      stop = true;
      v.onabort = null;
      v.onerror = null;
      v.src = "";
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, dur, key]);
  return frames;
}
