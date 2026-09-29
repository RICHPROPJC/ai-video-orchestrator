"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchH3Plan, keyframeRelPaths, type H3PlanFile } from "@/lib/studio/keyframe-rels";
import type { JobRecord, Shot } from "@/lib/studio/types";
import { kfSrcs, makePropIdx, pinPercents, propSrcs, studioMedia } from "@/lib/studio/canvas-rels";
import { useFramesAtPcts } from "@/lib/studio/film-thumbs";
import { useWorldOverview } from "@/lib/studio/world-client";
import { WorldPilotPreview } from "@/components/world-panel";
import { ProbeImg } from "@/components/album";
import { FeedbackForm } from "@/components/feedback-form";

/** Chau 0928（畫布真義）：灰模逐格對帳牆——擺晒所有灰模片嘅每一格
 *  （每個 KF 釘位抽嗰一刻，格序＝片序），每格下面掛住佢參考嘅圖（KF 檔）、
 *  逐鏡掛人物／道具參考同聲帶。中間一個位突然空咗、片長短咗長咗、
 *  接錯咗——行呢塊牆即刻對到數：邊鏡邊格出事一目了然。 */
export function BlockCanvas({ job }: { job: JobRecord | null }) {
  const shots = useMemo(() => {
    const all = job?.callSheet?.shots ?? [];
    const cut = job?.continuity?.cut;
    if (!cut?.length) return all;
    const byId = new Map(all.map((s) => [s.id, s]));
    const ordered = cut.map((id) => byId.get(id)).filter((s): s is Shot => Boolean(s));
    return ordered.length ? ordered : all;
  }, [job?.callSheet?.shots, job?.continuity?.cut]);
  const jobId = job?.id;
  const [plans, setPlans] = useState<Record<string, H3PlanFile | null>>({});
  useEffect(() => {
    if (!jobId || shots.length === 0) return;
    let stop = false;
    void Promise.all(shots.map((s) => fetchH3Plan(jobId, s.id))).then((list) => {
      if (stop) return;
      const map: Record<string, H3PlanFile | null> = {};
      list.forEach((p) => {
        if (p?.shotId) map[p.shotId] = p;
      });
      shots.forEach((s) => {
        if (!(s.id in map)) map[s.id] = null;
      });
      setPlans(map);
    });
    return () => {
      stop = true;
    };
  }, [jobId, shots]);
  const propIdx = useMemo(() => makePropIdx(job?.callSheet?.shots ?? []), [job?.callSheet?.shots]);

  if (!job?.id) {
    return <p className="mt-3 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">未有畫布資料。未開 slate。</p>;
  }
  if (shots.length === 0) {
    return <p className="mt-3 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">未有鏡——冇得對帳。</p>;
  }
  const totalExpect = shots.reduce((m, s) => m + s.durationSec, 0);
  return (
    <div className="mt-3 w-full min-w-0 space-y-2">
      <header className="flex flex-wrap items-center gap-2 rounded-lg border bg-black p-2 text-[11px] text-muted-foreground">
        <span className="font-medium text-foreground">灰模對帳牆</span>
        <span>{shots.length} 鏡 · 期望合計 {totalExpect.toFixed(1)}s</span>
        <span className="ml-auto">格帶＝灰模片每個 KF 釘位抽嗰刻（格序＝片序）；格下掛參考圖；紅＝空咗／KF 檔缺；⚠＝片長唔啱。</span>
      </header>
      {/* COLLAB-0929：World 現況行（集級；per-鏡綁定等 production job↔project 映射）。 */}
      <WorldLine />
      {/* Pi 0929 授權：per-鏡面板組件預寫試點預覽（binding 落齊換 AxisRow 真接線）。 */}
      <WorldPilotPreview />
      {shots.map((shot) => (
        <BlockShotCard
          key={`${job.id}:${shot.id}`}
          jobId={job.id}
          shot={shot}
          plan={plans[shot.id] ?? undefined}
          propIdx={propIdx}
          characters={job.callSheet?.characters ?? []}
        />
      ))}
    </div>
  );
}

/** World Studio 現況一行（集級 overview：editSeq＋contentFingerprint）；
 *  API 未接＝named-missing（CORS 缺——等 crew proxy 或 World 加 CORS）。 */
