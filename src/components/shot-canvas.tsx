"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { fetchH3Plan, fetchKfEditRecord, layoutKeyframes, layoutOwnBoards, receiptFileToRel, storyboardItems, type H3PlanFile, type KfEditRecord } from "@/lib/studio/keyframe-rels";
import type { JobRecord } from "@/lib/studio/types";
import { FeedbackForm } from "@/components/feedback-form";

function media(id: string, rel: string) {
  return `/api/media/${id}/${rel}`;
}

/** Chau 0927：畫布本身要連住每鏡參考嘅圖、片、音——每鏡 H3 實際食嘅 refs
 *  （灰模 mp4／wav／KF 參考圖）排喺 KF 節點右側，KF 節點連去 h3_plan slots
 *  實際 file 嘅節點。睇得出邊度食錯嘢。 */
type RefNode = {
  id: string;
  shotId: string;
  kind: "video" | "audio" | "photo";
  rel: string;
  label: string;
  x: number;
  y: number;
  /** h3＝H3 生成食嘅 refs；kf＝U1.5 KF 生成自己食嘅 refs（第二組虛線）。 */
  lane: "h3" | "kf";
  /** 灰模片本身嘅 KF percentages（plan.positions），寫喺 blockout 格下面。 */
  kfNote?: string;
  /** 同鏡對應嘅 KF 檔名（stills/SHxx.kf-*.png），寫喺 blockout 格下面。 */
  kfFiles?: string;
};

