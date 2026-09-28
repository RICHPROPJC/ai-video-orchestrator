"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchH3Plan, keyframeRelPaths, type H3PlanFile } from "@/lib/studio/keyframe-rels";
import { jobRel, kfSrcs, makePropIdx, pinPercents, propSrcs, slug } from "@/lib/studio/canvas-rels";
import { useFilmThumbs } from "@/lib/studio/film-thumbs";
import type { JobRecord, Shot } from "@/lib/studio/types";
import { FeedbackForm } from "@/components/feedback-form";

function media(id: string, rel: string) {
  return `/api/media/${id}/${rel}`;
}

/** shot API 來源（/api/jobs/{jobId}/shot/{shotId}）——淨抽畫簿要用嘅位。
 *  sources.path 係絕對路徑；refImages 係 Comfy upload 名（後備先試）。 */
type ShotInspect = {
  shot: string;
  call: Shot | null;
  files: { still: boolean; blockout: boolean };
  h3: {
    motionForm: string | null;
    keyframePositions: string;
    refImages: string[];
    sources: { role: string; path?: string; sha256: string }[];
  } | null;
};

function useShotInspect(jobId: string, shotId: string) {
  const [state, setState] = useState<{ data: ShotInspect | null; err: string }>({ data: null, err: "" });
  useEffect(() => {
    let stop = false;
    const req = fetch(`/api/jobs/${jobId}/shot/${shotId}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json() as Promise<ShotInspect>;
      })
      .then((body) => {
        if (!stop) setState({ data: body, err: "" });
      })
      .catch((e: unknown) => {
        if (!stop) setState({ data: null, err: e instanceof Error ? e.message : "load failed" });
      });
    return () => {
      stop = true;
      void req.catch(() => undefined);
    };
  }, [jobId, shotId]);
  return state;
}

/** 成條 cut 一次過攞晒每鏡收據（全片軸＋span 卡共用，唔逐格重複 fetch）。 */
function useShotInspects(jobId: string, shotIds: string[]) {
  const [map, setMap] = useState<Record<string, { data: ShotInspect | null; err: string }>>({});
  const key = shotIds.join(",");
  useEffect(() => {
    let stop = false;
    const ids = key ? key.split(",") : [];
    void Promise.all(
      ids.map((id) =>
        fetch(`/api/jobs/${jobId}/shot/${id}`, { cache: "no-store" })
          .then(async (res) => {
            if (!res.ok) throw new Error(`${res.status}`);
            return { id, data: (await res.json()) as ShotInspect, err: "" };
          })
          .catch((e: unknown) => ({ id, data: null, err: e instanceof Error ? e.message : "load failed" })),
      ),
    ).then((rows) => {
      if (!stop) setMap(Object.fromEntries(rows.map((r) => [r.id, { data: r.data, err: r.err }])));
    });
    return () => {
      stop = true;
    };
  }, [jobId, key]);
  return map;
}

/** motion selection（motion/selection.json，R19-R21）——每鏡揀嘅 mocap 段；
 *  segment/candidateEvidence 新欄 optional（舊 job 冇），有先顯示。 */
type MotionSel = {
  shot: string;
  bvh?: string;
  conf?: number;
  decisionSource?: string;
  reason?: string;
  tie_break?: string;
  flags?: string[];
  segment?: { startF?: number; endF?: number; startSec?: number; endSec?: number; method?: string };
  candidateEvidence?: unknown;
};

/** decisionSource 人話翻譯——原文照 passthrough 俾進階用戶睇。 */
const MOTION_SOURCE_NOTE: Record<string, string> = {
  "seat-decision:--motion-pick": "席揀（--motion-pick）",
  "seat-tiebreak:stable-id-order": "平手·按穩定 ID 序",
  "seat-decided:unobserved-tie": "平手·未觀測分勝",
  "human-override": "人手覆核揀",
};

function useMotionSelection(jobId: string): Record<string, MotionSel> {
  const [map, setMap] = useState<Record<string, MotionSel>>({});
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    void fetch(media(jobId, "motion/selection.json"), { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as { shots?: MotionSel[] }) : null))
      .then((d) => {
        if (!stop && d?.shots?.length) setMap(Object.fromEntries(d.shots.map((s) => [s.shot, s])));
      })
      .catch(() => undefined);
    return () => {
      stop = true;
    };
  }, [jobId]);
  return map;
}

/** 收據＋sheet → 呢鏡嘅 positions／KF rels／釘位。 */
function shotPins(inspect: { data: ShotInspect | null } | undefined, shot: Shot) {
  const positions = inspect?.data?.h3?.keyframePositions || inspect?.data?.call?.keyframePositions || shot.keyframePositions || "";
  const rels = keyframeRelPaths({ id: shot.id, keyframePositions: positions });
  const pins = pinPercents(positions, rels.length);
  return { positions, rels, pins };
}

/** 候選 URL 逐個試（冇目錄 listing API，靠約定名 probe）；全部唔見 → 未交圖格。 */
export function ProbeImg({
  srcs,
  alt,
  className,
  missingLabel = "未交圖",
}: {
  srcs: string[];
  alt: string;
  className?: string;
  missingLabel?: string;
}) {
  const [idx, setIdx] = useState(0);
  if (idx >= srcs.length) {
    return (
      <span className={`flex items-center justify-center text-xs text-muted-foreground ${className ?? "h-28"}`}>
        {missingLabel}
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      loading="lazy"
      src={`${srcs[idx]}?preview=1`}
      alt={alt}
      className={className ?? "h-28 w-full object-cover"}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}

/** 大圖：同一候選鏈但 full quality（唔加 preview），扑空顯示未交圖。 */
function BigImg({ srcs, alt }: { srcs: string[]; alt: string }) {
  const [idx, setIdx] = useState(0);
  if (idx >= srcs.length) {
    return <p className="max-w-full text-sm text-muted-foreground">未交圖（呢鏡冇 KF 檔喺碟）</p>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={srcs[idx]}
      alt={alt}
      className="max-h-[55vh] max-w-full object-contain"
      onClick={(e) => e.stopPropagation()}
      onError={() => setIdx((i) => i + 1)}
    />
  );
}

/** 灰模底片 seek 去指定百分比嗰一刻——KF 圖對照用（釘位＝片時間軸）。
 *  preload=metadata 淨攞時長；撳第個釘即刻跳去同一刻。404 換「未有灰片」。 */
function SeekVideo({ src, pct, label }: { src: string; pct: number | null; label?: string }) {
  const vRef = useRef<HTMLVideoElement | null>(null);
  const [dur, setDur] = useState(0);
  const [bad, setBad] = useState(false);
  useEffect(() => {
    const v = vRef.current;
    if (!v || dur <= 0 || pct == null) return;
    try {
      v.pause();
    } catch {
      /* metadata 未到 */
    }
    v.currentTime = (pct / 100) * dur;
  }, [pct, dur]);
  if (bad) {
    return (
      <p className="flex aspect-video items-center justify-center rounded border border-dashed text-xs text-muted-foreground">
        未有灰片
      </p>
    );
  }
  return (
    <div className="space-y-1">
      <video
        ref={vRef}
        controls
        preload="metadata"
        className="w-full rounded border border-border bg-black"
        src={src}
        onLoadedMetadata={(e) => setDur(e.currentTarget.duration || 0)}
        onError={() => setBad(true)}
      />
      {label ? (
        <p className="font-mono text-[9px] text-muted-foreground">
          {label}
          {dur > 0 && pct != null ? ` · ${((pct / 100) * dur).toFixed(1)}s / ${dur.toFixed(1)}s` : ""}
        </p>
      ) : null}
    </div>
  );
}

type View = "skeleton" | "refs" | "h3";

const VIEWS: [View, string][] = [
  ["skeleton", "骨架"],
  ["h3", "剪接·H3對齊"],
  ["refs", "refs庫"],
];

export function Album({ job, initialView = "skeleton" }: { job: JobRecord | null; initialView?: View }) {
  const [view, setView] = useState<View>(initialView);
  const [picked, setPicked] = useState<string | null>(null);
  /** B1（Sol UI-PLAN）：selection 常數化——全量索引每鏈一行（零額外請求），
   *  撳行／撞上線鏡號先 mount 嗰鏈 AxisRow 詳情（播放器跟 selection，唔再
   *  44 鏈全 mount）；selection 寫入 URL ?shot=，reload 可恢復定位。 */
  const [openShot, setOpenShot] = useState<string | null>(() =>
    typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("shot"),
  );
  const selectShot = (id: string | null) => {
    setOpenShot(id);
    const q = new URLSearchParams(window.location.search);
    if (id) q.set("shot", id);
    else q.delete("shot");
    window.history.pushState(null, "", `/?${q.toString()}`);
    if (id) {
      window.requestAnimationFrame(() =>
        document.getElementById(`axis:${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }),
      );
    }
  };
  /** B1：返回掣恢復 selection（popstate 讀返 URL ?shot=）。 */
  useEffect(() => {
    const onPop = () => setOpenShot(new URLSearchParams(window.location.search).get("shot"));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const shots = useMemo<Shot[]>(() => {
    const all = job?.callSheet?.shots ?? [];
    const cut = job?.continuity?.cut;
    if (!cut?.length) return all;
    const byId = new Map(all.map((s) => [s.id, s]));
    const ordered = cut.map((id) => byId.get(id)).filter((s): s is Shot => Boolean(s));
    return ordered.length ? ordered : all;
  }, [job?.callSheet?.shots, job?.continuity?.cut]);

  const shotIds = useMemo(() => shots.map((s) => s.id), [shots]);
  const inspects = useShotInspects(job?.id ?? "", shotIds);
  /** R19-R21：每鏡 motion selection（decisionSource／採納段／平手證據）。 */
  const motionSel = useMotionSelection(job?.id ?? "");
  /** H3 出片 rel（SH01.mp4 等）——三方對照同 span 卡都用。 */
  const motionByShot = useMemo(() => {
    const m = new Map<string, string>();
    for (const rel of job?.outputs.shots ?? []) {
      m.set((rel.split("/").pop() ?? rel).replace(/\.mp4$/, ""), rel);
    }
    return m;
  }, [job?.outputs.shots]);

  /** refs庫三行：角色角度板／道具 assets/NN-*.png／場景 assets/scenes/。 */
  const libChars = useMemo(
    () =>
      (job?.callSheet?.characters ?? []).map((c) => ({
        key: `char:${c.id}`,
        label: `${c.name}（${c.id}）`,
        srcs: [media(job?.id ?? "", `portraits/boards/${c.id}.angles.png`)],
      })),
    [job?.callSheet?.characters, job?.id],
  );
  /** 道具 first-seen 編號（pipeline 全 slate 掃 sheet 原序——唔係 cut order）。 */
  const propIdx = useMemo(() => makePropIdx(job?.callSheet?.shots ?? []), [job?.callSheet?.shots]);
  const libProps = useMemo(
    () =>
      [...propIdx.entries()].map(([name, i]) => ({
        key: `prop:${name}`,
        label: name,
        srcs: propSrcs(job?.id ?? "", name, i),
      })),
    [propIdx, job?.id],
  );
  const libScenes = useMemo(() => {
    const out: { key: string; label: string; srcs: string[] }[] = [];
    const seen = new Set<string>();
    const push = (label: string, base: string) => {
      const srcs = [
        media(job?.id ?? "", `assets/scenes/${base}.cut.png`),
        media(job?.id ?? "", `assets/scenes/${base}.png`),
      ];
      if (seen.has(srcs[0]!)) return;
      seen.add(srcs[0]!);
      out.push({ key: `scene:${base}`, label, srcs });
    };
    for (const b of job?.callSheet?.buildings ?? []) {
      for (const type of b.types) push(`場景：${b.era}·${type}`, `${slug(b.era)}.${slug(type)}`);
    }
    for (const loc of [...new Set((job?.callSheet?.shots ?? []).map((s) => s.location).filter(Boolean))]) {
      push(`場景：${loc}`, `${slug(loc)}.${slug(loc)}`);
    }
    return out;
  }, [job?.callSheet?.buildings, job?.callSheet?.shots, job?.id]);

  if (!job?.id) {
    return <p className="mt-3 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">未有畫簿資料。未開 slate。</p>;
  }

  const show = (v: View) => view === v;
  const pickedShot = shots.find((s) => s.id === picked) ?? null;
  const pickedSrcs = pickedShot ? kfSrcs(job.id, pickedShot.id, keyframeRelPaths(pickedShot)[0]) : [];
  /** filmstrip 格＝首張 KF；對照灰模片 seek 去佢個釘位（KF 參考嘅嗰一刻）。 */
  const pickedPct = pickedShot
    ? (pinPercents(pickedShot.keyframePositions ?? "", keyframeRelPaths(pickedShot).length)[0] ?? 0)
    : 0;

  return (
    <div className="mt-3 w-full min-w-0 space-y-3 rounded-lg border bg-black p-3">
      <div className="flex min-w-0 flex-wrap items-center gap-1 text-[11px]">
        {VIEWS.map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={`rounded border px-2 py-1 ${view === id ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
            onClick={() => setView(id)}
          >
            {label}
          </button>
        ))}
        {/* B0（Sol UI-PLAN）：完整 cut 鏈唔再直出撐爆 390px——摘要頭尾，
            title 留全鏈hover可查；全量順序喺剪接軌段序照見。 */}
        <span
          className="ml-auto min-w-0 truncate text-muted-foreground"
          title={job.continuity?.cut?.length ? job.continuity.cut.join("→") : shots.map((s) => s.id).join("→")}
        >
          cut {shots.length} 鏡 ·{" "}
          {(() => {
            const chain = job.continuity?.cut?.length ? job.continuity.cut : shots.map((s) => s.id);
            const head = chain.slice(0, 2).join("→");
            const tail = chain.slice(-1)[0] ?? "";
            return chain.length <= 3 ? chain.join("→") : `${head}→…(${chain.length - 3}鏡)…→${tail}`;
          })()}
        </span>
      </div>

      {show("skeleton") ? (
        <section aria-label="骨架 filmstrip">
          {shots.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">未有鏡。文字表唔等於分鏡已交付。</p>
          ) : (
            <>
            <p className="mb-1 text-[9px] text-muted-foreground sm:hidden">⇠ 左右碌睇成條 cut ⇢</p>
            <div className="flex gap-2 overflow-x-auto pb-2 [scrollbar-width:thin]">
              {shots.map((shot) => {
                const kf = keyframeRelPaths(shot)[0]!;
                return (
                  <button
                    key={shot.id}
                    type="button"
                    onClick={() => setPicked(shot.id)}
                    className="w-44 shrink-0 overflow-hidden rounded border border-border bg-black text-left hover:border-primary"
                  >
                    <ProbeImg srcs={kfSrcs(job.id, shot.id, kf)} alt={shot.id} className="h-28 w-full object-cover" />
                    <span className="block px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{shot.id}</span>
                    <span className="block max-h-8 overflow-hidden px-1 pb-1 text-[11px] leading-tight">
                      {shot.dialogue ? `${shot.speaker ? `${shot.speaker}：` : ""}${shot.dialogue}` : "（無對白）"}
                    </span>
                  </button>
                );
              })}
            </div>
            </>
          )}
        </section>
      ) : null}

      {show("refs") ? (
        <section aria-label="refs 庫" className="space-y-3">
          {(
            [
              ["角色 · portraits 角度板", libChars],
              ["道具 · assets/NN-*.png", libProps],
              ["場景 · assets/scenes/", libScenes],
            ] as const
          ).map(([title, items]) => (
            <div key={title}>
              <p className="mb-1 text-[11px] tracking-wider text-muted-foreground">
                {title} · {items.length}
              </p>
              {items.length === 0 ? (
                <p className="rounded-lg border border-dashed p-4 text-xs text-muted-foreground">呢類未有條目。</p>
              ) : (
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {items.map((item) => (
                    <div key={item.key} className="w-40 shrink-0 overflow-hidden rounded border border-border bg-black">
                      <ProbeImg srcs={item.srcs} alt={item.label} className="h-28 w-full object-cover" />
                      <span className="block truncate px-1 py-0.5 text-[10px] text-muted-foreground" title={item.label}>
                        {item.label}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </section>
      ) : null}

      {show("h3") ? (
        <section aria-label="H3 對齊軸" className="space-y-2">
          {shots.length === 0 ? (
            <p className="rounded-lg border border-dashed p-6 text-sm text-muted-foreground">未有鏡。</p>
          ) : (
            <>
              <CutScrub
                jobId={job.id}
                shots={shots}
                inspects={inspects}
                characters={job.callSheet?.characters ?? []}
                propIdx={propIdx}
                motionByShot={motionByShot}
                pictureLock={job.outputs.pictureLock}
                onOpenShot={selectShot}
              />
              <p className="text-[10px] text-muted-foreground">
                上軌＝剪接主場；下面全量索引每鏈一行；撳一行／撞上線鏡號 → 嗰鏈 H3 畫布詳情（播放器跟 selection 常數 mount）。
              </p>
              <div className="space-y-1">
                {shots.map((shot) => (
                  <ShotIndexRow
                    key={`${job.id}:${shot.id}`}
                    shot={shot}
                    inspect={inspects[shot.id]}
                    hasMotion={Boolean(motionByShot.get(shot.id))}
                    active={shot.id === openShot}
                    onPick={() => selectShot(shot.id)}
                  />
                ))}
              </div>
              {openShot && shots.some((s) => s.id === openShot) ? (
                <div className="space-y-2">
                  <div className="flex items-center gap-2 text-[11px]">
                    <span className="font-medium text-foreground">{openShot} · H3 畫布詳情</span>
                    <button
                      type="button"
                      className="rounded border border-border px-1.5 py-0.5 text-muted-foreground hover:text-foreground"
                      onClick={() => selectShot(null)}
                    >
                      ✕ 收起
                    </button>
                  </div>
                  {shots
                    .filter((s) => s.id === openShot)
                    .map((shot) => (
                      <AxisRow
                        key={`${job.id}:${shot.id}`}
                        jobId={job.id}
                        shot={shot}
                        motionRel={motionByShot.get(shot.id)}
                        inspect={inspects[shot.id]}
                        motionSel={motionSel[shot.id]}
                      />
                    ))}
                </div>
              ) : null}
            </>
          )}
        </section>
      ) : null}

      {pickedShot ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="畫簿大圖"
          onKeyDown={(e) => {
            if (e.key === "Escape") setPicked(null);
          }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center overflow-y-auto bg-black/90 p-3 md:p-6"
          onClick={() => setPicked(null)}
        >
          <button
            autoFocus
            type="button"
            className="mb-2 rounded border px-4 py-2 text-white"
            onClick={() => setPicked(null)}
          >
            關閉大圖
          </button>
          {/* 大圖 dialog 先 load 原圖（full quality，冇 preview）；右邊灰模片
              seek 去同一個釘位——KF 底圖對返灰模片嗰一刻（Chau 0927）。 */}
          <div onClick={(e) => e.stopPropagation()} className="grid w-full max-w-4xl gap-2 md:grid-cols-2">
            <div className="space-y-1">
              <p className="font-mono text-[10px] text-muted-foreground">{pickedShot.id} 首張 KF · {pickedPct}%</p>
              <BigImg srcs={pickedSrcs} alt={pickedShot.id} />
            </div>
            <SeekVideo
              src={media(job.id, `blockout/${pickedShot.id}.mp4`)}
              pct={pickedPct}
              label="灰模底片（KF 參考嘅嗰一刻）"
            />
          </div>
          <div onClick={(e) => e.stopPropagation()} className="mt-3 w-full max-w-4xl space-y-3">
            <PedigreeCard
              key={`${job.id}:${pickedShot.id}`}
              jobId={job.id}
              shot={pickedShot}
              characters={job.callSheet?.characters ?? []}
              propIdx={propIdx}
            />
            <FeedbackForm jobId={job.id} shotId={pickedShot.id} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** 釘點座標：鏡＋KF 序＋段內百分比＋全片座標百分比。idx=-1＝連續拖嘅位（唔 snap 喺 KF）。 */
type Anchor = { shotId: string; idx: number; pct: number; globalPct: number };

/** Chau 0928：剪接＝H3對齊同一頁——CapCut 軌（cut_plan 段＋真片抽幀縮圖帶
 *  ＋playhead scrub＋viewer）疊埋 KF 釘（撳釘 snap 揀 span）＋連續 range
 *  手柄；兩種揀法都餵同一個 SpanCard（呢段連住嘅參考＋重新 spawn）。 */
type CutPlanShotT = { id: string; start_s: number; end_s: number; duration_s?: number };

function useCutPlan(jobId: string, shots: Shot[]) {
  const [plan, setPlan] = useState<CutPlanShotT[] | null>(null);
  const [tried, setTried] = useState(false);
  useEffect(() => {
    let stop = false;
    void fetch(media(jobId, "cut_plan.json"), { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error("cut_plan 未落盤");
        return (await r.json()) as { shots?: CutPlanShotT[] };
      })
      .then((p) => {
        if (!stop && p.shots?.length) setPlan([...p.shots].sort((x, y) => x.start_s - y.start_s));
      })
      .catch(() => undefined)
      .finally(() => {
        if (!stop) setTried(true);
      });
    return () => {
      stop = true;
    };
  }, [jobId]);
  /** fallback：cut_plan 未落盤就用 sheet durationSec 砌（同一順序）。 */
  const fallback = useMemo(
    () =>
      shots.map((s, k) => ({
        id: s.id,
        start_s: shots.slice(0, k).reduce((m, x) => m + x.durationSec, 0),
        end_s: shots.slice(0, k + 1).reduce((m, x) => m + x.durationSec, 0),
        duration_s: s.durationSec,
      })),
    [shots],
  );
  const segs = plan ?? fallback;
  const total = segs.length ? segs[segs.length - 1]!.end_s : 0;
  return { segs, total, tried: tried || plan != null };
}

function shotAtT(segs: CutPlanShotT[], t: number): CutPlanShotT {
  let hit = segs[0]!;
  for (const s of segs) if (t >= s.start_s) hit = s;
  return hit;
}

function pctAtT(seg: CutPlanShotT, t: number): number {
  const d = Math.max(seg.duration_s ?? seg.end_s - seg.start_s, 1e-6);
  return Math.round(Math.min(100, Math.max(0, ((t - seg.start_s) / d) * 100)));
}

/** 段內縮圖帶（~每 1.2s 一格、上限 24）——灰模線／H3出片線共用。
 *  Chau 0928（圖令）：KF 釘層搬咗去畫布KF線（KfPinSeg），呢條淨係片。 */
function FilmStripSeg({
  jobId,
  seg,
  total,
  rel,
  emptyLabel,
}: {
  jobId: string;
  seg: CutPlanShotT;
  total: number;
  rel?: string;
  emptyLabel: string;
}) {
  const [bad, setBad] = useState(false);
  /** 段滾入 viewport 先開始抽幀（IO 一次過）；格數 CapCut 慣例 ≤10。 */
  const wrapRef = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = wrapRef.current;
    if (!el || inView) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((x) => x.isIntersecting)) {
        setInView(true);
        io.disconnect();
      }
    });
    io.observe(el);
    return () => io.disconnect();
  }, [inView]);
  const dur = Math.max(seg.duration_s ?? seg.end_s - seg.start_s, 0.1);
  const count = Math.min(Math.max(2, Math.ceil(dur / 1.2)), 10);
  const thumbs = useFilmThumbs(inView && rel && !bad ? media(jobId, rel) : undefined, dur, count, () => setBad(true));
  return (
    <div ref={wrapRef} className="relative h-full overflow-hidden border-r border-white/10 last:border-r-0" style={{ width: `${(Math.max(seg.end_s - seg.start_s, 0.1) / Math.max(total, 0.1)) * 100}%` }}>
      {rel && !bad ? (
        thumbs.length ? (
          <div className="pointer-events-none flex h-full w-full">
            {thumbs.map((t, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img key={i} src={t} alt={`${seg.id} ${(((i + 0.5) / thumbs.length) * 100).toFixed(0)}%`} className="h-full min-w-0 flex-1 object-cover" />
            ))}
          </div>
        ) : (
          <span className="flex h-full items-center justify-center text-[10px] text-muted-foreground">抽幀中…</span>
        )
      ) : (
        <span className="flex h-full items-center justify-center text-[10px] text-muted-foreground">{rel ? `${seg.id} 讀唔到` : `${seg.id} ${emptyLabel}`}</span>
      )}
    </div>
  );
}

/** 畫布KF線段：呢鏡全部 KF 縮圖釘喺佢哋嘅百分比位（Chau 0928 圖令：畫布
 *  嗰堆嘢行 CapCut 式時間軌——KF 圖本身就係釘，撳圖＝snap 揀 span 端點）。 */
function KfPinSeg({
  jobId,
  seg,
  total,
  shot,
  inspect,
  markedPins,
  onPickPin,
  onOpenShot,
  wPx,
}: {
  jobId: string;
  seg: CutPlanShotT;
  total: number;
  shot: Shot;
  inspect?: { data: ShotInspect | null; err: string };
  markedPins?: number[];
  onPickPin?: (idx: number, pct: number) => void;
  /** 鏡號掣：撳落去跳去嗰鏡 H3 畫布。 */
  onOpenShot?: () => void;
  /** 呢段而家實際幾闊（px）——唔夠闊出幼釘唔 load 真圖（Chau 0928：
   *  縮圖帶太密＋幾百張圖同 load 卡死個網）。 */
  wPx: number;
}) {
  const dur = Math.max(seg.duration_s ?? seg.end_s - seg.start_s, 0.1);
  const { rels, pins } = shotPins(inspect, shot);
  return (
    <div className="relative h-full overflow-hidden border-r border-white/10 last:border-r-0" style={{ width: `${(Math.max(seg.end_s - seg.start_s, 0.1) / Math.max(total, 0.1)) * 100}%` }}>
      {pins.map((p, i) =>
        wPx >= 260 ? (
          <button
            key={i}
            type="button"
            title={`${seg.id} KF #${i} · ${p}%`}
            aria-label={`${seg.id} KF #${i} 喺 ${p}%`}
            className={`absolute top-0.5 w-7 -translate-x-1/2 overflow-hidden rounded border bg-black text-center ${
              markedPins?.includes(i) ? "z-10 border-primary ring-1 ring-primary" : "border-amber-700/60 hover:border-primary/60"
            }`}
            style={{ left: `${p}%` }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onPickPin?.(i, p);
            }}
          >
            <ProbeImg srcs={kfSrcs(jobId, seg.id, rels[i], i)} alt={`${seg.id} ${p}%`} className="h-11 w-full object-cover" missingLabel="？" />
            <span className="block truncate bg-black/70 font-mono text-[7px] leading-3 text-muted-foreground">{p}%</span>
          </button>
        ) : (
          <button
            key={i}
            type="button"
            title={`${seg.id} KF #${i} · ${p}%${rels[i] ? "" : "（未交）"}`}
            aria-label={`${seg.id} KF #${i} 喺 ${p}%`}
            className={`absolute inset-y-1 z-10 w-1.5 -translate-x-1/2 rounded-sm ${
              markedPins?.includes(i) ? "bg-primary" : rels[i] ? "bg-amber-400/80 hover:bg-amber-300" : "bg-amber-900/60"
            }`}
            style={{ left: `${p}%` }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              onPickPin?.(i, p);
            }}
          />
        ),
      )}
      <button
        type="button"
        title={`${seg.id} H3 畫布（KF 對照／refs／聲帶）`}
        className="absolute left-1 top-1 z-20 rounded bg-black/70 px-1 font-mono text-[10px] text-white underline decoration-dotted underline-offset-2 hover:text-primary"
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          onOpenShot?.();
        }}
      >
        {seg.id}
      </button>
      <span className="absolute right-1 top-1 z-10 rounded bg-black/70 px-1 font-mono text-[10px] text-white">{dur.toFixed(1)}s</span>
    </div>
  );
}

