import { storyboardItems } from "@/lib/studio/keyframe-rels";
import type { JobRecord } from "@/lib/studio/types";

const media = (id: string, rel: string) => `/api/media/${encodeURIComponent(id)}/${rel.split("/").map(encodeURIComponent).join("/")}`;

function Gallery({ jobId, items }: { jobId: string; items: { rel: string; label: string }[] }) {
  return <div className="grid gap-3 sm:grid-cols-2">{items.map((item) => (
    <figure key={item.rel} className="overflow-hidden rounded-lg border bg-black">
      <a href={media(jobId, item.rel)} target="_blank" rel="noreferrer" aria-label={`開啟大圖：${item.label}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img loading="lazy" src={`${media(jobId, item.rel)}?preview=1`} alt={item.label} className="max-h-64 w-full object-contain" />
      </a>
      <figcaption className="px-2 py-1 text-xs text-muted-foreground">{item.label}</figcaption>
    </figure>
  ))}</div>;
}

export function StoryboardPanel({ job }: { job: JobRecord | null }) {
  const cells = storyboardItems(job?.callSheet?.storyboard ?? [], job?.id ?? "");
  const boards = [...new Set(cells.flatMap((c) => c.board ? [c.board] : []))];
  return <div className="mt-3 min-h-48 space-y-3">
    <p className="text-sm font-medium">分鏡板與切格</p>
    {!job || !cells.length ? <p className="text-sm text-muted-foreground">分鏡未交付：文字鏡頭表唔算可見分鏡板。</p> : <>
      {boards.length > 0 && <Gallery jobId={job.id} items={boards.map((rel, i) => ({ rel, label: `分鏡板 ${i + 1}` }))} />}
      <Gallery jobId={job.id} items={cells} />
    </>}
    {!!job?.outputs.stills?.length && <>
      <p className="pt-3 text-sm font-medium">鍵格</p>
      <Gallery jobId={job.id} items={job.outputs.stills.map((rel) => ({ rel, label: rel }))} />
    </>}
  </div>;
}

export function ShotAudio({ job }: { job: JobRecord | null }) {
  const shots = job?.callSheet?.shots ?? [];
  if (!job || shots.length === 0) return null;
  return <div className="space-y-2" aria-label="逐鏡音頻">
    <p className="text-sm font-medium">逐鏡音頻</p>
    {shots.map((shot) => <div key={shot.id} className="flex flex-wrap items-center gap-2 text-xs">
      <span className="w-12 font-mono text-primary">{shot.id}</span>
      <span className="w-10 text-muted-foreground">{shot.dialogue.trim() ? "對白" : "靜音"}</span>
      <audio aria-label={`${shot.id} 音頻`} controls preload="none" src={media(job.id, `audio/${shot.id}.wav`)} className="h-8 min-w-48 flex-1" />
      {shot.dialogue.trim() && <span className="text-muted-foreground">{shot.dialogue}</span>}
    </div>)}
  </div>;
}
