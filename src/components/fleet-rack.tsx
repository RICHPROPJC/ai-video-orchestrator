"use client";

import { buttonVariants } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "cn";
import type { FleetReport, FleetStatus } from "@/lib/studio/fleet";

function statusVariant(status: FleetStatus): "default" | "destructive" | "outline" | "secondary" {
  if (status === "UP") return "default";
  if (status === "UNCONFIG") return "secondary";
  return "destructive";
}

function statusClass(status: FleetStatus): string {
  if (status === "UP") return "text-emerald-400";
  if (status === "UNCONFIG") return "text-muted-foreground";
  return "text-destructive";
}

export function FleetRack({
  fleet,
  probing,
  onProbe,
}: {
  fleet: FleetReport | null;
  probing: boolean;
  onProbe: () => void;
}) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-2 border-b">
        <div>
          <CardTitle>Fleet</CardTitle>
          <p className="text-muted-foreground mt-1 text-[11px]">
            探 /health · /v1/models · /system_stats。config ≠ live → 紅。
          </p>
        </div>
        <button
          type="button"
          className={cn(buttonVariants({ size: "sm", variant: "outline" }))}
          onClick={onProbe}
          disabled={probing}
        >
          {probing ? "探緊…" : "探機"}
        </button>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {fleet ? (
          <>
            <p>
              READY{" "}
              <b className={fleet.ready ? "text-emerald-400" : "text-destructive"}>
                {fleet.ready ? "yes" : "no"}
              </b>
            </p>
            <div className="overflow-x-auto">
              <table className="w-full text-left">
                <thead className="text-muted-foreground">
                  <tr>
                    <th className="py-1 pr-2 font-normal">層</th>
                    <th className="py-1 pr-2 font-normal">狀態</th>
                    <th className="py-1 pr-2 font-normal">config</th>
                    <th className="py-1 pr-2 font-normal">live</th>
                    <th className="py-1 font-normal">VRAM</th>
                  </tr>
                </thead>
                <tbody>
                  {fleet.rows.map((row) => (
                    <tr key={row.id} className="border-t border-border/60 align-top">
                      <td className="py-1 pr-2">
                        <span className="font-mono">{row.id}</span>
                        <span className="mt-0.5 block text-[10px] text-muted-foreground">{row.url || "—"}</span>
                      </td>
                      <td className="py-1 pr-2">
                        <Badge variant={statusVariant(row.status)} className={statusClass(row.status)}>
                          {row.status}
                        </Badge>
                      </td>
                      <td className="py-1 pr-2 font-mono">{row.configured.join(", ") || "—"}</td>
                      <td className={`py-1 pr-2 font-mono ${row.mismatch ? "text-destructive" : ""}`}>
                        {row.live.join(", ") || "—"}
                      </td>
                      <td className="py-1">{row.vram || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(fleet.degraded ?? []).length > 0 ? (
              <ul className="list-disc pl-4 text-amber-500">
                {fleet.degraded.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
            {fleet.blockers.length > 0 ? (
              <ul className="list-disc pl-4 text-destructive">
                {fleet.blockers.map((b) => (
                  <li key={b}>{b}</li>
                ))}
              </ul>
            ) : null}
          </>
        ) : (
          <p className="text-muted-foreground">未探。</p>
        )}
      </CardContent>
    </Card>
  );
}