/** 剪接·H3對齊同一頁嘅主軌（Chau 0928：剪接同 H3 對齊唔係兩頁；圖令＝
 *  CapCut 式工作台，底層有乜拉住乜）：cut_plan 段（fallback sheet 秒數）
 *  做三條並排軌——上線畫布KF（KF 圖釘喺百分比位，撳圖 snap 揀 span 端點）、
 *  中線灰模底片抽幀、下線 H3 出片抽幀。CapCut 手感：playhead 釘死中央，
 *  拖軸＝捲（tap＝seek 去嗰刻）；▶ 播放跨鏡接力（motion 完跳下一鏡，
 *  冇片嗰鏡照推進）；zoom 放大條軸睇密釘位。✂️ range 模式＝連續拖雙手柄
 *  劃新 0–100%。兩種揀法都餵同一個 SpanCard（呢段連住嘅參考＋重新 spawn）。 */
function CutScrub({
  jobId,
  shots,
  inspects,
  characters,
  propIdx,
  motionByShot,
  pictureLock,
  onOpenShot,
}: {
  jobId: string;
  shots: Shot[];
  inspects: Record<string, { data: ShotInspect | null; err: string }>;
  characters: { id: string; name: string }[];
  propIdx: Map<string, number>;
  motionByShot: Map<string, string>;
  pictureLock?: string;
  /** 撞上線鏡號 → 彈嗰鏡 H3 畫布（Chau 0928：refs 嘢按出嚟，唔攤主場）。 */
  onOpenShot?: (shotId: string) => void;
}) {
  const { segs, total, tried } = useCutPlan(jobId, shots);
  const [mode, setMode] = useState<"scrub" | "range">("scrub");
  const [playT, setPlayT] = useState(0);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [span, setSpan] = useState<{ a: Anchor; b: Anchor } | null>(null);
  /** CapCut 手感三件：中央 playhead（zoom 令條軌闊過 viewport，內容平移）、
   *  ▶ 播放（viewer 自己行，onTimeUpdate 推返 playT；冇片嗰鏡 interval 推）、
   *  zoom（放大睇密釘）。 */
  const [zoom, setZoom] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [containerW, setContainerW] = useState(0);
  const vRef = useRef<HTMLVideoElement | null>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const dragEdge = useRef<"a" | "b" | null>(null);
  const dragScrub = useRef<{ startX: number; startT: number; moved: boolean } | null>(null);
  const dragRange = useRef<{ a: number } | null>(null);

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const upd = () => setContainerW(el.clientWidth);
    const raf = window.requestAnimationFrame(upd);
    window.addEventListener("resize", upd);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("resize", upd);
    };
  }, []);
  /** 條軸實闊（px）＋而家平移量：playhead 永遠喺 viewport 中央，
   *  內容跟 playT 平移；兩極 clamp 免出空軸。 */
  const trackW = Math.max(containerW * zoom, 1);
  const offset = Math.min(
    Math.max((playT / Math.max(total, 0.001)) * trackW - containerW / 2, 0),
    Math.max(trackW - containerW, 0),
  );

  const tToAnchor = (t: number): Anchor => {
    const tt = Math.min(Math.max(t, 0), total);
    const seg = shotAtT(segs, tt);
    return { shotId: seg.id, idx: -1, pct: pctAtT(seg, tt), globalPct: (tt / total) * 100 };
  };
  const onPickPin = (shotId: string, idx: number, pct: number) => {
    const seg = segs.find((x) => x.id === shotId);
    const t = seg ? seg.start_s + (pct / 100) * (seg.duration_s ?? seg.end_s - seg.start_s) : 0;
    const next = { shotId, idx, pct, globalPct: (t / total) * 100 };
    if (!anchor) {
      setSpan(null);
      setAnchor(next);
      return;
    }
    const [a, b] = next.globalPct >= anchor.globalPct ? [anchor, next] : [next, anchor];
    setSpan({ a, b });
    setAnchor(null);
  };
  /** viewport x → 軸內秒數（計埋平移 offset；range 手柄同 tap seek 都用）。 */
  const xToSec = (clientX: number): number => {
    const el = trackRef.current;
    if (!el || total <= 0) return 0;
    const rect = el.getBoundingClientRect();
    const x = clientX - rect.left + offset;
    const ratio = Math.min(1, Math.max(0, x / Math.max(trackW, 1)));
    return ratio * total;
  };
  const onTrackPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (total <= 0) return;
    setPlaying(false);
    const x = xToSec(e.clientX);
    const handle = (e.target as HTMLElement).closest<HTMLElement>("[data-handle]");
    if (handle) {
      dragEdge.current = handle.dataset.handle === "a" ? "a" : "b";
      return;
    }
    if (mode === "scrub") {
      dragScrub.current = { startX: e.clientX, startT: playT, moved: false };
    } else {
      dragRange.current = { a: x };
      setSpan({ a: tToAnchor(x), b: tToAnchor(x) });
    }
    const el = e.currentTarget;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* pointer already gone */
    }
  };
  const onTrackPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (total <= 0) return;
    const x = xToSec(e.clientX);
    if (dragScrub.current) {
      /** CapCut 手勢：拖軸＝內容跟手指（手指向右、時間倒退）；
       *  4px 內唔算（留俾 tap seek）。 */
      const dx = e.clientX - dragScrub.current.startX;
      if (!dragScrub.current.moved && Math.abs(dx) < 4) return;
      dragScrub.current.moved = true;
      setPlayT(Math.min(total, Math.max(0, dragScrub.current.startT - (dx / Math.max(trackW, 1)) * total)));
      return;
    }
    if (dragRange.current) {
      const t0 = Math.min(dragRange.current.a, x);
      const t1 = Math.max(dragRange.current.a, x);
      setSpan({ a: tToAnchor(t0), b: tToAnchor(t1) });
      return;
    }
    if (dragEdge.current && span) {
      const next = tToAnchor(x);
      setSpan(dragEdge.current === "a" ? { a: next, b: span.b } : { a: span.a, b: next });
    }
  };
  const endTrackDrag = (e: React.PointerEvent<HTMLDivElement>) => {
    /** 冇郁過＝tap：seek 去撳嗰刻（CapCut tap 定位）。 */
    if (dragScrub.current && !dragScrub.current.moved) setPlayT(xToSec(e.clientX));
    dragScrub.current = null;
    dragRange.current = null;
    dragEdge.current = null;
    const el = e.currentTarget;
    try {
      if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId);
    } catch {
      /* already released */
    }
  };
  /** playhead → viewer seek：成片直接用 playT；motion fallback 轉該鏡本地時間。
   *  播放緊就唔掣肘（video 自己行，onTimeUpdate 推返 playT，免打架）。 */
  useEffect(() => {
    const v = vRef.current;
    if (!v || total <= 0 || playing) return;
    const seg = shotAtT(segs, playT);
    const local = pictureLock ? playT : playT - seg.start_s;
    if (Number.isFinite(local) && local >= 0) {
      try {
        v.pause();
      } catch {
        /* not loaded yet */
      }
      v.currentTime = local;
    }
  }, [playT, segs, total, pictureLock, playing]);

  const playSeg = shotAtT(segs, Math.min(playT, total));
  const viewerRel = pictureLock ?? motionByShot.get(playSeg.id);
  /** 播放跨鏡接力：viewer 自己行，timeupdate 推返 playT；鏡尾就跳下一鏡
   *  （viewerRel 換 src → play effect 續播）；最尾鏡完先停。 */
  const onViewerTime = (t: number, ended: boolean) => {
    if (!playing) return;
    if (pictureLock) {
      if (ended || t >= total - 0.05) {
        setPlaying(false);
        setPlayT(total);
      } else setPlayT(t);
      return;
    }
    const seg = segs.find((s) => s.id === playSeg.id) ?? segs[0]!;
    const next = seg.start_s + t;
    if (ended || next >= seg.end_s - 0.08) {
      const ni = segs.findIndex((s) => s.id === seg.id) + 1;
      if (ni >= segs.length) {
        setPlaying(false);
        setPlayT(total);
        return;
      }
      setPlayT(segs[ni]!.start_s);
      return;
    }
    setPlayT(next);
  };
  /** 秒尺刻度（zoom 1× 疏、放大咗密少少）。 */
  const step = total > 60 ? 10 : total > 20 ? 5 : total > 8 ? 2 : 1;
  const ticks = Array.from({ length: Math.floor(total / step) + 1 }, (_, i) => i * step);
  /** ▶／⏸：viewer 換 src（跨鏡接力）之後照 playing 狀態續播。 */
  useEffect(() => {
    const v = vRef.current;
    if (!v) return;
    if (playing) void v.play().catch(() => setPlaying(false));
    else v.pause();
  }, [playing, viewerRel]);
  /** 冇片可播嘅鏡（viewer 係 placeholder）照推進 playhead——播放唔斷。 */
  useEffect(() => {
    if (!playing || viewerRel) return;
    const id = window.setInterval(() => {
      setPlayT((t) => {
        if (t >= total - 0.05) {
          setPlaying(false);
          return total;
        }
        return t + 0.25;
      });
    }, 250);
    return () => window.clearInterval(id);
  }, [playing, viewerRel, total]);
  return (
    <div className="space-y-2 rounded-lg border border-border/80 p-2">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">剪接·H3對齊</span>
        <span>
          全長 {total.toFixed(1)}s · {segs.length} 鏡{tried ? "" : " · cut_plan 讀緊（而家用 sheet 秒數）"}
        </span>
        <span className="ml-auto flex gap-1">
          {(
            [
              ["scrub", "🔍 睇片（拖動 scrub）"],
              ["range", "✂️ 揀 range（新0–100%）"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`rounded border px-2 py-1 ${mode === id ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
              onClick={() => {
                setPlaying(false);
                setMode(id);
              }}
            >
              {label}
            </button>
          ))}
        </span>
        {anchor ? <span className="rounded bg-primary/20 px-1.5 py-0.5 text-primary">起點 {anchor.shotId} {anchor.pct}%——撳多個 KF 釘做終點</span> : null}
        {span ? (
          <button
            type="button"
            className="rounded border border-border px-1.5 py-0.5"
            onClick={() => {
              setSpan(null);
              setAnchor(null);
            }}
          >
            ✕ 取消範圍
          </button>
        ) : null}
      </div>
      {/* 大 viewer 跟 playhead：出片＋灰模同刻對照（Chau 0928 圖令）。 */}
      <div className="space-y-1">
        <div className="grid gap-2 md:grid-cols-2">
          {viewerRel ? (
            <video
              ref={vRef}
              controls
              preload="metadata"
              className="max-h-[42vh] w-full rounded-lg border bg-black"
              src={media(jobId, viewerRel)}
              onTimeUpdate={(e) => onViewerTime(e.currentTarget.currentTime, false)}
              onEnded={() => onViewerTime(1e9, true)}
            />
          ) : (
            <p className="flex aspect-video items-center justify-center rounded-lg border border-dashed text-xs text-muted-foreground">未有片可睇（motion／pictureLock 都未交）</p>
          )}
          <SeekVideo
            src={media(jobId, `blockout/${playSeg.id}.mp4`)}
            pct={pctAtT(playSeg, playT)}
            label={`${playSeg.id} 灰模底片（playhead 同刻）`}
          />
        </div>
        <p className="font-mono text-[11px] text-muted-foreground">
          t {playT.toFixed(1)}s / {total.toFixed(1)}s · {playSeg.id} {pctAtT(playSeg, playT)}%{pictureLock ? " · 成片" : " · 該鏡 motion"}
        </p>
      </div>
      {/* CapCut 控制列：▶ 播放跨鏡接力＋zoom 放大條軌。 */}
      <div className="flex flex-wrap items-center gap-1 text-[10px]">
        <button
          type="button"
          className="rounded border border-primary px-2 py-0.5 font-medium text-primary"
          onClick={() => {
            if (playing) {
              setPlaying(false);
              return;
            }
            if (playT >= total - 0.05) setPlayT(0);
            setPlaying(true);
          }}
        >
          {playing ? "⏸ 停" : "▶ 播"}
        </button>
        <span className="text-muted-foreground">zoom</span>
        {[1, 2, 4, 8].map((z) => (
          <button
            key={z}
            type="button"
            className={`rounded border px-1.5 py-0.5 ${zoom === z ? "border-primary text-primary" : "border-border text-muted-foreground"}`}
            onClick={() => setZoom(z)}
          >
            {z}×
          </button>
        ))}
        <span className="ml-1 text-[9px] text-muted-foreground">三軌同刻：上 畫布KF（撳圖 snap 揀段）· 中 灰模底片 · 下 H3 出片——playhead 釘中央，拖軸捲</span>
      </div>
      {/* Chau 0928（圖令）：CapCut 式上下三軌——畫布KF線／灰模線／H3出片線，
          段寬全部＝cut_plan 佔比，同一條 playhead 一齊掃；撳軸A 嘅 KF 圖＝snap 揀 span 端點。 */}
      <div
        ref={trackRef}
        className="relative w-full touch-none select-none overflow-hidden rounded-lg border bg-black"
        onPointerDown={onTrackPointerDown}
        onPointerMove={onTrackPointerMove}
        onPointerUp={endTrackDrag}
        onPointerCancel={endTrackDrag}
      >
        {/* 內容闊＝trackW（zoom 放大）、translateX 令 playhead 嗰刻落 viewport 中央。 */}
        <div className="relative" style={{ width: containerW ? trackW : undefined, transform: `translateX(${-offset}px)` }}>
        <div className="relative h-3.5">
          {ticks.map((t) => (
            <span
              key={t}
              className="absolute bottom-0 top-0 border-l border-white/15 pl-0.5 font-mono text-[8px] leading-3 text-muted-foreground"
              style={{ left: `${(t / Math.max(total, 0.001)) * 100}%` }}
            >
              {t}s
            </span>
          ))}
        </div>
        <div className="space-y-0.5 p-0.5">
          <div className="flex h-14 w-full">
            {segs.map((seg) => {
              const shot = shots.find((x) => x.id === seg.id);
              if (!shot) return null;
              const marked = span
                ? ([span.a, span.b].filter((x) => x.shotId === seg.id && x.idx >= 0).map((x) => x.idx))
                : [];
              return (
                <KfPinSeg
                  key={seg.id}
                  jobId={jobId}
                  seg={seg}
                  total={total}
                  shot={shot}
                  inspect={inspects[seg.id]}
                  markedPins={marked}
                  onPickPin={(idx, pct) => onPickPin(seg.id, idx, pct)}
                  onOpenShot={() => onOpenShot?.(seg.id)}
                  wPx={(Math.max(seg.end_s - seg.start_s, 0.1) / Math.max(total, 0.001)) * trackW}
                />
              );
            })}
          </div>
          <div className="flex h-12 w-full">
            {segs.map((seg) => (
              <FilmStripSeg
                key={seg.id}
                jobId={jobId}
                seg={seg}
                total={total}
                rel={inspects[seg.id]?.data?.files?.blockout ? `blockout/${seg.id}.mp4` : undefined}
                emptyLabel="未交灰模"
              />
            ))}
          </div>
          <div className="flex h-14 w-full">
            {segs.map((seg) => (
              <FilmStripSeg
                key={seg.id}
                jobId={jobId}
                seg={seg}
                total={total}
                rel={motionByShot.get(seg.id)}
                emptyLabel="未交 motion"
              />
            ))}
          </div>
        </div>
        {span ? (
          <div className="pointer-events-none absolute inset-0">
            <div
              className="absolute inset-y-0 border-x-2 border-primary bg-primary/20"
              style={{ left: `${span.a.globalPct}%`, width: `${Math.max(span.b.globalPct - span.a.globalPct, 0.4)}%` }}
            />
            {(["a", "b"] as const).map((edge) => (
              <div
                key={edge}
                data-handle={edge}
                className="pointer-events-auto absolute inset-y-0 z-20 w-3 -translate-x-1/2 cursor-ew-resize touch-none rounded-sm bg-primary/90"
                style={{ left: `${span[edge].globalPct}%` }}
              >
                <span className="absolute left-1/2 top-1/2 h-5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white/80" />
              </div>
            ))}
          </div>
        ) : null}
        </div>
        {/* playhead 釘死 viewport 中央（CapCut 手感）。 */}
        <div className="pointer-events-none absolute inset-y-0 left-1/2 z-30 w-0.5 -translate-x-1/2 bg-primary">
          <span className="absolute left-1/2 top-0 h-2 w-2 -translate-x-1/2 rounded-full bg-primary" />
        </div>
      </div>
      {span ? (
        <SpanCard jobId={jobId} span={span} shots={shots} inspects={inspects} characters={characters} propIdx={propIdx} motionByShot={motionByShot} />
      ) : (
        <p className="text-[10px] text-muted-foreground">
          拖任何一條軌睇片（三軌同刻對齊）；撳兩張 KF 圖（上線金框格）或者用 ✂️ range 拖一段——就劃出新 0–100%，下面彈出呢段連住嘅參考同重新 spawn 表。
        </p>
      )}
    </div>
  );
}

/** 範圍處理卡：新 0–100% 呢段自己連住嘅嘢全部擺齊——覆蓋鏡頭＋映射、
 *  span 軸上嘅 KF（唔抽樣）、每鏡底片 seek 入點、H3 出片、人物／物品
 *  參考、聲帶，最底係重新 spawn 嘅回報表。 */
function SpanCard({
  jobId,
  span,
  shots,
  inspects,
  characters,
  propIdx,
  motionByShot,
}: {
  jobId: string;
  span: { a: Anchor; b: Anchor };
  shots: Shot[];
  inspects: Record<string, { data: ShotInspect | null; err: string }>;
  characters: { id: string; name: string }[];
  propIdx: Map<string, number>;
  motionByShot: Map<string, string>;
}) {
  const i0 = Math.max(shots.findIndex((s) => s.id === span.a.shotId), 0);
  const i1 = shots.findIndex((s) => s.id === span.b.shotId);
  const parts = shots.slice(i0, i1 + 1).map((shot, k) => {
    const from = k === 0 ? span.a.pct : 0;
    const to = k === i1 - i0 ? span.b.pct : 100;
    const sec = ((to - from) / 100) * shot.durationSec;
    return { shot, from, to, sec };
  });
  const totalSec = parts.reduce((m, p) => m + p.sec, 0) || 0.001;
  const mapped = parts.map((p, k) => {
    const before = parts.slice(0, k).reduce((m, x) => m + x.sec, 0);
    return {
      ...p,
      spanFrom: (before / totalSec) * 100,
      spanTo: ((before + p.sec) / totalSec) * 100,
    };
  });
  /** span 內全部 KF，映射做新 0–100% 座標。 */
  const kfs = mapped.flatMap(({ shot, from, to, spanFrom, spanTo }) => {
    const { rels, pins } = shotPins(inspects[shot.id], shot);
    return pins
      .map((p, i) => ({
        shot,
        i,
        p,
        rel: rels[i],
        at: spanFrom + ((p - from) / Math.max(to - from, 0.001)) * (spanTo - spanFrom),
      }))
      .filter((row) => row.rel && row.p >= from - 0.001 && row.p <= to + 0.001);
  });
  const charRefs = [...new Set(parts.flatMap((p) => (p.shot.marks ?? []).map((m) => m.characterId)))].map((id) => ({
    id,
    name: characters.find((c) => c.id === id)?.name ?? id,
    srcs: [media(jobId, `portraits/boards/${id}.angles.png`)],
  }));
  const propRefs = [...new Set(parts.flatMap((p) => (p.shot.props ?? []).map((x) => x.name)))].map((name) => ({
    name,
    srcs: propSrcs(jobId, name, propIdx.get(name) ?? 0),
  }));
  const preset = `【重整】${span.a.shotId}@${span.a.pct}% → ${span.b.shotId}@${span.b.pct}% 做新 0–100%（約 ${totalSec.toFixed(1)}s；${mapped
    .map((p) => `${p.shot.id} ${p.from}–${p.to}%`)
    .join(" ＋ ")}）重新 spawn：`;
  return (
    <div className="space-y-3 rounded-lg border border-primary/40 bg-primary/5 p-3">
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-medium text-foreground">範圍處理 · 新 0–100%</span>
        <span className="font-mono text-muted-foreground">
          {span.a.shotId}@{span.a.pct}% → {span.b.shotId}@{span.b.pct}% · 約 {totalSec.toFixed(1)}s
        </span>
      </div>
      <div className="flex flex-wrap gap-2 text-[10px]">
        {mapped.map((p) => (
          <span key={p.shot.id} className="rounded border border-border px-1.5 py-0.5 font-mono text-muted-foreground">
            {p.shot.id} {p.from}%→{p.to}% ＝ span {p.spanFrom.toFixed(0)}–{p.spanTo.toFixed(0)}%（{p.sec.toFixed(1)}s）
          </span>
        ))}
      </div>
      {/* span 軸＋呢段連住嘅 KF（全量唔抽樣）。 */}
      <div className="px-5">
        <div className="relative h-1 rounded bg-muted/40" />
        <div className="relative h-[86px]">
          {kfs.map((row) => (
            <div
              key={`${row.shot.id}:${row.i}`}
              className="absolute top-0 w-10 -translate-x-1/2 overflow-hidden rounded border border-border bg-black text-center"
              style={{ left: `${row.at}%` }}
              title={`${row.shot.id} KF #${row.i} · 原位 ${row.p}%`}
            >
              <ProbeImg
                srcs={kfSrcs(jobId, row.shot.id, row.rel, row.i)}
                alt={`${row.shot.id} ${row.p}%`}
                className="h-12 w-full object-cover"
                missingLabel="未交"
              />
              <span className="block truncate bg-black/70 px-0.5 font-mono text-[7px] leading-3 text-muted-foreground">{row.p}%</span>
            </div>
          ))}
        </div>
      </div>
      {/* 每個覆蓋鏡嘅底片，seek 去佢喺 span 入點嗰刻。 */}
      <div className="grid gap-2 md:grid-cols-2">
        {mapped.map((p) => (
          <SeekVideo
            key={`${p.shot.id}:blk`}
            src={media(jobId, `blockout/${p.shot.id}.mp4`)}
            pct={p.from}
            label={`${p.shot.id} 灰模底片（span 入點 ${p.from}% 嗰刻）`}
          />
        ))}
      </div>
      {mapped
        .filter((p) => motionByShot.get(p.shot.id))
        .map((p) => (
          <SeekVideo
            key={`${p.shot.id}:mot`}
            src={media(jobId, motionByShot.get(p.shot.id)!)}
            pct={p.from}
            label={`${p.shot.id} H3 出片（span 入口嗰刻）`}
          />
        ))}
      {charRefs.length ? (
        <div>
          <p className="mb-1 text-[10px] tracking-wider text-muted-foreground">人物參考（呢段掂到嘅） · {charRefs.length}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {charRefs.map((c) => (
              <div key={c.id} className="w-28 shrink-0 overflow-hidden rounded border border-border">
                <ProbeImg srcs={c.srcs} alt={c.name} className="h-16 w-full object-cover" missingLabel="角度板未交" />
                <span className="block truncate px-1 py-0.5 text-[9px] text-muted-foreground">{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {propRefs.length ? (
        <div>
          <p className="mb-1 text-[10px] tracking-wider text-muted-foreground">物品參考（呢段掂到嘅） · {propRefs.length}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {propRefs.map((p) => (
              <div key={p.name} className="w-28 shrink-0 overflow-hidden rounded border border-border">
                <ProbeImg srcs={p.srcs} alt={p.name} className="h-16 w-full object-cover" missingLabel="道具 plate 未交" />
                <span className="block truncate px-1 py-0.5 text-[9px] text-muted-foreground">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        {mapped.map((p) => (
          <AudioCell key={`${p.shot.id}:aud`} jobId={jobId} shotId={p.shot.id} />
        ))}
      </div>
      <div className="rounded border border-amber-700/50 bg-amber-950/20 p-2">
        <p className="mb-1 text-[11px] text-amber-300">呢段做新 0–100% 重新 spawn——補你想點改：</p>
        <FeedbackForm jobId={jobId} shotId={span.a.shotId} preset={preset} />
      </div>
    </div>
  );
}


/** h3_plan 收據三槽（audio/photo/video）——呢鏡 H3 實際掂過嘅 refs，
 *  由舊 H3 tab 搬入畫簿（Chau 0928 重組：一樣嘢一個主場）。 */
function H3PlanSlots({ jobId, shotId }: { jobId: string; shotId: string }) {
  const [plan, setPlan] = useState<H3PlanFile | null>(null);
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    let stop = false;
    void fetchH3Plan(jobId, shotId).then((p) => {
      if (!stop) {
        setPlan(p);
        setLoaded(true);
      }
    });
    return () => {
      stop = true;
    };
  }, [jobId, shotId]);
  const slots = plan?.slots;
  const count = slots
    ? (slots.audio?.length ?? 0) + (slots.photo?.length ?? 0) + (slots.video?.length ?? 0)
    : 0;
  return (
    <details className="rounded border border-border/70 px-2 py-1 text-[10px] text-muted-foreground">
      <summary className="cursor-pointer">
        h3_plan refs 三槽{loaded ? ` · ${count} 個 ref` : " · 讀緊"}
      </summary>
      {loaded && !slots ? (
        <p className="mt-1">refs 收據未落盤（motion/{shotId}.h3_plan.json 讀唔到）。</p>
      ) : (
        <div className="mt-1 grid grid-cols-3 gap-2">
          {(["audio", "photo", "video"] as const).map((kind) => (
            <div key={kind} className="space-y-1 rounded border border-border/60 p-1.5">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                {kind} · {slots?.[kind]?.length ?? 0}
              </p>
              {(slots?.[kind] ?? []).length === 0 ? (
                <p className="text-[11px] text-muted-foreground">空槽</p>
              ) : (
                (slots?.[kind] ?? []).map((slot, i) => (
                  <div key={`${kind}-${i}`} className="space-y-1">
                    {kind === "photo" && slot.file ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        loading="lazy"
                        src={`${media(jobId, slot.file)}?preview=1`}
                        alt={slot.bind ?? `${kind} ${i}`}
                        className="aspect-video w-full rounded border border-border object-cover"
                      />
                    ) : null}
                    {kind === "video" && slot.file ? (
                      <video
                        className="w-full rounded border border-border bg-black"
                        controls
                        muted
                        preload="metadata"
                        src={media(jobId, slot.file)}
                      />
                    ) : null}
                    {kind === "audio" && slot.file ? (
                      <audio className="w-full" controls preload="none" src={media(jobId, slot.file)} />
                    ) : null}
                    <p className="font-mono text-[10px] leading-tight text-muted-foreground">
                      {slot.bind ?? "—"}
                      <br />
                      {slot.file ?? "—"}
                    </p>
                  </div>
                ))
              )}
            </div>
          ))}
        </div>
      )}
    </details>
  );
}

/** B1（Sol UI-PLAN）：全量索引行——每鏈一行緊湊摘要（sheet＋inspects 靜態
 *  數據，零額外請求）；撳行 mount 嗰鏈 AxisRow 詳情。 */
function ShotIndexRow({
  shot,
  inspect,
  hasMotion,
  active,
  onPick,
}: {
  shot: Shot;
  inspect?: { data: ShotInspect | null; err: string };
  hasMotion: boolean;
  active: boolean;
  onPick: () => void;
}) {
  const data = inspect?.data ?? null;
  const pins = shotPins(inspect, shot).pins.length;
  return (
    <button
      type="button"
      onClick={onPick}
      className={`flex w-full flex-wrap items-center gap-2 rounded border px-2 py-1 text-left text-[11px] ${
        active ? "border-primary bg-primary/10" : "border-border hover:border-primary/60"
      }`}
    >
      <span className="w-12 shrink-0 font-mono text-foreground">{shot.id}</span>
      <span className="text-muted-foreground">{shot.durationSec.toFixed(1)}s</span>
      <span className="text-muted-foreground">{pins}釘</span>
      {hasMotion ? <span className="text-emerald-500">motion✓</span> : <span className="text-muted-foreground">motion✗</span>}
      {data ? (
        data.files.blockout ? <span className="text-emerald-500">灰✓</span> : <span className="text-destructive">灰✗</span>
      ) : (
        <span className="text-muted-foreground">灰?</span>
      )}
      {data?.h3 ? <span className="text-emerald-500">h3✓</span> : data ? <span className="text-amber-400">未H3</span> : <span className="text-muted-foreground">h3?</span>}
      <span className="ml-auto min-w-0 max-w-[45%] truncate text-muted-foreground">
        {shot.dialogue ? `${shot.speaker ? `${shot.speaker}：` : ""}${shot.dialogue}` : "（無對白）"}
      </span>
    </button>
  );
}

/** 逐鏡對照行：全部 KF 釘一張縮圖都釘晒喺佢嘅百分比位（Chau 0928：
 *  釘數＝灰模片秒數、可以到 100，全部擺齊唔抽樣；唔死機靠 preview 細圖
 *  ＋loading=lazy＋DOM 等闊釘，唔靠少擺）。撳任何一張 → KF 圖 ↔ 灰模片
 *  ↔ H3 出片 seek 同一刻對照；可以由呢一刻報「做新 0%」重整。 */
function AxisRow({
  jobId,
  shot,
  motionRel,
  inspect,
  highlight,
  motionSel,
}: {
  jobId: string;
  shot: Shot;
  motionRel?: string;
  inspect?: { data: ShotInspect | null; err: string };
  /** 撞過上線鏡號＝highlight 呢鏈（Chau 0928：畫布全景攤晒，撞號跳去）。 */
  highlight?: boolean;
  /** R19-R21 motion selection：decisionSource／採納段／平手證據（optional）。 */
  motionSel?: MotionSel;
}) {
  const data = inspect?.data ?? null;
  const err = inspect?.err ?? "";
  const positions = data?.h3?.keyframePositions || data?.call?.keyframePositions || shot.keyframePositions || "";
  const rels = useMemo(() => keyframeRelPaths({ id: shot.id, keyframePositions: positions }), [shot.id, positions]);
  const pins = useMemo(() => pinPercents(positions, rels.length), [positions, rels.length]);
  const [sel, setSel] = useState(0);
  /** 「由呢一刻做新 0%」重整請求——經 FEEDBACK.jsonl 合規渠道報去負責席位。 */
  const [redo, setRedo] = useState<{ idx: number; pct: number } | null>(null);
  const selIdx = Math.min(sel, pins.length - 1);
  const selPct = pins[selIdx] ?? 0;
  return (
    <div id={`axis:${shot.id}`} className={`space-y-2 rounded border p-2 ${highlight ? "border-primary/70 ring-1 ring-primary/60" : "border-border"}`}>
      <div className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono">{shot.id}</span>
        <span className="text-muted-foreground">
          {pins.length} 釘{positions ? "" : "（平均分推算）"}
        </span>
        {err ? <span className="text-destructive">收據載入失敗（{err}）</span> : null}
        {!err && data && !data.h3 ? <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">未做H3</span> : null}
      </div>
      {/* 全量釘帶：每張 KF 縮圖直接釘喺佢嘅百分比位。相鄰釘近就自然叠，
          揀中嗰張 ring 高亮。px-6＝w-12 半闊，0%/100% 唔出界。 */}
      <div className="px-6">
        <div className="relative h-[104px]">
          {pins.map((p, i) => (
            <button
              key={`${shot.id}:${i}`}
              type="button"
              title={`KF #${i} · ${p}%`}
              aria-label={`${shot.id} KF #${i} 喺 ${p}%`}
              className={`absolute top-0 w-12 -translate-x-1/2 overflow-hidden rounded border bg-black text-center ${i === selIdx ? "z-20 border-primary ring-1 ring-primary" : "border-border hover:border-primary/60"}`}
              style={{ left: `${p}%` }}
              onClick={() => setSel(i)}
            >
              <ProbeImg
                srcs={kfSrcs(jobId, shot.id, rels[i], i)}
                alt={`${shot.id} ${p}%`}
                className="h-14 w-full object-cover"
                missingLabel="未交"
              />
              <span className="block truncate bg-black/70 px-0.5 font-mono text-[8px] leading-4 text-muted-foreground">
                #{i} {p}%
              </span>
            </button>
          ))}
        </div>
        <div className="h-px bg-border" />
        <div className="mt-0.5 flex justify-between text-[9px] text-muted-foreground">
          {[0, 25, 50, 75, 100].map((t) => (
            <span key={t}>{t}%</span>
          ))}
        </div>
      </div>
      {/* 對照格：KF 圖 ↔ 灰模片 ↔ H3 出片，三邊 seek 同一刻（釘位＝片時間軸）。 */}
      <div className={`grid gap-2 ${motionRel ? "md:grid-cols-3" : "md:grid-cols-2"}`}>
        <div className="space-y-1">
          <p className="font-mono text-[10px] text-muted-foreground">KF #{selIdx} · {selPct}%</p>
          <ProbeImg
            srcs={kfSrcs(jobId, shot.id, rels[selIdx], selIdx)}
            alt={`${shot.id} kf ${selIdx}`}
            className="aspect-video w-full rounded border border-border object-cover"
            missingLabel="呢個位未交 KF"
          />
          <button
            type="button"
            title="條片連住晒之後，呢一刻可以 cut 返開做下一段嘅 0% 再 edit"
            className="w-full rounded border border-amber-700/60 bg-amber-950/30 px-2 py-1 text-[10px] text-amber-300 hover:bg-amber-950/60"
            onClick={() => setRedo({ idx: selIdx, pct: selPct })}
          >
            ⇪ 呢一刻做新 0%——重整呢段
          </button>
        </div>
        {data && !data.files.blockout ? (
          <div className="space-y-1">
            <p className="font-mono text-[10px] text-muted-foreground">未有灰片 blockout/{shot.id}.mp4</p>
            <p className="flex aspect-video items-center justify-center rounded border border-dashed text-xs text-muted-foreground">
              灰模底片未交——KF 對照唔到
            </p>
          </div>
        ) : (
          <SeekVideo src={media(jobId, `blockout/${shot.id}.mp4`)} pct={selPct} label="灰模底片（同一刻）" />
        )}
        {motionRel ? (
          <SeekVideo src={media(jobId, motionRel)} pct={selPct} label="H3 出片（同一刻）" />
        ) : null}
      </div>
      {/* R19-R21：motion 揀段——decisionSource 人話＋採納段＋理由＋平手證據（optional 欄有先出）。 */}
      <div className="rounded border border-border/70 px-2 py-1 text-[10px] text-muted-foreground">
        {motionSel ? (
          <>
            <p>
              motion 揀段：{MOTION_SOURCE_NOTE[motionSel.decisionSource ?? ""] ?? motionSel.decisionSource ?? "—"}
              {motionSel.bvh ? ` · ${motionSel.bvh}` : ""}
              {motionSel.segment
                ? ` · 採納段 ${motionSel.segment.startSec ?? "?"}–${motionSel.segment.endSec ?? "?"}s（${motionSel.segment.method ?? "?"}）`
                : ""}
              {typeof motionSel.conf === "number" ? ` · conf ${motionSel.conf.toFixed(2)}` : ""}
            </p>
            {motionSel.reason ? <p className="mt-0.5">理由：{motionSel.reason}</p> : null}
            {motionSel.tie_break ? <p>平手處理：{motionSel.tie_break}</p> : null}
            {motionSel.flags?.length ? <p>旗標：{motionSel.flags.join("；")}</p> : null}
            {motionSel.candidateEvidence != null ? (
              <details className="mt-0.5">
                <summary className="cursor-pointer">平手候選各維觀測</summary>
                <pre className="mt-0.5 max-h-32 overflow-auto whitespace-pre-wrap break-all font-mono text-[9px]">
                  {JSON.stringify(motionSel.candidateEvidence, null, 1)}
                </pre>
              </details>
            ) : null}
          </>
        ) : (
          <p>motion selection 未落盤（motion/selection.json）</p>
        )}
      </div>
      {redo ? (
        <div className="rounded border border-amber-700/50 bg-amber-950/20 p-2">
          <p className="mb-1 text-[11px] text-amber-300">
            由 {shot.id} KF #{redo.idx} @ {redo.pct}% 做新 0%，重整 H3——補你想點改：
          </p>
          <FeedbackForm
            key={`${shot.id}:${redo.idx}`}
            jobId={jobId}
            shotId={shot.id}
            preset={`【重整】${shot.id} KF #${redo.idx} @ ${redo.pct}%——由呢一刻 cut 返開做新 0% 再 edit：`}
          />
        </div>
      ) : null}
      <H3PlanSlots jobId={jobId} shotId={shot.id} />
      <AudioCell jobId={jobId} shotId={shot.id} />
    </div>
  );
}

/** 格血統卡：H3 refs（refImages＋sources 對返 job 路徑）＋人物／物品參考＋灰片＋聲帶。 */
function PedigreeCard({
  jobId,
  shot,
  characters,
  propIdx,
}: {
  jobId: string;
  shot: Shot;
  characters: { id: string; name: string }[];
  propIdx: Map<string, number>;
}) {
  const shotId = shot.id;
  const { data, err } = useShotInspect(jobId, shotId);
  const h3 = data?.h3 ?? null;
  const refs = (() => {
    if (!h3) return [] as { label: string; srcs: string[] }[];
    const fromSources = (h3.sources ?? [])
      .filter((s) => /^ref_image(_\d+)?$/.test(s.role) && s.path)
      .map((s) => jobRel(s.path ?? "", jobId))
      .filter((r): r is string => Boolean(r));
    const names = h3.refImages ?? [];
    const count = Math.max(names.length, fromSources.length);
    return Array.from({ length: count }, (_, i) => ({
      label: `ref ${i}${names[i] ? ` · ${names[i]}` : ""}`,
      srcs: [fromSources[i], names[i]].filter((r): r is string => Boolean(r)).map((r) => media(jobId, r)),
    })).filter((entry) => entry.srcs.length > 0);
  })();
  /** 呢鏡用咗啲乜：marks 人物 → 角度板；props → assets plate。 */
  const charRefs = [...new Set((shot.marks ?? []).map((m) => m.characterId))].map((id) => ({
    id,
    name: characters.find((c) => c.id === id)?.name ?? id,
    srcs: [media(jobId, `portraits/boards/${id}.angles.png`)],
  }));
  const propRefs = (shot.props ?? []).map((p) => ({
    name: p.name,
    srcs: propSrcs(jobId, p.name, propIdx.get(p.name) ?? 0),
  }));

  return (
    <div className="space-y-2 rounded-lg border border-border/80 p-3 text-xs">
      <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">格血統卡 · {shotId}</span>
        {err ? <span className="text-destructive">收據載入失敗（{err}）</span> : null}
        {!err && data && !data.h3 ? (
          <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">未做H3</span>
        ) : null}
        {data?.h3 ? (
          <span>
            H3 {data.h3.motionForm ?? "—"} ·{" "}
            {(data.h3.sources ?? []).map((s) => `${s.role}:${s.sha256.slice(0, 8)}`).join(" ") || "舊收據冇 sources"}
          </span>
        ) : null}
      </div>
      {data?.h3 ? (
        refs.length ? (
          <div>
            <p className="mb-1 text-[10px] tracking-wider text-muted-foreground">H3 ref 圖 · {refs.length}</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {refs.map((entry) => (
                <div key={entry.label} className="w-32 shrink-0 overflow-hidden rounded border border-border">
                  <ProbeImg srcs={entry.srcs} alt={entry.label} className="h-20 w-full object-cover" missingLabel="ref 已唔喺碟" />
                  <span className="block truncate px-1 py-0.5 text-[9px] text-muted-foreground" title={entry.label}>
                    {entry.label}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ) : (
          <p className="text-muted-foreground">呢個 H3 form 冇帶 ref_images。</p>
        )
      ) : null}
      {charRefs.length ? (
        <div>
          <p className="mb-1 text-[10px] tracking-wider text-muted-foreground">人物參考 · {charRefs.length}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {charRefs.map((c) => (
              <div key={c.id} className="w-28 shrink-0 overflow-hidden rounded border border-border">
                <ProbeImg srcs={c.srcs} alt={c.name} className="h-16 w-full object-cover" missingLabel="角度板未交" />
                <span className="block truncate px-1 py-0.5 text-[9px] text-muted-foreground">{c.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {propRefs.length ? (
        <div>
          <p className="mb-1 text-[10px] tracking-wider text-muted-foreground">物品參考 · {propRefs.length}</p>
          <div className="flex gap-2 overflow-x-auto pb-1">
            {propRefs.map((p) => (
              <div key={p.name} className="w-28 shrink-0 overflow-hidden rounded border border-border">
                <ProbeImg srcs={p.srcs} alt={p.name} className="h-16 w-full object-cover" missingLabel="道具 plate 未交" />
                <span className="block truncate px-1 py-0.5 text-[9px] text-muted-foreground">{p.name}</span>
              </div>
            ))}
          </div>
        </div>
      ) : null}
      <div className="grid gap-2 md:grid-cols-2">
        {data && !data.files.blockout ? (
          <p className="flex items-center justify-center rounded border border-dashed p-4 text-muted-foreground">未有灰片 blockout/{shotId}.mp4</p>
        ) : (
          <video
            key={`${jobId}:${shotId}:blockout`}
            controls
            preload="none"
            className="w-full rounded border border-border bg-black"
            src={media(jobId, `blockout/${shotId}.mp4`)}
          />
        )}
        <AudioCell jobId={jobId} shotId={shotId} />
      </div>
    </div>
  );
}

/** audio/{shotId}.wav——load 唔到換「未有聲帶」，唔留一個壞 element。 */
function AudioCell({ jobId, shotId }: { jobId: string; shotId: string }) {
  const [bad, setBad] = useState(false);
  if (bad) {
    return (
      <p className="flex items-center justify-center rounded border border-dashed p-4 text-muted-foreground">
        未有聲帶 audio/{shotId}.wav
      </p>
    );
  }
  return (
    <audio
      key={`${jobId}:${shotId}:audio`}
      controls
      preload="none"
      className="w-full"
      src={media(jobId, `audio/${shotId}.wav`)}
      onError={() => setBad(true)}
    />
  );
}
