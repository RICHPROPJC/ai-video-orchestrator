import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  formatH3Plan,
  H3_KEYFRAME_STATIONS,
  H3_LANES,
  H3_SLOT_CAP,
  type H3ShotPlan,
  type H3SlotKind,
} from "@/lib/studio/h3-slots";

function SlotGrid({ plan }: { plan: H3ShotPlan }) {
  const kinds: H3SlotKind[] = ["audio", "photo", "video"];
  const bind = (kind: H3SlotKind, i: number) =>
    kind === "audio" ? `ref_audio_${i}` : kind === "photo" ? `ref_image_${i}` : `ref_video_${i}`;
  return (
    <div className="grid gap-2 sm:grid-cols-3">
      {kinds.map((kind) => (
        <div key={kind} className="space-y-1">
          <p className="text-[10px] tracking-widest text-muted-foreground uppercase">
            {kind} · {plan.slots[kind].length}/{H3_SLOT_CAP[kind]}
          </p>
          {Array.from({ length: H3_SLOT_CAP[kind] }, (_, i) => {
            const fill = plan.slots[kind].find((s) => s.index === i);
            return (
              <div
                key={`${kind}-${i}`}
                className={
                  fill
                    ? "rounded-md border border-primary/40 bg-primary/5 px-2 py-1.5"
                    : "rounded-md border border-dashed px-2 py-1.5 text-muted-foreground"
                }
              >
                <p className="font-mono text-[10px]">{bind(kind, i)}</p>
                <p className="text-[11px] leading-snug">
                  {fill ? `${fill.file}` : "empty"}
                </p>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

export function H3PlanCard({
  title,
  plan,
}: {
  title: string;
  plan: H3ShotPlan;
}) {
  const hop = plan.keyframes.prevLastFrame.policy === "forbidden";
  return (
    <Card className={hop ? "border-destructive/40" : "border-emerald-500/40"}>
      <CardHeader className="border-b">
        <CardTitle className="flex items-center justify-between gap-2 text-base">
          {title}
          <Badge variant={hop ? "destructive" : "default"}>{plan.keyframes.prevLastFrame.policy}</Badge>
        </CardTitle>
        <p className="text-muted-foreground text-xs">
          {plan.shotId} · generate={plan.generation} · sampler={plan.sampler} · fl2va loaded
        </p>
      </CardHeader>
      <CardContent className="space-y-4 pt-4">
        <ol className="grid gap-2 sm:grid-cols-4">
          {H3_LANES.map((lane, i) => (
            <li key={lane} className="rounded-md border px-2 py-2">
              <p className="text-[10px] tracking-widest text-muted-foreground">
                {i + 1} · {lane}
              </p>
              <p className="mt-1 text-[11px] leading-snug">{plan.lanes[lane]}</p>
            </li>
          ))}
        </ol>
        <div className="grid gap-2 sm:grid-cols-3">
          {H3_KEYFRAME_STATIONS.map((s) => (
            <div key={s.at} className="rounded-md border px-2 py-2">
              <p className="font-mono text-sm">{s.at}</p>
              <p className="text-[11px] leading-snug">{s.take}</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{s.node}</p>
              <p className="text-[10px] text-destructive">never {s.never}</p>
            </div>
          ))}
        </div>
        <SlotGrid plan={plan} />
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <p className="text-[10px] tracking-widest text-muted-foreground">MISS KEYFRAME → TUNE</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] leading-snug">
              {plan.missKeyframe.tune.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
          <div>
            <p className="text-[10px] tracking-widest text-muted-foreground">MISS KEYFRAME → NEVER</p>
            <ul className="mt-1 list-disc space-y-1 pl-4 text-[11px] leading-snug text-destructive">
              {plan.missKeyframe.never.map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ul>
          </div>
        </div>
        <pre className="overflow-x-auto whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-muted-foreground">
          {formatH3Plan(plan).join("\n")}
        </pre>
      </CardContent>
    </Card>
  );
}
