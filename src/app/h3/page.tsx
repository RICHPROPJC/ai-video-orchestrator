import { H3PlanCard } from "@/components/h3-plan-card";
import { clinicH3Plans, H3_KEYFRAME_STATIONS, H3_LANES } from "@/lib/studio/h3-slots";

export const dynamic = "force-dynamic";

export default function H3Page() {
  const { hold, hop } = clinicH3Plans();
  return (
    <main className="mx-auto max-w-[1100px] space-y-6 px-4 py-8 md:px-8">
      <header className="space-y-2">
        <p className="text-[11px] tracking-[0.22em] text-muted-foreground">SLATECREW · H3 四線</p>
        <h1 className="font-heading text-2xl">One 鏡, one H3 generate</h1>
        <p className="max-w-2xl text-sm leading-relaxed text-muted-foreground">
          Layout → stills → audio → motion feed one submit. Audio is this shot&apos;s wav in{" "}
          <code>ref_audio_0</code> (one AuK take, even 全句). 0% and 100% are our U1.5 stills. If
          generate eats the previous last frame and misses the set keyframe, retune visual wiring —
          never TTS.
        </p>
        <p className="text-xs text-muted-foreground">
          {H3_LANES.join(" → ")} · stations {H3_KEYFRAME_STATIONS.map((s) => s.at).join(" / ")} · 3
          audio + 3 photo + 3 video slots
        </p>
        <p className="text-xs">
          <a className="text-primary underline" href="/">
            ← 開麥拉組 floor
          </a>
          <span className="text-muted-foreground"> · </span>
          <a className="text-primary underline" href="/spatial">
            空間閘
          </a>
        </p>
      </header>
      <div className="grid gap-4 lg:grid-cols-2">
        <H3PlanCard title="Hold · same world, prev last inspect_only" plan={hold} />
        <H3PlanCard title="Hop · street → product, prev last forbidden" plan={hop} />
      </div>
    </main>
  );
}
