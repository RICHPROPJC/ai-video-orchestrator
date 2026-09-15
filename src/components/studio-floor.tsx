"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "cn";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { type JobEvent, type JobRecord } from "@/lib/studio/types";
import { CREW, FLOOR, whoLine } from "@/lib/studio/crew";
import type { FloorTab } from "@/lib/studio/floor-tab";
import type { DoctorReport } from "@/lib/studio/doctor";
import type { FleetReport } from "@/lib/studio/fleet";
import { FleetRack } from "@/components/fleet-rack";
import { ShotTruth } from "@/components/shot-truth";
import { H3PlanCard } from "@/components/h3-plan-card";
import { clinicH3Plans } from "@/lib/studio/h3-slots";
import { Clapperboard, Film, Lock, Upload } from "lucide-react";

const EXAMPLES = [
  "重生得到系統做國家領導人。攻心計，軟硬手。坦克／飛機／槍／導彈／無人機。EP01 第一場 SC01，約 300 秒一集、一場一 hop。",
  "雨夜茶餐廳，阿月同阿衡重逢。阿月伸手擋門，阿衡行近，對白：「你仲記得個門口個燈？」交一支 12 秒片。",
  "Night rooftop in Mong Kok. Two people walk to the rail. Hands on wet metal. Line: stay.",
];

function media(id: string, rel?: string) {
  if (!rel) return "";
  return `/api/media/${id}/${rel}`;
}