function WorldLine() {
  const { projects, unreachable } = useWorldOverview();
  if (unreachable) {
    return (
      <p className="rounded-lg border border-dashed border-border px-2 py-1 text-[10px] text-muted-foreground">
        World API 未接（:8791 CORS 缺——等 crew /api/world proxy 或 World 側加 CORS）；per-鏡 world 綁定＝等 production job↔project 映射
      </p>
    );
  }
  if (!projects) return <p className="px-1 text-[10px] text-muted-foreground">World：讀緊…</p>;
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border px-2 py-1 text-[10px] text-muted-foreground">
      <span className="font-medium text-foreground">World</span>
      {projects.map((p) => {
        const n = p.shots?.length;
        const total = p.shots?.reduce((m, s) => Math.max(m, s.timeOut ?? 0), 0);
        return (
          <span key={p.id} className="font-mono">
            {p.name ?? p.id}
            {typeof p.editSeq === "number" ? ` e${p.editSeq}` : ""}
            {p.contentFingerprint ? ` f${p.contentFingerprint.slice(0, 8)}` : "（未 save 過——冇 fingerprint）"}
            {n ? ` · ${n}鏡 ${total ? `${total.toFixed(1)}s` : ""}` : ""}
          </span>
        );
      })}
      <span className="ml-auto">per-鏡 world 綁定＝等 production job↔project 映射欄位（named）</span>
    </div>
  );
}

/** 離屏 metadata 探片長（唔載畫面淨載長度——對帳：期望 vs 實際；
 *  src 未定（卡未入畫）就唔開 video）。 */
function useVideoDuration(src?: string): { dur: number; bad: boolean } {
  const [st, setSt] = useState({ dur: 0, bad: false });
  useEffect(() => {
    if (!src) return;
    let stop = false;
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      if (!stop) setSt({ dur: v.duration || 0, bad: false });
    };
    v.onerror = () => {
      if (!stop) setSt({ dur: 0, bad: true });
    };
    v.src = src;
    return () => {
      stop = true;
      v.onloadedmetadata = null;
      v.onerror = null;
      v.src = "";
    };
  }, [src]);
  return st;
}

/** B1（Sol UI-PLAN）：卡入畫一次過先探——44 卡唔再即刻逐個開 video metadata。 */
function useInViewOnce() {
  const ref = useRef<HTMLDivElement | null>(null);
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const el = ref.current;
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
  return { ref, inView };
}

/** 一鏡一行對帳卡：期望秒數 vs 灰模實際秒數、KF 格帶（每格掛參考圖）、
 *  人物／道具參考、聲帶、h3_plan slots 摘要。 */
