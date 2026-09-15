"use client";

import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { JobEvent, JobRecord } from "@/lib/studio/types";

type ShotRow = {
  shot: string;
  eyes: string[];
  verdicts: string[];
  proofs: string[];
  memoryHits: number;
  events: number;
  fleet?: string;
};

function rowsFor(job: JobRecord | null, events: JobEvent[]): ShotRow[] {
  const shots = job?.callSheet?.shots.map((s) => s.id) ?? [];
  const ids = shots.length ? shots : [...new Set(events.map((e) => String((e.data as { shot?: string } | undefined)?.shot ?? "")).filter(Boolean))];
  return ids.map((shot) => {
    const ev = events.filter((e) => String((e.data as { shot?: string } | undefined)?.shot ?? "") === shot);
    const eyes = [...new Set(ev.map((e) => String((e.data as { eye?: string } | undefined)?.eye ?? "")).filter(Boolean))];
    const verdicts = ev
      .map((e) => String((e.data as { verdict?: string } | undefined)?.verdict ?? e.level))
      .filter(Boolean);
    const proofs = [...new Set(ev.map((e) => String((e.data as { proof?: string } | undefined)?.proof ?? "")).filter(Boolean))];
    const memoryHits = ev.reduce((n, e) => {
      const hits = (e.data as { memoryHits?: unknown[] } | undefined)?.memoryHits;
      return n + (Array.isArray(hits) ? hits.length : e.message.includes("memory") ? 1 : 0);
    }, 0);
    return { shot, eyes, verdicts, proofs, memoryHits, events: ev.length, fleet: job?.providers?.stills };
  });
}

export function ShotTruth({ job, events }: { job: JobRecord | null; events: JobEvent[] }) {
  const rows = rowsFor(job, events);
  if (!job) return <p className="text-sm text-muted-foreground">未開 slate。</p>;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">未有分鏡事件。</p>;
  return (
    <div className="grid gap-3">
      {rows.map((row) => {
        const failed = row.verdicts.some((v) => v === "fail" || v === "FAIL");
        const passed = row.verdicts.some((v) => v === "pass" || v === "GREEN");
        const zeroEyes = row.eyes.length === 0;
        const greenOk = passed && !failed && !zeroEyes;
        return (
          <Card key={row.shot}>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <CardTitle className="font-mono text-sm">{row.shot}</CardTitle>
              {zeroEyes ? (
                <Badge variant="destructive">唔可以 GREEN（零眼）</Badge>
              ) : (
                <Badge variant={greenOk ? "default" : "destructive"}>{greenOk ? "GREEN" : "FAIL"}</Badge>
              )}
            </CardHeader>
            <CardContent className="space-y-1 text-xs text-muted-foreground">
              <p>fleet {row.fleet ?? job.providers?.mars ?? "—"}</p>
              <p>memory hits {row.memoryHits} · events {row.events}</p>
              <p>eyes {row.eyes.join(", ") || "—"}</p>
              <p>verdict {row.verdicts.slice(-4).join(" → ") || "—"}</p>
              <p>proof {row.proofs.join(" · ") || "—"}</p>
            </CardContent>
          </Card>
        );
      })}
    </div>
  );
}