export function StudioFloor({
  initialJob,
  initialEvents,
  recents,
  initialTab,
}: {
  initialJob: JobRecord | null;
  initialEvents: JobEvent[];
  recents: JobRecord[];
  initialTab: FloorTab;
}) {
  const [brief, setBrief] = useState(initialJob?.input.brief || EXAMPLES[0] || "");
  const [duration, setDuration] = useState(String(initialJob?.input.durationSec ?? 12));
  const [aspect, setAspect] = useState(initialJob?.input.aspect ?? "16:9");
  const [language, setLanguage] = useState(initialJob?.input.language ?? "auto");
  const [job, setJob] = useState<JobRecord | null>(initialJob);
  const [events, setEvents] = useState<JobEvent[]>(initialEvents);
  const [rack, setRack] = useState<DoctorReport | null>(null);
  const [fleet, setFleet] = useState<FleetReport | null>(null);
  const [probingFleet, setProbingFleet] = useState(false);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; modality: string; score: number; text: string; shotId?: string }[] | null>(null);
  const tab = initialTab;
  const logRef = useRef<HTMLDivElement>(null);

  const probeNow = useCallback(() => {
    setProbingFleet(true);
    void Promise.all([
      fetch("/api/rack").then((r) => r.json() as Promise<DoctorReport>),
      fetch("/api/fleet").then((r) => r.json() as Promise<FleetReport>),
    ])
      .then(([d, f]) => {
        setRack(d);
        setFleet(f);
      })
      .catch(() => {
        setRack(null);
        setFleet(null);
      })
      .finally(() => setProbingFleet(false));
  }, []);

  useEffect(() => {
    probeNow();
  }, [probeNow]);

  useEffect(() => {
    if (!job?.id) return;
    let stop = false;
    const src = new EventSource(`/api/jobs/${job.id}/events`);
    src.addEventListener("log", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as JobEvent;
      setEvents((prev) => (prev.some((p) => p.ts === ev.ts && p.message === ev.message) ? prev : [...prev, ev]));
    });
    src.addEventListener("job", (e) => {
      setJob(JSON.parse((e as MessageEvent).data) as JobRecord);
    });
    const poll = window.setInterval(async () => {
      if (stop) return;
      const res = await fetch(`/api/jobs/${job.id}`, { cache: "no-store" });
      if (!res.ok) return;
      const data = (await res.json()) as JobRecord & { events?: JobEvent[] };
      setJob(data);
      if (data.events?.length) setEvents(data.events);
      if (data.status === "locked" || data.status === "failed" || data.status === "blocked") {
        window.clearInterval(poll);
      }
    }, 1000);
    return () => {
      stop = true;
      src.close();
      window.clearInterval(poll);
    };
  }, [job?.id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  const running = job?.status === "running" || job?.status === "queued";

  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="border-b border-border/80">
        <div className="mx-auto flex max-w-[1400px] items-center justify-between gap-4 px-4 py-4 md:px-8">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-md bg-primary text-primary-foreground">
              <Clapperboard className="size-5" />
            </div>
            <div>
              <p className="font-heading text-lg tracking-[0.22em]">SLATECREW</p>
              <p className="text-xs text-muted-foreground">開麥拉組 · 交付級影片 agent team</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-[11px] tracking-wider text-muted-foreground sm:flex">
            <span>U1.5</span>
            <span className="text-primary">/</span>
            <span>H3</span>
            <span className="text-primary">/</span>
            <span>Qwen 27B</span>
            <span className="text-primary">/</span>
            <span>SenseVoice</span>
            <span className="text-primary">/</span>
            <span>Blender IK</span>
          </div>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1400px] gap-4 px-4 py-6 md:px-8 lg:grid-cols-[340px_minmax(0,1fr)]">
        <section className="space-y-4">
          <Card className="bg-card/80">
            <CardHeader className="border-b">
              <CardTitle>開新 slate</CardTitle>
              <p className="text-muted-foreground text-xs leading-relaxed">
                Brief 入去，何晴可以 dispatch 去阿圖（分鏡專職）。信封只裝呢份 slate，vault / embed / rerank 唔撈舊 project。故事＝分鏡＝剪接。
              </p>
            </CardHeader>
            <CardContent>
              <form action="/api/jobs" method="post" encType="multipart/form-data" className="space-y-3">
                <input type="hidden" name="_redirect" value="1" />
                <input type="hidden" name="aspect" value={aspect} />
                <input type="hidden" name="language" value={language} />
                <input type="hidden" name="durationSec" value={duration} />
                <Textarea
                  name="brief"
                  required
                  value={brief}
                  onChange={(e) => setBrief(e.target.value)}
                  className="min-h-36 text-[15px] leading-relaxed"
                />
                <div className="flex flex-wrap gap-2">
                  {EXAMPLES.map((ex) => (
                    <button
                      key={ex}
                      type="button"
                      className={cn(buttonVariants({ variant: "outline", size: "xs" }))}
                      onClick={() => setBrief(ex)}
                    >
                      {ex.slice(0, 10)}…
                    </button>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <label className="space-y-1 text-xs text-muted-foreground">
                    秒數
                    <Input name="durationSec" value={duration} onChange={(e) => setDuration(e.target.value)} />
                  </label>
                  <label className="space-y-1 text-xs text-muted-foreground">
                    畫面
                    <Select value={aspect} onValueChange={(v) => v && setAspect(v)}>
                      <SelectTrigger className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="16:9">16:9 橫</SelectItem>
                        <SelectItem value="9:16">9:16 直</SelectItem>
                        <SelectItem value="1:1">1:1</SelectItem>
                      </SelectContent>
                    </Select>
                  </label>
                </div>
                <label className="space-y-1 text-xs text-muted-foreground">
                  語言
                  <Select value={language} onValueChange={(v) => v && setLanguage(v)}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="auto">自動</SelectItem>
                      <SelectItem value="yue">粵語</SelectItem>
                      <SelectItem value="zh-Hant">繁中</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <label className="flex cursor-pointer items-center justify-between rounded-lg border border-dashed border-border px-3 py-2 text-xs">
                  <span className="flex items-center gap-2 text-muted-foreground">
                    <Upload className="size-3.5" />
                    可選：上載 clone 聲帶 WAV
                  </span>
                  <input type="file" name="clone" accept="audio/wav,audio/*" />
                </label>
                <button
                  type="submit"
                  disabled={!fleet?.ready}
                  className={cn(buttonVariants({ size: "lg" }), "w-full")}
                >
                  {fleet && !fleet.ready ? "機未齊 · 唔開工" : "開工交片"}
                </button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  CLI 同等：<code className="text-primary">npm run slatecrew -- produce &quot;brief&quot;</code>
                </p>
              </form>
              {recents.length > 0 ? (
                <div className="mt-4 space-y-1 border-t pt-3">
                  <p className="text-[11px] tracking-wider text-muted-foreground">近期 slate</p>
                  {recents.map((item) => (
                    <a
                      key={item.id}
                      href={`/?slate=${item.id}`}
                      className="flex items-center justify-between rounded-md px-2 py-1 text-xs hover:bg-muted"
                    >
                      <span className="font-mono text-primary">{item.slate}</span>
                      <span className="text-muted-foreground">{item.status}</span>
                    </a>
                  ))}
                </div>
              ) : null}
            </CardContent>
          </Card>

          <FleetRack fleet={fleet} probing={probingFleet} onProbe={probeNow} />

          <Card>
            <CardHeader className="border-b">
              <CardTitle>Rack · checkpoint</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs">
              <p className="text-muted-foreground">
                ffmpeg {rack?.ffmpeg ? "UP" : "?"} · blender {rack?.blender ? "UP" : "script-only"}
              </p>
              <form
                key={rack?.config.stills.checkpoint ?? "rack"}
                className="space-y-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const stills = String(new FormData(form).get("stills") ?? "");
                  const motion = String(new FormData(form).get("motion") ?? "");
                  void fetch("/api/rack", {
                    method: "PUT",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({
                      stills: { checkpoint: stills },
                      motion: { checkpoint: motion },
                    }),
                  }).then(() => fetch("/api/rack").then((r) => r.json()).then(setRack));
                }}
              >
                <label className="block text-muted-foreground">
                  U1.5 checkpoint
                  <Input name="stills" defaultValue={rack?.config.stills.checkpoint} className="mt-1" />
                </label>
                <label className="block text-muted-foreground">
                  H3 checkpoint
                  <Input name="motion" defaultValue={rack?.config.motion.checkpoint} className="mt-1" />
                </label>
                <button type="submit" className={cn(buttonVariants({ size: "sm" }))}>
                  換模型
                </button>
              </form>
              <p className="text-muted-foreground leading-relaxed">
                唔使新 API。開你平時嗰個 Comfy，workflow 用官方 U1.5 / MiniMax H3 template，Export API 覆蓋
                <code> workflows/*.api.json</code>。Comfy 熄咗就 studio fallback，QC 閘照行。
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>點解係呢套 stack</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>搜完之後係<b className="text-foreground">組合已有最好嘅件</b>，唔係再發明一個生圖引擎。</p>
              <ul className="space-y-1.5">
                <li><b className="text-foreground">ComfyUI</b> 官方 /prompt · 你而家嘅 U1.5 + H3 圖</li>
                <li><b className="text-foreground">ViMax</b> dispatch 去分鏡專職 + narrative plan；RAG 只喺呢份 slate</li>
                <li><b className="text-foreground">Montaj</b> CLI = TUI = Web 同一套 command</li>
                <li><b className="text-foreground">MoneyPrinterTurbo</b> checkpoint / 分段閘口</li>
                <li><b className="text-foreground">Qwen 27B + SenseVoice</b> 你指定嘅聲畫 QC</li>
                <li><b className="text-foreground">Blender IK</b> 走位、手手腳腳</li>
              </ul>
            </CardContent>
          </Card>
        </section>

        <section className="space-y-4">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between border-b">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <Film className="size-4 text-primary" />
                  {job?.slate ?? "未開 slate"}
                </CardTitle>
              <p className="text-muted-foreground mt-1 text-xs">
                  {job?.callSheet?.title ?? "等 brief"} · {job?.status ?? "idle"}
                  {job?.continuity?.cut?.length ? ` · ${job.continuity.cut.join("→")}` : ""}
                </p>
              </div>
              {job?.status === "locked" ? (
                <Badge className="bg-primary text-primary-foreground">
                  <Lock className="size-3" /> PICTURE LOCK
                </Badge>
              ) : job ? (
                <Badge variant="outline">{job.status}</Badge>
              ) : null}
            </CardHeader>
            <CardContent className="space-y-4">
              <Progress value={job?.progress ?? 0} />
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-4">
                {FLOOR.map((id) => {
                  const who = CREW[id];
                  const active = job?.currentAgent === id;
                  const logs = events.filter((e) => e.agent === id);
                  const passed = logs.some((e) => e.level === "pass");
                  const failed = logs.some((e) => e.level === "fail");
                  return (
                    <div
                      key={id}
                      title={who.thinking}
                      className={`rounded-lg border px-3 py-2 ${
                        active
                          ? "border-primary bg-primary/10"
                          : failed
                            ? "border-destructive/40"
                            : passed
                              ? "border-emerald-500/40"
                              : "border-border"
                      }`}
                    >
                      <p className="text-[10px] tracking-widest text-muted-foreground">{who.en}</p>
                      <p className="text-sm font-medium">
                        {who.name}／{who.job}
                      </p>
                      <p className="line-clamp-2 text-[11px] text-muted-foreground">{who.thinking}</p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <div>
              <div className="flex flex-wrap gap-1 rounded-lg bg-muted p-1">
                {(
                  [
                    ["board", "分鏡"],
                    ["plan", "計劃"],
                    ["block", "走位"],
                    ["h3", "H3"],
                    ["qc", "QC"],
                    ["lock", "成片"],
                  ] as const
                ).map(([id, label]) => {
                  const q = new URLSearchParams();
                  if (job?.id) q.set("slate", job.id);
                  if (id !== "board") q.set("tab", id);
                  const href = `/?${q.toString()}`;
                  return (
                    <a
                      key={id}
                      href={href}
                      className={cn(
                        buttonVariants({ variant: tab === id ? "default" : "ghost", size: "sm" }),
                      )}
                    >
                      {label}
                    </a>
                  );
                })}
              </div>
              {tab === "board" ? (
                <div className="mt-3 min-h-48 space-y-3">
                  {job?.continuity ? (
                    <p className="text-xs text-muted-foreground">
                      Cut = boards：{job.continuity.cut.join(" → ")} · 同一 SH id，唔另開場。
                    </p>
                  ) : null}
                  <div className="grid gap-3 sm:grid-cols-2">
                  {(job?.outputs.stills ?? []).length === 0 ? (
                    <Empty label="未有 stills。阿圖鎖分鏡之後阿靜先出圖。" />
                  ) : (
                    job?.outputs.stills.map((rel) => (
                      <figure key={rel} className="overflow-hidden rounded-lg border bg-black">
                        {/* eslint-disable-next-line @next/next/no-img-element */}
                        <img src={media(job.id, rel)} alt={rel} className="w-full" />
                        <figcaption className="px-2 py-1 text-[11px] text-muted-foreground">{rel}</figcaption>
                      </figure>
                    ))
                  )}
                  </div>
                </div>
              ) : null}
              {tab === "plan" ? (
                <div className="mt-3 min-h-48 space-y-3 text-sm">
                  <p className="text-sm font-medium">計劃 · narrative plan</p>
                  <p className="text-xs text-muted-foreground">
                    ViMax 式 DAG。JSON 存在 <code>data/jobs/{job?.slate ?? "SLATE"}/</code>。Embed / rerank 只讀呢份 vault.json。
                  </p>
                  {job?.narrativePlan ? (
                    <p className="font-mono text-xs leading-relaxed">
                      {job.narrativePlan.dag.join(" → ")}
                    </p>
                  ) : (
                    <Empty label="未有 narrative plan。阿圖收 packet 之後會寫。" />
                  )}
                  {job?.vault ? (
                    <p className="text-xs text-muted-foreground">
                      Vault {job.vault.docs} docs · isolated ·{" "}
                      {Object.entries(job.vault.modalities)
                        .map(([k, v]) => `${k}:${v}`)
                        .join(" · ")}
                    </p>
                  ) : null}
                  {job?.id ? (
                    <form
                      className="flex flex-wrap gap-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (!job.id || !query.trim()) return;
                        void fetch(`/api/jobs/${job.id}/recall?q=${encodeURIComponent(query)}`)
                          .then((r) => r.json())
                          .then((d: { hits?: typeof hits }) => setHits(d.hits ?? []));
                      }}
                    >
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="喺呢份 slate rerank…"
                        className="max-w-xs"
                      />
                      <button type="submit" className={cn(buttonVariants({ size: "sm" }))} disabled={running && !job.vault}>
                        Recall
                      </button>
                    </form>
                  ) : null}
                  {hits ? (
                    <ul className="space-y-1 font-mono text-[11px]">
                      {hits.length === 0 ? <li className="text-muted-foreground">呢份 vault 冇 hit。</li> : null}
                      {hits.map((h) => (
                        <li key={h.id}>
                          {h.score.toFixed(2)} · {h.modality} · {h.shotId ?? "—"} · {h.text}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </div>
              ) : null}
              {tab === "block" ? (
                <div className="mt-3 min-h-48">
                {job?.outputs.blockingPreview ? (
                  <div className="space-y-3">
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={media(job.id, job.outputs.blockingPreview)}
                      alt="blocking"
                      className="w-full rounded-lg border"
                    />
                    <p className="text-xs text-muted-foreground">
                      Blender script：{job.outputs.blenderScript} · 角色移動 + 手手腳腳 IK。本機有 Blender 會嘗試 headless 跑。
                    </p>
                  </div>
                ) : (
                  <Empty label="Layout agent 未出 mark。" />
                )}
                </div>
              ) : null}
              {tab === "qc" ? (
                <div className="mt-3 min-h-48 space-y-3">
                  <ShotTruth job={job} events={events} />
                  <div className="grid gap-3 md:grid-cols-2">
                  <QcCard title="SenseVoice 聲檢" data={job?.soundQc} />
                  <QcCard title="畫檢（stills）" data={job?.pictureQcStills} />
                  <QcCard title="畫檢（video）" data={job?.pictureQcVideo} />
                  <Card>
                    <CardHeader>
                      <CardTitle>Providers</CardTitle>
                    </CardHeader>
                    <CardContent className="space-y-1 text-xs">
                      {job?.providers
                        ? Object.entries(job.providers).map(([k, v]) => (
                            <p key={k}>
                              <span className="text-muted-foreground">{k}</span> · {v}
                            </p>
                          ))
                        : "未跑"}
                    </CardContent>
                  </Card>
                  </div>
                </div>
              ) : null}
              {tab === "h3" ? (
                <div className="mt-3 min-h-48 space-y-3">
                  <p className="text-xs text-muted-foreground">
                    一鏡一 generate · 0%/100% = 呢鏡 U1.5 still · miss kf 只改視覺 wiring，唔調 TTS ·{" "}
                    <a className="text-primary underline" href="/h3">
                      /h3
                    </a>
                  </p>
                  {(() => {
                    const { hold, hop } = clinicH3Plans();
                    return (
                      <div className="grid gap-3 lg:grid-cols-2">
                        <H3PlanCard title="Hold · same world" plan={hold} />
                        <H3PlanCard title="Hop · prev last forbidden" plan={hop} />
                      </div>
                    );
                  })()}
                </div>
              ) : null}
              {tab === "lock" ? (
                <div className="mt-3 min-h-48">
                {job?.outputs.pictureLock ? (
                  <div className="space-y-3">
                    <p className="text-sm font-medium">成片 · picture lock</p>
                    <video
                      key={job.outputs.pictureLock}
                      className="w-full rounded-lg border bg-black"
                      controls
                      src={media(job.id, job.outputs.pictureLock)}
                    />
                    <div className="flex flex-wrap gap-2 text-xs">
                      <a className="text-primary underline" href={media(job.id, job.outputs.pictureLock)}>
                        下載 MP4
                      </a>
                      {job.outputs.qcReport ? (
                        <a className="text-primary underline" href={media(job.id, job.outputs.qcReport)}>
                          QC JSON
                        </a>
                      ) : null}
                      {job.outputs.callSheet ? (
                        <a className="text-primary underline" href={media(job.id, job.outputs.callSheet)}>
                          Call sheet
                        </a>
                      ) : null}
                      {job.outputs.continuity ? (
                        <a className="text-primary underline" href={media(job.id, job.outputs.continuity)}>
                          Continuity
                        </a>
                      ) : null}
                      {job.outputs.narrativePlan ? (
                        <a className="text-primary underline" href={media(job.id, job.outputs.narrativePlan)}>
                          Narrative plan
                        </a>
                      ) : null}
                      {job.outputs.vault ? (
                        <a className="text-primary underline" href={media(job.id, job.outputs.vault)}>
                          Vault JSON
                        </a>
                      ) : null}
                      {job.outputs.blenderScript ? (
                        <a className="text-primary underline" href={media(job.id, job.outputs.blenderScript)}>
                          blocking.py
                        </a>
                      ) : null}
                    </div>
                  </div>
                ) : (
                  <Empty label="未有 picture lock。" />
                )}
                </div>
              ) : null}
            </div>

            <Card className="min-h-72">
              <CardHeader className="border-b">
                <CardTitle>場地對講</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[420px]">
                  <div ref={logRef} className="space-y-2 p-3 font-mono text-[11px] leading-relaxed">
                    {events.length === 0 ? (
                      <p className="text-muted-foreground">等開工。Agent 會喺呢度報位。</p>
                    ) : (
                      events.map((e, i) => (
                        <p key={`${e.ts}-${i}`}>
                          <span className="text-primary">{e.agent === "system" ? "system" : whoLine(e.agent)}</span>{" "}
                          <span className={e.level === "fail" ? "text-destructive" : e.level === "pass" ? "text-emerald-400" : "text-muted-foreground"}>
                            {e.level}
                          </span>{" "}
                          {e.message}
                        </p>
                      ))
                    )}
                  </div>
                </ScrollArea>
              </CardContent>
            </Card>
          </div>
        </section>
      </main>
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">{label}</p>;
}

function QcCard({
  title,
  data,
}: {
  title: string;
  data: { pass?: boolean; provider?: string; issues?: { detail: string }[]; notes?: string } | undefined;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center justify-between gap-2">
          {title}
          {data ? <Badge variant={data.pass ? "default" : "destructive"}>{data.pass ? "PASS" : "HOLD"}</Badge> : null}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-2 text-xs text-muted-foreground">
        {data ? (
          <>
            <p>{data.provider}</p>
            {data.notes ? <p>{data.notes}</p> : null}
            <ul className="list-disc pl-4">
              {(data.issues ?? []).map((i) => (
                <li key={i.detail}>{i.detail}</li>
              ))}
            </ul>
          </>
        ) : (
          "未檢"
        )}
      </CardContent>
    </Card>
  );
}