function BlockShotCard({
  jobId,
  shot,
  plan,
  propIdx,
  characters,
}: {
  jobId: string;
  shot: Shot;
  plan?: H3PlanFile | null;
  propIdx: Map<string, number>;
  characters: { id: string; name: string }[];
}) {
  const positions = plan?.positions || shot.keyframePositions || "";
  const rels = useMemo(() => keyframeRelPaths({ id: shot.id, keyframePositions: positions }), [shot.id, positions]);
  const pins = useMemo(() => pinPercents(positions, rels.length), [positions, rels.length]);
  const blockoutSrc = studioMedia(jobId, `blockout/${shot.id}.mp4`);
  const { ref: cardRef, inView } = useInViewOnce();
  const { dur, bad } = useVideoDuration(inView ? blockoutSrc : undefined);
  const frames = useFramesAtPcts(inView && !bad ? blockoutSrc : undefined, dur, pins);
  const expect = shot.durationSec;
  const diff = dur - expect;
  const warn = dur > 0 && Math.abs(diff) > 0.3 ? (diff < 0 ? `短咗 ${(-diff).toFixed(1)}s` : `長咗 ${diff.toFixed(1)}s`) : "";
  const charRefs = [...new Set((shot.marks ?? []).map((m) => m.characterId))].map((id) => ({
    id,
    name: characters.find((c) => c.id === id)?.name ?? id,
    srcs: [studioMedia(jobId, `portraits/boards/${id}.angles.png`)],
  }));
  const propRefs = (shot.props ?? []).map((p) => ({
    name: p.name,
    srcs: propSrcs(jobId, p.name, propIdx.get(p.name) ?? 0),
  }));
  const slots = plan?.slots;
  return (
    <section ref={cardRef} className={`space-y-1.5 rounded border p-2 ${bad ? "border-destructive/60" : "border-border"}`}>
      <header className="flex flex-wrap items-center gap-2 text-[11px]">
        <span className="font-mono font-medium text-foreground">{shot.id}</span>
        <span className="text-muted-foreground">期望 {expect.toFixed(1)}s</span>
        {bad ? (
          <span className="rounded bg-destructive/20 px-1.5 py-0.5 text-destructive">冇灰模——呢鏡對唔到帳</span>
        ) : dur > 0 ? (
          <span className="text-muted-foreground">實際 {dur.toFixed(1)}s</span>
        ) : (
          <span className="text-muted-foreground">讀緊長度…</span>
        )}
        {warn ? <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">⚠ {warn}</span> : null}
        {pins.length === 0 ? (
          <span className="rounded bg-amber-900/50 px-1.5 py-0.5 text-amber-300">冇 KF 釘位資料</span>
        ) : (
          <span className="text-muted-foreground">{pins.length} 格</span>
        )}
        {plan ? null : <span className="text-muted-foreground">（h3_plan 未落盤——用 sheet 釘位）</span>}
        {/* B1（Sol UI-PLAN §3）：畫布↔剪接直接互跳，同一 selection（?shot=）。 */}
        <a
          className="ml-auto rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-primary"
          href={`/?slate=${jobId}&tab=cut&shot=${shot.id}`}
        >
          → 剪接同鏈
        </a>
      </header>
      {/* 格帶：灰模幀 @ 釘位；每格下面掛 KF 參考圖（檔缺＝紅字）。 */}
      <div className="flex gap-1 overflow-x-auto pb-1">
        {pins.map((p, i) => (
          <div key={`${shot.id}:${i}`} className={`w-24 shrink-0 overflow-hidden rounded border bg-black ${rels[i] ? "border-border" : "border-destructive/60"}`}>
            <div className="relative">
              {frames[i] ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={frames[i]} alt={`${shot.id} ${p}%`} className="h-14 w-full object-cover" />
              ) : (
                <span className="flex h-14 items-center justify-center text-[10px] text-muted-foreground">
                  {bad ? "冇灰模" : dur > 0 ? "抽緊" : "…"}
                </span>
              )}
              <span className="absolute bottom-0 right-0 bg-black/70 px-0.5 font-mono text-[8px] text-white">{p}%</span>
            </div>
            <ProbeImg srcs={kfSrcs(jobId, shot.id, rels[i], i)} alt={`${shot.id} KF ${i}`} className="h-10 w-full object-cover" missingLabel="KF檔缺" />
          </div>
        ))}
      </div>
      {/* 參考行：人物角度板／道具 plate／聲帶／h3_plan slots。 */}
      <div className="flex flex-wrap items-start gap-2 text-[9px]">
        {charRefs.map((c) => (
          <div key={c.id} className="w-16 shrink-0 overflow-hidden rounded border border-border">
            <ProbeImg srcs={c.srcs} alt={c.name} className="h-10 w-full object-cover" missingLabel="未交" />
            <span className="block truncate px-0.5 text-center text-muted-foreground">{c.name}</span>
          </div>
        ))}
        {propRefs.map((p) => (
          <div key={p.name} className="w-16 shrink-0 overflow-hidden rounded border border-border">
            <ProbeImg srcs={p.srcs} alt={p.name} className="h-10 w-full object-cover" missingLabel="未交" />
            <span className="block truncate px-0.5 text-center text-muted-foreground">{p.name}</span>
          </div>
        ))}
        {slots?.photo?.length ? (
          <div className="flex flex-col gap-0.5">
            {(slots.photo ?? []).slice(0, 4).map((slot, i) =>
              slot.file ? (
                <ProbeImg key={`ph${i}`} srcs={[studioMedia(jobId, slot.file)]} alt={slot.bind ?? `ref${i}`} className="h-10 w-16 object-cover" missingLabel="ref缺" />
              ) : null,
            )}
            <span className="text-center text-muted-foreground">h3圖 refs {(slots.photo ?? []).length}</span>
          </div>
        ) : null}
        <div className="flex min-w-32 flex-1 flex-col gap-1">
          <audio controls preload="none" className="w-full" src={studioMedia(jobId, `audio/${shot.id}.wav`)} />
          {slots?.audio?.length ? (
            <span className="text-muted-foreground">h3聲 refs：{(slots.audio ?? []).map((s) => (s.file ?? "").split("/").pop()).join("、")}</span>
          ) : null}
        </div>
      </div>
      <details className="rounded border border-border/60 px-2 py-1 text-[10px] text-muted-foreground">
        <summary className="cursor-pointer">呢鏡對到數／有問題——報去處理</summary>
        <div className="mt-1">
          <FeedbackForm
            jobId={jobId}
            shotId={shot.id}
            preset={`【對帳】${shot.id} 期望 ${expect.toFixed(1)}s${bad ? " · 冇灰模" : dur > 0 ? ` · 實際 ${dur.toFixed(1)}s${warn ? ` · ${warn}` : ""}` : ""}：`}
          />
        </div>
      </details>
    </section>
  );
}
