"use client";

import { useMemo, useRef, useState } from "react";
import { layoutKeyframes, layoutOwnBoards, storyboardItems } from "@/lib/studio/keyframe-rels";
import type { JobRecord } from "@/lib/studio/types";

function media(id: string, rel: string) {
  return `/api/media/${id}/${rel}`;
}

export function ShotCanvas({ job }: { job: JobRecord | null }) {
  const shots = useMemo(() => job?.callSheet?.shots ?? [], [job?.callSheet?.shots]);
  const nodes = useMemo(() => layoutKeyframes(shots), [shots]);
  const boards = useMemo(() => {
    const right = nodes.reduce((m, n) => Math.max(m, n.x), 0);
    const props = new Set(shots.flatMap((s) => (s.props ?? []).map((p) => p.name)));
    return layoutOwnBoards({
      characters: (job?.callSheet?.characters ?? []).map((c) => ({ id: c.id, name: c.name })),
      locations: shots.map((s) => s.location),
      props: [...props],
      buildings: job?.callSheet?.buildings,
      right,
    });
  }, [job?.callSheet?.characters, job?.callSheet?.buildings, nodes, shots]);
  const storyboards = storyboardItems(job?.callSheet?.storyboard ?? [], job?.id ?? "").map((cell, i) => ({
    ...cell, x: Math.max(...nodes.map((n) => n.x), 0) + 480, y: 48 + i * 168,
  }));
  const [missing, setMissing] = useState<string[]>([]);
  const [scale, setScale] = useState(0.55);
  const [origin, setOrigin] = useState({ x: 0, y: 0 });
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  if (!job || (nodes.length === 0 && boards.length === 0 && storyboards.length === 0)) {
    return <p className="mt-3 rounded-lg border border-dashed p-8 text-sm text-muted-foreground">未有畫布資料。文字表唔等於分鏡已交付。</p>;
  }

  const width = Math.max(...nodes.map((n) => n.x), ...boards.map((b) => b.x), ...storyboards.map((b) => b.x), 0) + 280;
  const height = Math.max(...nodes.map((n) => n.y), ...boards.map((b) => b.y), ...storyboards.map((b) => b.y), 0) + 220;

  const selected = [...nodes, ...boards, ...storyboards].find((n) => n.id === picked && n.rel && !missing.includes(`${job.id}:${n.rel}`));
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
          · 已提交 {job.outputs.shots.filter((p) => /\/SH\d+\.mp4$/.test(p) || /^SH\d+\.mp4$/.test(p.split("/").pop() ?? "")).length}
          。檔案存在唔等於 QC 通過。
        </span>
        <span>{Math.round(scale * 100)}%</span>
      </div>
      <div
        className="relative h-[640px] w-full cursor-grab overflow-hidden active:cursor-grabbing"
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
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={media(job.id, selected.rel)} alt={"label" in selected ? selected.label : selected.shotId} className="max-h-[85vh] max-w-full object-contain" />
        </div>
      )}
    </div>
  );
}
