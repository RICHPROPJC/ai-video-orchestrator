import sharp from "sharp";

/** Downscale for CC. Matches the C7 SH01-head / SH03-body probe. */
const DW = 216;
const DH = 120;
const GRAD_MAX = 3.5;
const STD_MAX = 8;
const LUMA_LO = 45;
const LUMA_HI = 160;
const MIN_FRAC = 0.012;
const MAX_FRAC = 0.25;
const MIN_ASPECT = 1.15;
const MAX_CHROMA = 22;

export type GreyLeakBlob = {
  frac: number;
  aspect: number;
  chroma: number;
  luma: number;
};

export type GreyLeakMeasure = {
  hit: boolean;
  blobs: GreyLeakBlob[];
  /** Fraction of the whole frame that is flat grey — unbounded by the blob size window. */
  coverage: number;
};

function lumaOf(r: number, g: number, b: number): number {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/** FLAT WORKBENCH mannequin leftover in a photoreal frame — pixel/edge, not vision tokens. */
export async function measureWorkbenchGreyLeak(file: string): Promise<GreyLeakMeasure> {
  const { data, info } = await sharp(file)
    .resize(DW, DH, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const w = info.width;
  const h = info.height;
  const n = w * h;
  const luma = new Float32Array(n);
  const chroma = new Float32Array(n);
  const channels = info.channels;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const r = data[o]!;
    const g = data[o + 1]!;
    const b = data[o + 2]!;
    luma[i] = lumaOf(r, g, b);
    chroma[i] = Math.max(r, g, b) - Math.min(r, g, b);
  }
  const grad = new Float32Array(n);
  const std = new Float32Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const up = luma[(y > 0 ? y - 1 : y) * w + x]!;
      const left = luma[y * w + (x > 0 ? x - 1 : x)]!;
      grad[i] = Math.abs(luma[i]! - up) + Math.abs(luma[i]! - left);
      let acc = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -1; dx <= 1; dx++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const d = luma[yy * w + xx]! - luma[i]!;
          acc += d * d;
        }
      }
      std[i] = Math.sqrt(acc / 9);
    }
  }
  const flat = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const L = luma[i]!;
    flat[i] = grad[i]! < GRAD_MAX && std[i]! < STD_MAX && L > LUMA_LO && L < LUMA_HI ? 1 : 0;
  }
  const seen = new Uint8Array(n);
  const blobs: GreyLeakBlob[] = [];
  const stack: number[] = [];
  let flatSum = 0;
  for (let start = 0; start < n; start++) {
    if (!flat[start] || seen[start]) continue;
    stack.length = 0;
    stack.push(start);
    seen[start] = 1;
    let count = 0;
    let chromaSum = 0;
    let lumaSum = 0;
    let minX = w;
    let maxX = 0;
    let minY = h;
    let maxY = 0;
    while (stack.length) {
      const i = stack.pop()!;
      count += 1;
      flatSum += 1;
      chromaSum += chroma[i]!;
      lumaSum += luma[i]!;
      const x = i % w;
      const y = (i / w) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbors = [i - 1, i + 1, i - w, i + w];
      for (const nb of neighbors) {
        if (nb < 0 || nb >= n || seen[nb] || !flat[nb]) continue;
        const nx = nb % w;
        if (Math.abs(nx - x) + Math.abs(((nb / w) | 0) - y) !== 1) continue;
        seen[nb] = 1;
        stack.push(nb);
      }
    }
    const frac = count / n;
    if (frac < MIN_FRAC || frac > MAX_FRAC) continue;
    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    blobs.push({
      frac,
      aspect: bh / Math.max(bw, 1),
      chroma: chromaSum / count,
      luma: lumaSum / count,
    });
  }
  const hit = blobs.some((b) => b.aspect >= MIN_ASPECT && b.chroma < MAX_CHROMA);
  return { hit, blobs, coverage: flatSum / n };
}

/** Photo gate: 空灰框 threshold — a photoreal still is never mostly flat grey.
 *  The blob window (MIN–MAX_FRAC) targets mannequin-shaped leftovers; a whole
 *  empty/grey frame (frac≈1) slips that window, so photo adds a coverage gate.
 *  T35b: coverage alone no longer fails (plain-studio portraits hit it) — FAIL
 *  needs the eye's grey_blocks verdict AND machine coverage; one alone warns. */
export const EMPTY_GREY_MAX = 0.6;

export type PhotoGreyVerdict = { fail: string | null; warn: string | null };

/** T35b §2: blob silhouette stays a hard fail; the flat-coverage path fails only
 *  when machine coverage AND the eye's grey_blocks agree, warns on either alone. */
export async function judgePhotoGreyLeak(file: string, eyeSaidGrey: boolean): Promise<PhotoGreyVerdict> {
  const m = await measureWorkbenchGreyLeak(file);
  if (m.hit) {
    const blob = machineGreyFailReason(m).replace(/^machine_grey: /, "");
    return { fail: `grey_leak: workbench silhouette ${blob}`, warn: null };
  }
  const cov = `flat grey/empty coverage ${m.coverage.toFixed(2)} vs ${EMPTY_GREY_MAX}`;
  if (m.coverage >= EMPTY_GREY_MAX) {
    if (eyeSaidGrey) {
      return { fail: `grey_leak: ${cov} — eye also reports grey blocks`, warn: null };
    }
    return { fail: null, warn: `grey_watch: ${cov} — machine suspects, eye says clean` };
  }
  if (eyeSaidGrey) {
    return { fail: null, warn: `grey_watch: eye reports grey blocks but ${cov} — machine clean` };
  }
  return { fail: null, warn: null };
}

// ── T35b §3: empty-frame blocking gate — ≥0.8 of the frame near-black/near-white.
export const EMPTY_FRAME_MIN = 0.8;
const LUMA_DARK = 20;
const LUMA_BRIGHT = 235;

export type EmptyFrameMeasure = { hit: boolean; kind: "dark" | "bright" | null; frac: number };

export async function measureEmptyFrame(file: string): Promise<EmptyFrameMeasure> {
  const { data, info } = await sharp(file)
    .resize(DW, DH, { fit: "fill" })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const n = info.width * info.height;
  const channels = info.channels;
  let dark = 0;
  let bright = 0;
  for (let i = 0; i < n; i++) {
    const o = i * channels;
    const L = lumaOf(data[o]!, data[o + 1]!, data[o + 2]!);
    if (L < LUMA_DARK) dark += 1;
    else if (L > LUMA_BRIGHT) bright += 1;
  }
  const darkFrac = dark / n;
  const brightFrac = bright / n;
  if (darkFrac >= EMPTY_FRAME_MIN) return { hit: true, kind: "dark", frac: darkFrac };
  if (brightFrac >= EMPTY_FRAME_MIN) return { hit: true, kind: "bright", frac: brightFrac };
  return { hit: false, kind: null, frac: Math.max(darkFrac, brightFrac) };
}

export function machineGreyFailReason(m: GreyLeakMeasure): string {
  const b = m.blobs.find((x) => x.aspect >= MIN_ASPECT && x.chroma < MAX_CHROMA);
  if (!b) return "machine_grey: workbench silhouette";
  return `machine_grey: workbench silhouette frac=${b.frac.toFixed(3)} aspect=${b.aspect.toFixed(2)}`;
}
