import type { Shot } from "@/lib/studio/types";

/** 畫簿／畫布共用嘅媒體 URL 同約定路徑 helper（單一真源，唔准兩份互咬）。 */
export function studioMedia(jobId: string, rel: string) {
  return `/api/media/${jobId}/${rel}`;
}

export function slug(name: string) {
  return name.trim().replace(/[\s/\\]+/g, "-");
}

/** 收據絕對路徑 → job 相對路徑（media route 食嘅形狀）；越界一律拒。 */
export function jobRel(p: string, jobId: string): string | null {
  const norm = p.replace(/\\/g, "/");
  const marker = `/data/jobs/${jobId}/`;
  const rel = norm.includes(marker) ? norm.split(marker)[1]! : norm;
  if (rel.startsWith("/") || rel.split("/").some((part) => part === "..")) return null;
  return rel || null;
}

/** KF 縮圖候選鏈：positions 推出嘅正式 rel 行先，再兜 `{id}.kf-NN.png`／`{id}.png`
 *  兩種磁碟形狀（舊 sheet 冇 kp 都照有 KF 檔）。 */
export function kfSrcs(jobId: string, shotId: string, primary?: string, idx = 0): string[] {
  return [
    ...(primary ? [studioMedia(jobId, primary)] : []),
    studioMedia(jobId, `stills/${shotId}.kf-${String(idx).padStart(2, "0")}.png`),
    studioMedia(jobId, `stills/${shotId}.png`),
  ].filter((src, at, all) => all.indexOf(src) === at);
}

/** KF 百分比釘位：parse 到就用（0-100 夾窄）；parse 唔到平均分。 */
export function pinPercents(raw: string | undefined | null, count: number): number[] {
  const marks = (raw ?? "").split(/[,，]/).map((s) => s.trim()).filter(Boolean);
  const parsed = marks
    .map((m) => /^(-?\d+(?:\.\d+)?)\s*%$/.exec(m))
    .filter((m): m is RegExpExecArray => Boolean(m))
    .map((m) => Math.min(100, Math.max(0, Number(m[1]))));
  if (marks.length > 0 && parsed.length === marks.length) return parsed;
  return Array.from({ length: Math.max(count, 1) }, (_, i) =>
    count <= 1 ? 0 : Math.round((i * 100) / (count - 1)),
  );
}

/** 道具 plate 候選鏈：pipeline 全 slate 首見序編 NN（01 起），refill 會食後續編號，
 *  所以由 first-seen index 起試 8 個號 ×（原圖＋cut）。 */
export function propSrcs(jobId: string, name: string, index: number): string[] {
  return Array.from({ length: 8 }, (_, k) => index + 1 + k).flatMap((nn) => [
    studioMedia(jobId, `assets/${String(nn).padStart(2, "0")}-${slug(name)}.png`),
    studioMedia(jobId, `assets/${String(nn).padStart(2, "0")}-${slug(name)}.cut.png`),
  ]);
}

/** 道具 first-seen 編號（pipeline 全 slate 掃 sheet 原序——唔係 cut order）。 */
export function makePropIdx(shots: Shot[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const s of shots) {
    for (const p of s.props ?? []) {
      if (!m.has(p.name)) m.set(p.name, m.size);
    }
  }
  return m;
}