export function ShotCanvas({ job }: { job: JobRecord | null }) {
  const shots = useMemo(() => job?.callSheet?.shots ?? [], [job?.callSheet?.shots]);
  const nodes = useMemo(() => layoutKeyframes(shots), [shots]);
  const jobId = job?.id;
  const [plans, setPlans] = useState<Record<string, H3PlanFile>>({});
  useEffect(() => {
    if (!jobId || shots.length === 0) return;
    let stop = false;
    // batch 讀晒先至過一次 setState；404／爛 json 由 fetchH3Plan 靜默跳過
    void Promise.all(shots.map((s) => fetchH3Plan(jobId, s.id))).then((list) => {
      if (stop) return;
      const map: Record<string, H3PlanFile> = {};
      for (const plan of list) if (plan?.shotId) map[plan.shotId] = plan;
      setPlans(map);
    });
    return () => { stop = true; };
  }, [jobId, shots]);
  const [kfRecords, setKfRecords] = useState<Record<string, KfEditRecord>>({});
  useEffect(() => {
    if (!jobId || shots.length === 0) return;
    let stop = false;
    // Chau 0927（統一原則）：KF 嗰級都係「生成物＋佢食咗嘅 refs」——讀
    // stills/SHxx.u15_edit.json 收據（record.base＋record.refs）；
    // 未落盤靜默跳過，dialog 嗰邊顯示「refs 未記錄」。
    void Promise.all(shots.map((s) => fetchKfEditRecord(jobId, s.id))).then((list) => {
      if (stop) return;
      const map: Record<string, KfEditRecord> = {};
      list.forEach((rec, i) => { if (rec) map[shots[i]!.id] = rec; });
      setKfRecords(map);
    });
    return () => { stop = true; };
  }, [jobId, shots]);
  // Chau 0927（統一原則）：KF 生成自己食咗嘅 refs（u15_edit 收據 base＋refs）
  // ——第二組節點／虛線，排喺 H3 refs rail 再右邊；收據欄位空就成組跳過
  const kfRefNodes = useMemo(() => {
    const list: RefNode[] = [];
    for (const shot of shots) {
      const rec = kfRecords[shot.id];
      if (!rec) continue;
      const own = nodes.filter((n) => n.shotId === shot.id);
      if (!own.length) continue;
      const rels = [...new Set([rec.base ?? "", ...(rec.refs ?? [])].filter(Boolean))].flatMap((file) => {
        const rel = jobId ? receiptFileToRel(file, jobId) : undefined;
        return rel && !nodes.some((n) => n.rel === rel) ? [rel] : [];
      });
      if (!rels.length) continue;
      const x = Math.min(...own.map((n) => n.x)) + 380;
      let y = Math.min(...own.map((n) => n.y));
      rels.forEach((rel, i) => {
        const isVideo = /\.mp4$/.test(rel);
        list.push({ id: `kfref:${shot.id}:${i}`, shotId: shot.id, kind: isVideo ? "video" : "photo", rel, label: rel.split("/").pop() ?? rel, lane: "kf", x, y });
        y += isVideo ? 156 : 122;
      });
    }
    return list;
  }, [kfRecords, nodes, shots, jobId]);
  const kfRefEdges = useMemo(() => {
    const edges: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const node of kfRefNodes) {
      for (const kf of nodes.filter((n) => n.shotId === node.shotId)) {
        edges.push({ key: `${kf.id}:${node.id}`, x1: kf.x + 144, y1: kf.y + 48, x2: node.x, y2: node.y + 48 });
      }
    }
    return edges;
  }, [kfRefNodes, nodes]);
  const refNodes = useMemo(() => {
    const list: RefNode[] = [];
    for (const shot of shots) {
      const plan = plans[shot.id];
      if (!plan?.slots) continue;
      const own = nodes.filter((n) => n.shotId === shot.id);
      if (!own.length) continue;
      const x = Math.min(...own.map((n) => n.x)) + 190;
      let y = Math.min(...own.map((n) => n.y));
      // Chau 0927：灰模每格 keyframe 嘅對應關係——blockout 格下面列同鏡 KF 檔名
      const kfFiles = nodes
        .filter((n) => n.shotId === shot.id && /\.kf-\d+\.png$/.test(n.rel))
        .map((n) => n.rel.split("/").pop() ?? n.rel)
        .join("、");
      (plan.slots.video ?? []).forEach((slot, i) => {
        if (!slot.file) return;
        list.push({
          id: `ref:${shot.id}:video:${i}`,
          shotId: shot.id,
          kind: "video",
          rel: slot.file,
          label: slot.bind ?? `ref_video_${i}`,
          lane: "h3",
          x,
          y,
          kfNote: i === 0 && plan.positions ? `KF：${plan.positions}` : undefined,
          kfFiles: i === 0 && kfFiles ? kfFiles : undefined,
        });
        y += 156;
      });
      (plan.slots.audio ?? []).forEach((slot, i) => {
        if (!slot.file) return;
        list.push({ id: `ref:${shot.id}:audio:${i}`, shotId: shot.id, kind: "audio", rel: slot.file, label: slot.file.split("/").pop() ?? slot.file, lane: "h3", x, y });
        y += 74;
      });
      (plan.slots.photo ?? []).forEach((slot, i) => {
        if (!slot.file) return;
        // KF 節點本身已係嗰張 still 就唔重複起格——reference 線直接連返佢
        if (nodes.some((n) => n.rel === slot.file)) return;
        list.push({ id: `ref:${shot.id}:photo:${i}`, shotId: shot.id, kind: "photo", rel: slot.file, label: slot.bind ?? `ref_image_${i}`, lane: "h3", x, y });
        y += 122;
      });
    }
    return list;
  }, [nodes, plans, shots]);
  const boards = useMemo(() => {
    const right = Math.max(...nodes.map((n) => n.x), ...refNodes.map((n) => n.x), ...kfRefNodes.map((n) => n.x), 0);
    const props = new Set(shots.flatMap((s) => (s.props ?? []).map((p) => p.name)));
    return layoutOwnBoards({
      characters: (job?.callSheet?.characters ?? []).map((c) => ({ id: c.id, name: c.name })),
      locations: shots.map((s) => s.location),
      props: [...props],
      buildings: job?.callSheet?.buildings,
      right,
    });
  }, [job?.callSheet?.characters, job?.callSheet?.buildings, nodes, refNodes, kfRefNodes, shots]);
  const storyboards = storyboardItems(job?.callSheet?.storyboard ?? [], job?.id ?? "").map((cell, i) => ({
    ...cell, x: Math.max(...nodes.map((n) => n.x), ...refNodes.map((n) => n.x), ...kfRefNodes.map((n) => n.x), 0) + 480, y: 48 + i * 168,
  }));
  // KF 節點 → h3_plan slots 實際 file 節點（KF 自己嗰張除外）
  const refEdges = useMemo(() => {
    const edges: { key: string; x1: number; y1: number; x2: number; y2: number }[] = [];
    for (const shot of shots) {
      const plan = plans[shot.id];
      if (!plan?.slots) continue;
      const files = [...new Set((["video", "audio", "photo"] as const).flatMap((kind) => (plan.slots?.[kind] ?? []).flatMap((slot) => (slot.file ? [slot.file] : []))))];
      const targets = files.flatMap((file) => {
        const hit = nodes.find((n) => n.rel === file) ?? refNodes.find((r) => r.rel === file && r.shotId === shot.id);
        return hit ? [{ id: hit.id, x: hit.x, y: hit.y }] : [];
      });
      for (const kf of nodes.filter((n) => n.shotId === shot.id)) {
        for (const target of targets) {
          if (target.id === kf.id) continue;
          edges.push({ key: `${kf.id}:${target.id}`, x1: kf.x + 144, y1: kf.y + 48, x2: target.x, y2: target.y + 48 });
        }
      }
    }
    return edges;
  }, [nodes, refNodes, plans, shots]);
  const [missing, setMissing] = useState<string[]>([]);
  const [scale, setScale] = useState(0.55);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  if (!job || (nodes.length === 0 && boards.length === 0 && storyboards.length === 0)) {
    return <p className="mt-3 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">未有畫布資料。文字表唔等於分鏡已交付。</p>;
  }

  const width = Math.max(...nodes.map((n) => n.x), ...refNodes.map((n) => n.x), ...kfRefNodes.map((n) => n.x), ...boards.map((b) => b.x), ...storyboards.map((b) => b.x), 0) + 280;
  const height = Math.max(...nodes.map((n) => n.y), ...refNodes.map((n) => n.y), ...kfRefNodes.map((n) => n.y), ...boards.map((b) => b.y), ...storyboards.map((b) => b.y), 0) + 220;

  const selected = [...nodes, ...boards, ...storyboards, ...refNodes, ...kfRefNodes].find((n) => n.id === picked && n.rel && !missing.includes(`${job.id}:${n.rel}`));
  const references = nodes.flatMap((node) => {
    const shot = shots.find((s) => s.id === node.shotId);
    return boards.filter((b) => b.rel && !missing.includes(`${job.id}:${b.rel}`) && b.id.startsWith("char:") && shot?.marks.some((m) => b.id === `char:${m.characterId}`))
      .map((b) => ({ from: b, to: node }));
  });
  return (
    <div className="mt-3 w-full min-w-0 overflow-hidden rounded-lg border bg-black">
      <div className="flex items-center justify-between px-3 py-2 text-[11px] text-muted-foreground">
        <span>
          計劃鍵格 {shots.filter((s) => (s.keyframePositions ?? "").trim()).length}
          · 靜畫檔 {job.outputs.stills.length}
          · 灰片檔 {job.outputs.blockout.length}
          · refs 已連 {refEdges.length + kfRefEdges.length}
          · 已提交 {job.outputs.shots.filter((p) => /\/SH\d+\.mp4$/.test(p) || /^SH\d+\.mp4$/.test(p.split("/").pop() ?? "")).length}
          。檔案存在唔等於 QC 通過。
        </span>
        <span>{Math.round(scale * 100)}%</span>
      </div>
      {/* Chau 0927（手機實測）：pan 區落 touch-action:none——撳實拖先唔會穿落
          去 scroll 成個頁；zoom wheel 本身已有 preventDefault。大圖 dialog 唔係
          呢個容器嘅子孫，video/audio/img 唔會繼承到。 */}
      <div
        className="relative h-[640px] w-full cursor-grab overflow-hidden [touch-action:none] active:cursor-grabbing"
        onWheel={(e) => {
          e.preventDefault();
          setScale((s) => Math.min(1.6, Math.max(0.15, s * (e.deltaY > 0 ? 0.9 : 1.1))));
        }}
        onPointerDown={(e) => {
          if ((e.target as HTMLElement).closest("[data-kf]")) return;
          drag.current = { x: e.clientX, y: e.clientY, ox: origin.x, oy: origin.y };
          const el = e.currentTarget as HTMLElement;
          try { el.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
        }}
        onPointerMove={(e) => {
          if (!drag.current) return;
          setOrigin({ x: drag.current.ox + e.clientX - drag.current.x, y: drag.current.oy + e.clientY - drag.current.y });
        }}
        onPointerUp={(e) => {
          drag.current = null;
          const el = e.currentTarget as HTMLElement;
          try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        }}
        onPointerCancel={(e) => {
          drag.current = null;
          const el = e.currentTarget as HTMLElement;
          try { if (el.hasPointerCapture(e.pointerId)) el.releasePointerCapture(e.pointerId); } catch { /* already released */ }
        }}
      >
        <div className="absolute left-0 top-0" style={{ width, height, transform: `translate(${origin.x}px, ${origin.y}px) scale(${scale})`, transformOrigin: "0 0" }}>
          <svg width={width} height={height} className="absolute left-0 top-0">
            {nodes.slice(1).map((node, i) => {
              const prev = nodes[i]!;
              return (
                <line
                  data-edge="cut"
                  key={`${prev.id}-${node.id}`}
                  x1={prev.x + 72}
                  y1={prev.y + 96}
                  x2={node.x + 72}
                  y2={node.y}
                  stroke="currentColor"
                  className="text-muted-foreground"
                  strokeWidth={1}
                />
              );
            })}
            {references.map(({ from, to }) => <line data-edge="reference" key={`${from.id}:${to.id}`} x1={from.x} y1={from.y + 48} x2={to.x + 144} y2={to.y + 48} stroke="#64748b" strokeDasharray="5 5" />)}
            {refEdges.map((edge) => <line data-edge="reference" key={edge.key} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke="#64748b" strokeDasharray="5 5" />)}
            {kfRefEdges.map((edge) => <line data-edge="reference" key={edge.key} x1={edge.x1} y1={edge.y1} x2={edge.x2} y2={edge.y2} stroke="#64748b" strokeDasharray="5 5" />)}
          </svg>
          {nodes.map((node) => (
            <button
              key={node.id}
              type="button"
              data-kf=""
              onClick={() => setPicked(node.id)}
              className={`absolute w-36 overflow-hidden rounded border bg-black text-left ${picked === node.id ? "border-primary" : "border-border"}`}
              style={{ left: node.x, top: node.y }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img loading="lazy" src={`${media(job.id, node.rel)}?preview=1`} alt={node.shotId} className="h-24 w-full object-cover" />
              <span className="block px-1 py-0.5 text-[10px] text-muted-foreground">
                {node.shotId}{node.at ? ` ${node.at}` : ""}
              </span>
            </button>
          ))}
          {[...refNodes, ...kfRefNodes].map((node) => (
            <div
              key={node.id}
              data-kf=""
              className={`absolute w-36 overflow-hidden rounded border bg-black ${picked === node.id ? "border-primary" : "border-border"}`}
              style={{ left: node.x, top: node.y }}
            >
              {node.kind === "video" ? (
                <button type="button" className="block w-full text-left" onClick={() => setPicked(node.id)}>
                  {missing.includes(`${job.id}:${node.rel}`) ? (
                    <span className="flex h-24 items-center justify-center text-xs text-muted-foreground">未交灰片</span>
                  ) : (
                    <video
                      preload="metadata"
                      muted
                      src={media(job.id, node.rel)}
                      className="pointer-events-none h-24 w-full object-cover"
                      onError={() => setMissing((cur) => [...new Set([...cur, `${job.id}:${node.rel}`])])}
                    />
                  )}
                  <span className="block px-1 py-0.5 text-[10px] text-muted-foreground">{node.shotId} · {node.lane === "kf" ? `KF·${node.label}` : "灰模"}</span>
                  {node.kfNote ? <span className="block px-1 pb-0.5 text-[10px] text-muted-foreground">{node.kfNote}</span> : null}
                  {node.kfFiles ? <span className="block px-1 pb-0.5 text-[10px] break-all text-muted-foreground">{node.kfFiles}</span> : null}
                </button>
              ) : node.kind === "audio" ? (
                <div className="p-1">
                  <audio controls preload="none" src={media(job.id, node.rel)} className="w-full" />
                  <span className="block px-0.5 py-0.5 text-[10px] break-all text-muted-foreground">{node.label}</span>
                </div>
              ) : (
                <button type="button" className="block w-full text-left" onClick={() => setPicked(node.id)}>
                  {missing.includes(`${job.id}:${node.rel}`) ? (
                    <span className="flex h-24 items-center justify-center text-xs text-muted-foreground">未交圖</span>
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      loading="lazy"
                      src={`${media(job.id, node.rel)}?preview=1`}
                      alt={node.label}
                      className="h-24 w-full object-cover"
                      onError={() => setMissing((cur) => [...new Set([...cur, `${job.id}:${node.rel}`])])}
                    />
                  )}
                  <span className="block px-1 py-0.5 text-[10px] break-all text-muted-foreground">{node.shotId} · {node.lane === "kf" ? `KF·${node.label}` : node.label}</span>
                </button>
              )}
            </div>
          ))}
          {[...boards, ...storyboards].map((board) => (
            <button
              key={board.id}
              type="button"
              data-kf=""
              onClick={() => board.rel && !missing.includes(`${job.id}:${board.rel}`) && setPicked(board.id)}
              className={`absolute w-40 overflow-hidden rounded border bg-black text-left ${picked === board.id ? "border-primary" : "border-border"}`}
              style={{ left: board.x, top: board.y }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              {board.rel && !missing.includes(`${job.id}:${board.rel}`) ? <img
                loading="lazy"
                src={`${media(job.id, board.rel)}?preview=1`}
                alt={board.label}
                className="h-28 w-full object-cover"
                onError={() => setMissing((cur) => [...new Set([...cur, `${job.id}:${board.rel}`])])}
              /> : <span className="flex h-28 items-center justify-center text-xs text-muted-foreground">未交圖</span>}
              <span className="block px-1 py-0.5 text-[10px] text-muted-foreground">{board.label}</span>
            </button>
          ))}
        </div>
      </div>
      {selected?.rel && (
        <div role="dialog" aria-modal="true" aria-label="大圖" onKeyDown={(e) => { if (e.key === "Escape") setPicked(null); }} className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/90 p-6" onClick={() => setPicked(null)}>
          <button autoFocus type="button" className="mb-2 rounded border px-4 py-2 text-white" onClick={() => setPicked(null)}>關閉大圖</button>
          {"kind" in selected && selected.kind === "video" ? (
            <video src={media(job.id, selected.rel)} controls autoPlay className="max-h-[70vh] max-w-full" onClick={(e) => e.stopPropagation()} />
          ) : (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={media(job.id, selected.rel)} alt={"label" in selected ? selected.label : selected.shotId} className="max-h-[70vh] max-w-full object-contain" onClick={(e) => e.stopPropagation()} />
          )}
          {(() => {
            // Chau 0927（統一原則）：KF 節點大圖都要見到佢生成時食咗嘅 refs
            // （u15_edit 收據 base＋refs）——同一套畫簿視覺；收據未記錄就照講。
            const kf = nodes.find((n) => n.id === picked);
            if (!kf) return null;
            const rec = kfRecords[kf.shotId];
            const rels = [...new Set([rec?.base ?? "", ...(rec?.refs ?? [])].filter(Boolean))].flatMap((file) => {
              const rel = receiptFileToRel(file, job.id);
              return rel ? [rel] : [];
            });
            return (
              <div className="mt-2 flex max-w-3xl flex-wrap items-start gap-2" onClick={(e) => e.stopPropagation()}>
                <p className="w-full text-left font-mono text-[10px] text-neutral-500">佢嘅 refs（KF 生成食咗）</p>
                {rels.length ? rels.map((rel) => (
                  <figure key={rel} className="w-36 text-left">
                    {/\.mp4$/.test(rel) ? (
                      <video src={media(job.id, rel)} controls muted className="w-full rounded border" />
                    ) : (
                      <a href={media(job.id, rel)} target="_blank" rel="noreferrer">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img loading="lazy" src={`${media(job.id, rel)}?preview=1`} alt={rel} className="h-24 w-full rounded border object-cover" />
                      </a>
                    )}
                    <figcaption className="mt-0.5 font-mono text-[10px] break-all text-neutral-400">{rel.split("/").pop()}</figcaption>
                  </figure>
                )) : <p className="font-mono text-[10px] text-neutral-500">refs 未記錄</p>}
              </div>
            );
          })()}
          <div onClick={(e) => e.stopPropagation()}>
            <FeedbackForm jobId={job.id} shotId={"shotId" in selected ? selected.shotId : undefined} />
          </div>
        </div>
      )}
    </div>
  );
}
