"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AGENT_META, type AgentId, type JobEvent, type JobRecord } from "@/lib/studio/types";
import { Clapperboard, Film, Lock, Upload } from "lucide-react";

const EXAMPLES = [
  "雨夜茶餐廳，阿月同阿衡重逢。阿月伸手擋門，阿衡行近，對白：「你仲記得個門口個燈？」交一支 12 秒片。",
  "Night rooftop in Mong Kok. Two people walk to the rail. Hands on wet metal. Line: stay.",
  "產品特寫：銅壺放喺濕花崗岩，手入畫扶住壺嘴，腳唔好入鏡。",
];

function media(id: string, rel?: string) {
  if (!rel) return "";
  return `/api/media/${id}/${rel}`;
}

export function StudioFloor() {
  const [brief, setBrief] = useState(EXAMPLES[0] ?? "");
  const [duration, setDuration] = useState("12");
  const [aspect, setAspect] = useState("16:9");
  const [language, setLanguage] = useState("auto");
  const [clone, setClone] = useState<File | null>(null);
  const [job, setJob] = useState<JobRecord | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!job?.id) return;
    setEvents([]);
    const src = new EventSource(`/api/jobs/${job.id}/events`);
    src.addEventListener("log", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as JobEvent;
      setEvents((prev) => [...prev, ev]);
    });
    src.addEventListener("job", (e) => {
      setJob(JSON.parse((e as MessageEvent).data) as JobRecord);
    });
    src.onerror = () => src.close();
    return () => src.close();
  }, [job?.id]);

  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [events.length]);

  async function produce() {
    setBusy(true);
    setError(null);
    setEvents([]);
    const form = new FormData();
    form.set("brief", brief);
    form.set("durationSec", duration);
    form.set("aspect", aspect);
    form.set("language", language);
    if (clone) form.set("clone", clone);
    const res = await fetch("/api/jobs", { method: "POST", body: form });
    const data = (await res.json()) as JobRecord & { error?: string };
    if (!res.ok) {
      setError(data.error ?? "開 job 失敗");
      setBusy(false);
      return;
    }
    setJob(data);
    setBusy(false);
  }

  const running = job?.status === "running" || job?.status === "queued";
  const desks = useMemo(() => Object.entries(AGENT_META) as [AgentId, (typeof AGENT_META)[AgentId]][], []);

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
            <span>MARS-8B</span>
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
                Brief 入去，十一張檯會自己分場、走位、生圖、生片、配音同雙重 QC。未過閘唔 stamp picture lock。
              </p>
            </CardHeader>
            <CardContent className="space-y-3">
              <Textarea
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                className="min-h-36 text-[15px] leading-relaxed"
              />
              <div className="flex flex-wrap gap-2">
                {EXAMPLES.map((ex) => (
                  <Button key={ex} variant="outline" size="xs" onClick={() => setBrief(ex)}>
                    {ex.slice(0, 10)}…
                  </Button>
                ))}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <label className="space-y-1 text-xs text-muted-foreground">
                  秒數
                  <Input value={duration} onChange={(e) => setDuration(e.target.value)} />
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
                  {clone ? clone.name : "可選：上載 clone 聲帶 WAV"}
                </span>
                <input
                  type="file"
                  accept="audio/wav,audio/*"
                  className="hidden"
                  onChange={(e) => setClone(e.target.files?.[0] ?? null)}
                />
              </label>
              {error ? <p className="text-destructive text-sm">{error}</p> : null}
              <Button className="w-full" size="lg" onClick={() => void produce()} disabled={busy || running}>
                {running ? "場地開工緊…" : "開工交片"}
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                CLI 同等：<code className="text-primary">npm run slatecrew -- produce &quot;brief&quot;</code>
              </p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>點解係呢套 stack</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-xs leading-relaxed text-muted-foreground">
              <p>開源交片向影片 agent，我哋對齊你而家跑緊嘅模型，而唔係泛用短視頻流水線。</p>
              <ul className="space-y-1.5">
                <li><b className="text-foreground">U1.5</b> SenseNova-U1.5-8B-MoT 生圖 / 4K 編輯</li>
                <li><b className="text-foreground">H3</b> MiniMax H3 全模態生片（FL2VA / Ref2VA）</li>
                <li><b className="text-foreground">MARS-8B</b> SenseNova-MARS 畫檢（手腳、身份、構圖）</li>
                <li><b className="text-foreground">SenseVoice</b> ASR + 情緒 + 聲事件 QC</li>
                <li><b className="text-foreground">CosyVoice 3</b> TTS + 聲線 clone</li>
                <li><b className="text-foreground">Blender</b> 場地 mark + 手腳 IK，Eevee 快出</li>
              </ul>
              <p>
                OpenDirector / MoneyPrinterTurbo / Montaj 係好參考，但冇呢條 QC 閘同 Blender 走位。呢度 studio fallback 永遠可跑；接上 endpoint 就燒真模型。
              </p>
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
                {desks.map(([id, meta]) => {
                  const active = job?.currentAgent === id;
                  const logs = events.filter((e) => e.agent === id);
                  const passed = logs.some((e) => e.level === "pass");
                  const failed = logs.some((e) => e.level === "fail");
                  return (
                    <div
                      key={id}
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
                      <p className="text-[10px] tracking-widest text-muted-foreground">{meta.en}</p>
                      <p className="text-sm font-medium">{meta.label}</p>
                      <p className="text-[11px] text-muted-foreground">{meta.desk}</p>
                    </div>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          <div className="grid gap-4 xl:grid-cols-[1fr_320px]">
            <Tabs defaultValue="board">
              <TabsList>
                <TabsTrigger value="board">分鏡</TabsTrigger>
                <TabsTrigger value="block">走位</TabsTrigger>
                <TabsTrigger value="qc">QC</TabsTrigger>
                <TabsTrigger value="lock">成片</TabsTrigger>
              </TabsList>
              <TabsContent value="board">
                <div className="grid gap-3 sm:grid-cols-2">
                  {(job?.outputs.stills ?? []).length === 0 ? (
                    <Empty label="未有 stills。開工之後 U1.5 / studio painter 會出 lock frame。" />
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
              </TabsContent>
              <TabsContent value="block">
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
              </TabsContent>
              <TabsContent value="qc">
                <div className="grid gap-3 md:grid-cols-2">
                  <QcCard title="SenseVoice 聲檢" data={job?.soundQc} />
                  <QcCard title="MARS-8B 畫檢（stills）" data={job?.pictureQcStills} />
                  <QcCard title="MARS-8B 畫檢（video）" data={job?.pictureQcVideo} />
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
              </TabsContent>
              <TabsContent value="lock">
                {job?.outputs.pictureLock ? (
                  <div className="space-y-3">
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
              </TabsContent>
            </Tabs>

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
                          <span className="text-primary">{e.agent}</span>{" "}
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
