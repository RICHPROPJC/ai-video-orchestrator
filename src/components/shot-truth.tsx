"use client";

import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { JobEvent, JobRecord } from "@/lib/studio/types";

type ShotRow = {
  shot: string;
  eyes: string[];
  verdicts: string[];
  proofs: string[];
  eventsAt: { level: string; message: string }[];
};

function rowsFor(job: JobRecord | null, events: JobEvent[]): ShotRow[] {
  const shots = job?.callSheet?.shots.map((s) => s.id) ?? [];
  const ids = shots.length ? shots : [...new Set(events.map((e) => String((e.data as { shot?: string } | undefined)?.shot ?? "")).filter(Boolean))];
  return ids.map((shot) => {
    const ev = events.filter((e) => String((e.data as { shot?: string } | undefined)?.shot ?? "") === shot);
    const eyes = [...new Set(ev.map((e) => String((e.data as { eye?: string } | undefined)?.eye ?? "")).filter(Boolean))];
    // Chau 0927：info 唔入判決串——淨 pass/fail/warn level 先算判決
    const verdicts = ev
      .filter((e) => e.level === "pass" || e.level === "fail" || e.level === "warn")
      .map((e) => String((e.data as { verdict?: string } | undefined)?.verdict ?? e.level))
      .filter(Boolean);
    const proofs = [...new Set(ev.map((e) => String((e.data as { proof?: string } | undefined)?.proof ?? "")).filter(Boolean))];
    return {
      shot, eyes, verdicts, proofs,
      eventsAt: ev.map((e) => ({ level: e.level, message: e.message })),
    };
  });
}

/** Chau 0927（第四項：「QC eat what」）：QC 判官食咗咩要見到——圖＝
 *  stills/SHxx.photo_qc.json 嘅 image 欄；require＝stills/SHxx.require.json
 *  逐項。兩份收據 404 一律靜默跳過（唔作數）。 */
type QcAte = { image?: string; require?: Record<string, unknown> };

function requireValue(v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => String(x)).join("、") || "—";
  return String(v);
}

function QcAteRow({ jobId, shot }: { jobId: string; shot: string }) {
  const [ate, setAte] = useState<QcAte | null>(null);
  useEffect(() => {
    let stop = false;
    const read = (path: string) => fetch(`/api/media/${jobId}/${path}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    void Promise.all([read(`stills/${shot}.photo_qc.json`), read(`stills/${shot}.require.json`)]).then(([qc, req]) => {
      if (stop) return;
      const qcObj = qc && typeof qc === "object" ? (qc as { image?: unknown }) : null;
      const reqObj = req && typeof req === "object" && !Array.isArray(req) ? (req as Record<string, unknown>) : null;
      const image = typeof qcObj?.image === "string" && qcObj.image.trim() ? qcObj.image : undefined;
      if (!image && !reqObj) return;
      setAte({ image, require: reqObj ?? undefined });
    });
    return () => { stop = true; };
  }, [jobId, shot]);
  if (!ate) return null;
  const imageRel = ate.image ? (ate.image.includes("/") ? ate.image : `stills/${ate.image}`) : undefined;
  return (
    <div className="mt-1 flex flex-wrap items-start gap-3 rounded-md border px-2 py-1.5">
      <p className="w-full text-[10px] uppercase tracking-wider text-muted-foreground">QC 判官食咗</p>
      {imageRel ? (
        <a href={`/api/media/${jobId}/${imageRel}`} target="_blank" rel="noreferrer" aria-label={`開原圖：${imageRel}`}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img loading="lazy" src={`/api/media/${jobId}/${imageRel}?preview=1`} alt={`${shot} QC 判官食嘅圖`} className="h-20 rounded border object-cover" />
        </a>
      ) : null}
      {ate.require ? (
        <ul className="min-w-40 flex-1 space-y-0.5 font-mono text-[10px] leading-tight text-muted-foreground">
          {Object.entries(ate.require).map(([k, v]) => (
            <li key={k}>{k}：{requireValue(v)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export function ShotTruth({ job, events }: { job: JobRecord | null; events: JobEvent[] }) {
  const rows = rowsFor(job, events);
  if (!job) return <p className="text-sm text-muted-foreground">未開 slate。</p>;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">未有分鏡事件。</p>;
  return (
    <div className="grid gap-3">
      {rows.map((row) => {
        const verdictEvent = [...row.eventsAt].reverse().find((e) => e.level === "fail" || e.level === "pass");
        const latestFail = verdictEvent?.level === "fail";
        const latestPass = verdictEvent?.level === "pass";
        const zeroEyes = row.eyes.length === 0;
        const greenOk = latestPass && !latestFail && !zeroEyes;
        return (
          <Card key={row.shot}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="font-mono text-sm">{row.shot}</CardTitle>
              {zeroEyes ? (
                <Badge variant="destructive">唔可以 GREEN（零眼）</Badge>
              ) : verdictEvent ? (
                <Badge variant={greenOk ? "default" : "destructive"}>{greenOk ? "GREEN" : "FAIL"}</Badge>
              ) : (
                <Badge variant="outline">未判</Badge>
              )}
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-muted-foreground">
              <p>eyes {row.eyes.join(", ") || "—"}</p>
              <p>最新 {verdictEvent ? `${verdictEvent.level} ${verdictEvent.message.slice(0, 80)}` : "—"}</p>
              <p>
                proof{" "}
                {row.proofs.length ? (
                  row.proofs.map((p, i) => (
                    <span key={p}>
                      {i > 0 ? " · " : ""}
                      <a className="text-primary underline" href={`/api/media/${job.id}/${p}`}>
                        {p}
                      </a>
                    </span>
                  ))
                ) : (
                  "—"
                )}
              </p>
              <QcAteRow jobId={job.id} shot={row.shot} />
              {/* Chau 0927：長判決串收埋做摺疊——主體淨睇最新判決／eyes／proof。 */}
              <details>
                <summary className="cursor-pointer">歷史判決 {row.verdicts.length} 筆</summary>
                <p className="mt-1 font-mono leading-relaxed">{row.verdicts.join(" → ") || "—"}</p>
              </details>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
