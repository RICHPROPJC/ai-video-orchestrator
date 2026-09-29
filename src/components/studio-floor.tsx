"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
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
import { Album } from "@/components/album";
import { BlockCanvas } from "@/components/block-canvas";
import { SessionPanel } from "@/components/session-panel";
import { ShotFeedback } from "@/components/feedback-form";
import { ShotInspector } from "@/components/shot-inspector";
import { StoryboardPanel, ShotAudio } from "@/components/episode-media";
import { Clapperboard, Film, Lock, Upload } from "lucide-react";

/** B0（Sol UI-PLAN §6）：每個工作區一句用途——入頁即知呢度做乜。 */
const TAB_NOTES: Record<FloorTab, string> = {
  album: "圖片畫簿：揀圖、比較版本、查角色／場景來源。",
  cut: "剪接：並排灰片／正片，選本段 percent 或跨鏡 span，建立重整要求。",
  h3: "剪接：並排灰片／正片，選本段 percent 或跨鏡 span，建立重整要求。（舊入口别名→剪接）",
  canvas: "H3 畫布：沿時間軸核對灰模每格／refs／空段短長——接錯即刻現形。",
  board: "分鏡：睇已交分鏡板圖，定位鏡段（文字表唔算分鏡）。",
  plan: "創作計劃：故事／聲畫安排同修改影響。",
  block: "場景走位：本任務嘅世界／機位／動作產物。",
  qc: "QC：分項結果同原證據，搵問題源頭。",
  lock: "成片：實際交付、下載，或未交付原因。",
};

const EXAMPLES = [
  "重生得到系統做國家領導人。攻心計，軟硬手。坦克／飛機／槍／導彈／無人機。EP01 第一場 SC01，約 300 秒一集、一場一 hop。",
  "雨夜茶餐廳，阿月同阿衡重逢。阿月伸手擋門，阿衡行近，對白：「你仲記得個門口個燈？」交一支 12 秒片。",
  "Night rooftop in Mong Kok. Two people walk to the rail. Hands on wet metal. Line: stay.",
];

function media(id: string, rel?: string) {
  if (!rel) return "";
  return `/api/media/${id}/${rel}`;
}

/** Chau 0927（手機回報）：更新應該只動嗰個框——內容冇變嘅 poll／SSE
 *  一律唔觸發 render（signature 相同就返 prev，React 自動 bail）。 */
function jobSig(j: JobRecord | null): string {
  if (!j) return "";
  return [
    j.updatedAt, j.status, j.progress, j.error ?? "", j.currentAgent ?? "",
    j.outputs.stills.length, j.outputs.blockout.length, j.outputs.shots.length, j.outputs.receipts.length,
    j.outputs.pictureLock ?? "", j.outputs.scenePreview ?? "",
    j.callSheet?.shots.length ?? 0, j.callSheet?.storyboard?.length ?? 0,
  ].join("|");
}

function rowsSig(rows: JobRecord[]): string {
  return rows.map((r) => `${r.id}:${r.status}:${r.progress}:${r.updatedAt}`).join("|");
}

function eventsChanged(prev: JobEvent[], next: JobEvent[]): boolean {
  return prev.length !== next.length || prev[prev.length - 1]?.ts !== next[next.length - 1]?.ts;
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
  /** P33：新建預設空 brief——唔暗帶當前項目內容；續做係左列表獨立入口，唔經呢個表。 */
  const [brief, setBrief] = useState("");
  const [duration, setDuration] = useState(String(initialJob?.input.durationSec ?? 15));
  const [aspect, setAspect] = useState(initialJob?.input.aspect ?? "16:9");
  const [language, setLanguage] = useState(initialJob?.input.language ?? "auto");
  const [job, setJob] = useState<JobRecord | null>(initialJob);
  const [rows, setRows] = useState<JobRecord[]>(recents);
  const [events, setEvents] = useState<JobEvent[]>(initialEvents);
  const [rack, setRack] = useState<DoctorReport | null>(null);
  const [fleet, setFleet] = useState<FleetReport | null>(null);
  const [probingFleet, setProbingFleet] = useState(false);
  const [frameShot, setFrameShot] = useState("SH01");
  const [frameNote, setFrameNote] = useState("");
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<{ id: string; modality: string; score: number; text: string; shotId?: string }[] | null>(null);
  const [tab, setTab] = useState<FloorTab>(initialTab);
  const logRef = useRef<HTMLDivElement>(null);
  const [logFilter, setLogFilter] = useState<"tail" | "key" | "all">("tail");
  /** P33：手機左抽屜（同一個項目列表；入口常駐 header，唔藏頁底）。 */
  const [drawerOpen, setDrawerOpen] = useState(false);
  /** Chau 0928 追加：側欄可收埋——唔係死嘅左欄；收埋後工作區全闊（幼 rail 掣展開）。 */
  const [railOpen, setRailOpen] = useState(true);

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
    const raf = window.requestAnimationFrame(() => probeNow());
    return () => window.cancelAnimationFrame(raf);
  }, [probeNow]);

  useEffect(() => {
    let stop = false;
    const pull = () => {
      void fetch("/api/jobs", { cache: "no-store" })
        .then((r) => r.json() as Promise<{ jobs?: JobRecord[] }>)
        .then((data) => {
          const next = data.jobs;
          if (!stop && next) setRows((prev) => (rowsSig(prev) === rowsSig(next) ? prev : next));
        })
        .catch(() => undefined);
    };
    pull();
    const timer = window.setInterval(pull, 3000);
    return () => {
      stop = true;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!job?.id) return;
    const listed = rows.find((item) => item.id === job.id);
    if (!listed || listed.updatedAt < job.updatedAt) return;
    if (listed.status === job.status && listed.error === job.error && listed.updatedAt === job.updatedAt) return;
    const raf = window.requestAnimationFrame(() => {
      setJob((prev) =>
        prev && prev.id === listed.id
          ? { ...listed, callSheet: listed.callSheet?.storyboard?.length ? listed.callSheet : prev.callSheet }
          : prev,
      );
    });
    return () => window.cancelAnimationFrame(raf);
  }, [rows, job]);

  useEffect(() => {
    if (!job?.id) return;
    let stop = false;
    const src = new EventSource(`/api/jobs/${job.id}/events`);
    src.addEventListener("log", (e) => {
      const ev = JSON.parse((e as MessageEvent).data) as JobEvent;
      setEvents((prev) => (prev.some((p) => p.ts === ev.ts && p.message === ev.message) ? prev : [...prev, ev]));
    });
    src.addEventListener("job", (e) => {
      const next = JSON.parse((e as MessageEvent).data) as JobRecord;
      setJob((prev) => (prev && jobSig(prev) === jobSig(next) ? prev : next));
    });
    src.onerror = () => {
      src.close();
    };
    const poll = window.setInterval(() => {
      if (stop) return;
      void fetch(`/api/jobs/${job.id}`, { cache: "no-store" })
        .then(async (res) => {
          if (!res.ok || stop) return;
          const data = (await res.json()) as JobRecord & { events?: JobEvent[] };
          setJob((prev) => (prev && jobSig(prev) === jobSig(data) ? prev : data));
          const evs = data.events;
          if (evs?.length) setEvents((prev) => (eventsChanged(prev, evs) ? evs : prev));
          if (data.status === "locked" || data.status === "failed" || data.status === "blocked" || data.status === "boarded") {
            window.clearInterval(poll);
          }
        })
        .catch(() => undefined);
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
  /** R19-R21：分鏡模式（text-only auto-adopt 提示）——types 未有欄位，cast 讀。 */
  const storyboardMode = (job?.outputs as { storyboardMode?: string } | undefined)?.storyboardMode;

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
          {/* P33：頂部 select 退役——手機用左抽屜入口（常駐可見），桌面用左欄常駐列表。 */}
          <button
            type="button"
            className="rounded border border-border px-2 py-1.5 text-xs lg:hidden"
            onClick={() => setDrawerOpen(true)}
            aria-label="打開項目列表"
          >
            ☰ 項目
          </button>
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

      {/* P33（§1）：手機左抽屜——同一個 ProjectList，入口常駐唔藏頁底。 */}
      {drawerOpen ? (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-label="項目列表抽屜">
          <button type="button" aria-label="閂抽屜" className="absolute inset-0 bg-black/60" onClick={() => setDrawerOpen(false)} />
          <div className="absolute inset-y-0 left-0 flex w-[85%] max-w-xs flex-col gap-3 overflow-y-auto bg-background p-3 shadow-xl">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium">項目</span>
              <button type="button" className="rounded border border-border px-2 py-1" onClick={() => setDrawerOpen(false)}>
                ✕
              </button>
            </div>
            <ProjectList rows={rows} current={job?.id} tab={tab} />
          </div>
        </div>
      ) : null}

      <main
        className={cn(
          "mx-auto grid max-w-[1400px] gap-4 px-4 py-6 md:px-8",
          railOpen ? "lg:grid-cols-[340px_minmax(0,1fr)]" : "lg:grid-cols-[2.5rem_minmax(0,1fr)]",
        )}
      >
        {/* Chau 0928（臃腫回報）：版面分返層——左邊淨係項目列表，右邊項目表。
            開新 slate／機隊 rack 收 details，唔再成欄霸住。 */}
        <section className={cn("order-2 lg:order-1", railOpen ? "hidden space-y-3 lg:block" : "hidden w-full flex-col items-center pt-3 lg:flex")}>
          {railOpen ? (
            <>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between border-b">
              <CardTitle>項目</CardTitle>
              <button
                type="button"
                className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                onClick={() => setRailOpen(false)}
              >
                « 收埋
              </button>
            </CardHeader>
            {/* P33：左列表＝主要入口；列表自己捲（max-h），顯示狀態／進度／阻塞原因＋續做。 */}
            <CardContent className="max-h-[70vh] overflow-y-auto">
              <ProjectList rows={rows} current={job?.id} tab={tab} />
            </CardContent>
          </Card>
          <details className="rounded-lg border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">＋ 新建項目（生新 ID）</summary>
            <Card className="mt-2 border-0 bg-card/80">
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
                  placeholder="新項目 brief——空白開始，唔會帶入而家項目內容（續做用左列表嘅「▶ 續做」）"
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
                      <SelectItem value="zh-Hans">簡中</SelectItem>
                      <SelectItem value="en">English</SelectItem>
                    </SelectContent>
                  </Select>
                </label>
                <details className="rounded-lg border border-border px-3 py-2 text-xs text-muted-foreground">
                  <summary>同 CLI 一樣嘅旗</summary>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <label className="space-y-1">劇目<input name="drama" className="mt-1 w-full" placeholder="--drama" /></label>
                    <label className="space-y-1">集<input name="episode" className="mt-1 w-full" placeholder="EP01" /></label>
                    <label className="space-y-1">場<input name="scene" className="mt-1 w-full" placeholder="SC01" /></label>
                    <label className="space-y-1">鏡<input name="shot" className="mt-1 w-full" placeholder="SH04" /></label>
                    <label className="space-y-1">H3 graph
                      <select name="graphVariant" defaultValue="a" className="mt-1 w-full bg-background">
                        <option value="a">a</option>
                        <option value="b">b</option>
                        <option value="bkf">bkf</option>
                        <option value="c">c</option>
                      </select>
                    </label>
                    <label className="space-y-1">steps<input name="steps" className="mt-1 w-full" /></label>
                    <label className="col-span-2 space-y-1">wav 目錄<input name="wavDir" className="mt-1 w-full" /></label>
                    <label className="col-span-2 space-y-1">肖像目錄<input name="portraitsDir" className="mt-1 w-full" /></label>
                    <label className="col-span-2 space-y-1">blockout 目錄<input name="blockoutDir" className="mt-1 w-full" /></label>
                    <label className="col-span-2 space-y-1">callsheet<input name="callSheetPath" className="mt-1 w-full" /></label>
                    <label className="col-span-2 space-y-1">cast roster<input name="castRosterPath" className="mt-1 w-full" /></label>
                    <label className="space-y-1">鏡間靜音秒<input name="gapSec" className="mt-1 w-full" placeholder="0" /></label>
                  </div>
                  <label className="mt-2 flex items-center gap-2"><input type="checkbox" name="dryRun" value="1" />dry-run</label>
                  <label className="mt-1 flex items-center gap-2"><input type="checkbox" name="noMotionSelect" value="1" />唔揀 mocap</label>
                  {/* P33：resume checkbox 刪走——續做係左列表獨立入口，新建表格淨係新建。 */}
                </details>
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
                  {fleet && !fleet.ready ? "機未齊 · 唔開工" : "新建開工（生新 ID）"}
                </button>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  CLI 同等：<code className="text-primary">npm run slatecrew -- produce &quot;brief&quot;</code>
                </p>
              </form>
            </CardContent>
          </Card>
          </details>

          <details className="rounded-lg border px-3 py-2 text-xs">
            <summary className="cursor-pointer font-medium">機隊／模型 rack</summary>
            <div className="mt-2 space-y-3">
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
            </div>
          </details>
            </>
          ) : (
            <button
              type="button"
              className="w-full rounded border border-border py-3 text-xs text-muted-foreground hover:border-primary hover:text-primary"
              onClick={() => setRailOpen(true)}
              aria-label="展開項目列表"
            >
              »<span className="ml-1">項目</span>
            </button>
          )}
        </section>

        <section className="order-1 min-w-0 space-y-4 lg:order-2">
          <Card>
            <CardHeader className="flex flex-row items-start justify-between border-b">
              <div className="min-w-0">
                <CardTitle className="flex items-center gap-2">
                  <Film className="size-4 text-primary" />
                  {job?.slate ?? "未開 slate"}
                </CardTitle>
              <p className="text-muted-foreground mt-1 min-w-0 truncate text-xs" title={job?.callSheet?.title ?? job?.input.brief ?? ""}>
                  {job?.callSheet?.title ?? job?.input.brief ?? "等 brief"} · {job?.status ?? "idle"}
                  {job?.continuity?.cut?.length
                    ? ` · cut ${job.continuity.cut.length} 鏡（${job.continuity.cut[0]}→…→${job.continuity.cut[job.continuity.cut.length - 1]}）`
                    : ""}
                </p>
                {job ? (
                  <p className="mt-1 text-xs text-muted-foreground">
                    進度 {job.progress}% · 鏡頭 {job.callSheet?.shots.length ?? 0} · 分鏡 {job.callSheet?.storyboard?.length ?? 0} · 靜畫 {job.outputs.stills.length} · 灰片 {job.outputs.blockout.length} · H3 已交 {submittedShotCount(events)}
                  </p>
                ) : null}
                {storyboardMode ? (
                  <p className="mt-1 text-[10px] text-amber-300/90">分鏡模式：{storyboardMode}</p>
                ) : null}
                {job?.status === "boarded" ? (
                  <p className="mt-1 text-xs text-destructive">自己停喺文字表，冇下一席接手。算失敗。</p>
                ) : null}
                {job?.error ? (
                  <p className="mt-1 text-sm text-destructive">stage gate · {job.currentAgent ?? job.status} · {job.error}</p>
                ) : (
                  <p className="mt-1 text-sm text-muted-foreground">stage gate · {job?.currentAgent ?? job?.status ?? "idle"} · 更新 {job?.updatedAt ?? "—"}</p>
                )}
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
              <ProductLinks job={job} />
              <details className="rounded border px-2 py-1.5 text-xs text-muted-foreground">
                <summary className="cursor-pointer">席位／抽 QC 幀</summary>
                <div className="mt-2 space-y-3">
              {job?.id ? (
                <form
                  className="flex flex-wrap items-end gap-2 text-xs"
                  onSubmit={(e) => {
                    e.preventDefault();
                    setFrameNote("抽緊…");
                    void fetch("/api/frames", {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({ job: job.id, shot: frameShot }),
                    })
                      .then(async (r) => {
                        const data = (await r.json()) as { error?: string; frames?: unknown[] };
                        setFrameNote(data.error ?? `frames ${data.frames?.length ?? 0}`);
                      })
                      .catch((err: unknown) => setFrameNote(err instanceof Error ? err.message : String(err)));
                  }}
                >
                  <label className="text-muted-foreground">
                    抽 QC 帧
                    <Input value={frameShot} onChange={(e) => setFrameShot(e.target.value)} className="mt-1 w-24" />
                  </label>
                  <button type="submit" className={cn(buttonVariants({ size: "sm", variant: "outline" }))}>
                    frames
                  </button>
                  {frameNote ? <span className="text-muted-foreground">{frameNote}</span> : null}
                </form>
              ) : null}
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
                </div>
              </details>
              {/* B33（A shape 已交＋A2 endpoint live）：同項目持久對話面板——
                  history／ask／revise／requestId 冪等；API 未接通時面板內具名。 */}
              {job?.id ? <SessionPanel jobId={job.id} /> : null}
            </CardContent>
          </Card>

          <div className="min-w-0 space-y-2">
            <div className="min-w-0">
              {/* Chau 0927（手機回報）：tab 切換改 client-side——淨換下面個框，
                  唔再成個網 reload；replaceState 保持 URL 可 share 唅觸發 navigation。
                  手機單行橫向碌，唔再 wrap 到兩三行亂晒。 */}
              <div className="flex gap-1 overflow-x-auto rounded-lg bg-muted p-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                {(
                  [
                    ["album", "畫簿"],
                    ["cut", "剪接"],
                    ["canvas", "畫布"],
                    ["board", "分鏡"],
                    ["plan", "計劃"],
                    ["block", "走位"],
                    ["qc", "QC"],
                    ["lock", "成片"],
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={cn(
                      buttonVariants({ variant: tab === id ? "default" : "ghost", size: "sm" }),
                      "shrink-0 whitespace-nowrap",
                    )}
                    onClick={() => {
                      setTab(id);
                      const q = new URLSearchParams();
                      if (job?.id) q.set("slate", job.id);
                      if (id !== "board") q.set("tab", id);
                      window.history.replaceState(null, "", `/?${q.toString()}`);
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="px-1 text-[10px] text-muted-foreground">{TAB_NOTES[tab]}</p>
              {tab === "album" ? <Album key={job?.id} job={job} /> : null}
              {/* Chau 0928（畫布真義）：node graph 換走——畫布＝灰模逐格對帳牆。 */}
              {tab === "canvas" ? <BlockCanvas key={job?.id} job={job} /> : null}
              {job ? (
                <div className="mt-2">
                  <details className="rounded-lg border border-amber-700/50 bg-amber-950/20 p-2 text-xs">
                    <summary className="cursor-pointer text-amber-300">🚩 見到問題？展開報俾 Claude（實時收）</summary>
                    <ShotFeedback jobId={job.id} shots={(job.callSheet?.shots ?? []).map((s) => s.id)} />
                  </details>
                </div>
              ) : null}
              {tab === "board" ? (
                <div className="mt-3 min-h-48 space-y-3">
                  {/* Chau 0927（糾正）：KF stills 唔係分鏡格——唔好用 stills 砌格牆。
                      呢個 tab 淨係顯示真分鏡板交付物（板原圖＋切格 Gallery）；
                      格牆／KF／灰模／refs 嘅呈現歸畫布 tab。逐鏡條目軸已判死，鏟走。 */}
                  {job?.callSheet?.storyboard?.length ? (
                    <StoryboardPanel job={job} />
                  ) : (
                    <Empty label="分鏡板未交付——文字鏡頭表唔算分鏡。" />
                  )}
                  {job?.id ? (
                    <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                      <summary className="cursor-pointer">逐鏡收據（ShotInspector）</summary>
                      <ShotInspector jobId={job.id} shots={job.callSheet?.shots.map((s) => s.id) ?? []} />
                    </details>
                  ) : null}
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
                  {/* Chau 0928（重組）：§5b H3 範本 demo 由舊 H3 tab 搬嚟收埋。 */}
                  <details className="rounded-lg border px-3 py-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer">H3 範本參考（§5b demo，唔係呢份 job 嘅數據）</summary>
                    {(() => {
                      const { hold, hop } = clinicH3Plans();
                      return (
                        <div className="mt-2 grid gap-3 lg:grid-cols-2">
                          <H3PlanCard title="Hold · same world" plan={hold} />
                          <H3PlanCard title="Hop · prev last forbidden" plan={hop} />
                        </div>
                      );
                    })()}
                  </details>
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
              {/* Chau 0928（重組）：H3 獨立 tab 刪走——KF↔灰模↔出片對照、全片
                  連接軸、h3_plan refs 三槽全部歸畫簿 H3對齊 view；舊 ?tab=h3
                  落畫簿同一個 view，唔爆 link。 */}
              {/* Chau 0928：剪接＝H3對齊同一頁（cut/h3 兩個入口同一個 view）。 */}
              {tab === "h3" || tab === "cut" ? <Album key={job?.id} job={job} initialView="h3" /> : null}
              {tab === "lock" ? (
                <div className="mt-3 min-h-48 space-y-4">
                <ShotAudio job={job} />
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

            <details className="rounded-lg border px-3 py-2 text-xs">
              <summary className="cursor-pointer font-medium">場地對講（紀錄）</summary>
            <Card className="mt-2 min-h-72">
              <CardHeader className="border-b">
                <CardTitle>場地對講</CardTitle>
                {/* Chau 0927：記錄冇分層全部塞埋一齊——預設「當前」淨睇尾 30 筆（任何
                    level）；要痛點先撳「要點」（error/fail/warn），要全量先撳「全部」。 */}
                <div className="flex gap-1 pt-1 text-[11px]">
                  {(
                    [
                      ["tail", "當前（尾 30 筆）"],
                      ["key", "要點（錯/敗/警）"],
                      ["all", "全部"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={cn(
                        buttonVariants({ variant: logFilter === id ? "default" : "ghost", size: "sm" }),
                      )}
                      onClick={() => setLogFilter(id)}
                    >
                      {label}
                    </button>
                  ))}
                  <span className="ml-auto self-center text-muted-foreground">
                    {events.filter((e) => e.level === "error" || e.level === "fail").length} 錯敗 ·{" "}
                    {events.filter((e) => e.level === "warn").length} 警 · {events.length} 總
                  </span>
                </div>
              </CardHeader>
              <CardContent className="p-0">
                <ScrollArea className="h-[280px] xl:h-[420px]">
                  <div ref={logRef} className="space-y-2 p-3 font-mono text-[11px] leading-relaxed">
                    {events.length === 0 ? (
                      <p className="text-muted-foreground">等開工。Agent 會喺呢度報位。</p>
                    ) : (
                      (logFilter === "tail"
                        ? events.slice(-30)
                        : events.filter((e) => logFilter === "all" || e.level === "error" || e.level === "fail" || e.level === "warn")
                      ).map((e, i) => (
                        <p key={`${e.ts}-${i}`}>
                          <span className="text-primary">{e.agent === "system" ? "system" : whoLine(e.agent)}</span>{" "}
                          <span className={e.level === "fail" ? "text-destructive" : e.level === "pass" ? "text-emerald-400" : e.level === "warn" ? "text-amber-400" : e.level === "error" ? "text-destructive font-bold" : "text-muted-foreground"}>
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
            </details>
          </div>
        </section>
      </main>
    </div>
  );
}


function submittedShotCount(events: { message: string }[]): number {
  const ids = new Set<string>();
  for (const event of events) {
    const hit = /^(SH\d+) motion 完成/.exec(event.message);
    if (hit?.[1]) ids.add(hit[1]);
  }
  return ids.size;
}

function slateHref(id: string, tab: FloorTab) {
  const q = new URLSearchParams();
  q.set("slate", id);
  if (tab !== "board") q.set("tab", tab);
  return `/?${q.toString()}`;
}

/** P33（§1/§3）：左側項目列表＝主要入口——真實狀態／進度／阻塞原因；
 *  跑緊＝附着既有 run 唔重入；舊項目有明確「續做」（原 ID resume，
 *  唔重填 brief 唔複製新 ID）；locked＝已交付，要改走對話修訂。 */
function ProjectList({ rows, current, tab }: { rows: JobRecord[]; current?: string; tab: FloorTab }) {
  const live = rows.filter((item) => item.status === "running" || item.status === "queued");
  const rest = rows.filter((item) => item.status !== "running" && item.status !== "queued");
  return (
    <div className="space-y-3">
      <ProjectGroup label="做緊" items={live} empty="而家冇一份喺跑" current={current} tab={tab} />
      <ProjectGroup label="其餘" items={rest} empty="冇" current={current} tab={tab} />
    </div>
  );
}

function ProjectGroup({
  label,
  items,
  empty,
  current,
  tab,
}: {
  label: string;
  items: JobRecord[];
  empty: string;
  current?: string;
  tab: FloorTab;
}) {
  return (
    <div className="space-y-1">
      <p className="text-[11px] tracking-wider text-muted-foreground">{label} · {items.length}</p>
      {items.length === 0 ? <p className="text-xs text-muted-foreground">{empty}</p> : (
        <div className="space-y-1.5">
          {items.map((item) => {
            const running = item.status === "running" || item.status === "queued";
            const locked = item.status === "locked";
            return (
              <div key={item.id} className={`rounded-lg border p-2 text-xs ${item.id === current ? "border-primary bg-primary/10" : "border-border"}`}>
                <a href={slateHref(item.id, tab)} className="block">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium">{item.slate}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground">
                      {item.status} {item.progress}% · 片{item.outputs.shots.length}{item.outputs.pictureLock ? " · lock" : ""}
                    </span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{item.callSheet?.title ?? item.input.brief.slice(0, 24)}</p>
                  {item.error ? (
                    <p className="mt-0.5 truncate text-[10px] text-destructive" title={item.error}>⚠ {item.error}</p>
                  ) : null}
                </a>
                {running ? (
                  <p className="mt-1 rounded bg-primary/10 px-1.5 py-0.5 text-[10px] text-primary">跑緊——撳入去附着既有 run，唔另起執行</p>
                ) : locked ? (
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    已交付——去 <a className="text-primary underline" href={`/?slate=${item.id}&tab=lock`}>成片</a> 睇；要修改＝
                    <a className="text-primary underline" href={`/?slate=${item.id}`}>
                      入呢個項目用「同呢個項目對話」要求修改
                    </a>
                    （送出後照回執狀態顯示——已記錄唔等於已執行）
                  </p>
                ) : (
                  <ResumeButton jobId={item.id} slate={item.slate} />
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Empty({ label }: { label: string }) {
  return <p className="rounded-lg border border-dashed p-8 text-sm text-muted-foreground">{label}</p>;
}

/** B33：續做走 POST /api/jobs/:id/resume（A1 admission）——attached（活躍
 *  owner，返既有 run 狀態）／resumed（跳返項目頁）／blocked（具名原因）。
 *  無效 ID 具名報錯，絕不 fallback 走新建。 */
function ResumeButton({ jobId, slate }: { jobId: string; slate: string }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const router = useRouter();
  return (
    <div className="mt-1">
      <button
        type="button"
        disabled={busy}
        className="w-full rounded border border-border px-2 py-0.5 text-left text-[10px] hover:border-primary hover:text-primary disabled:opacity-40"
        onClick={() => {
          setBusy(true);
          setNote("");
          void fetch(`/api/jobs/${jobId}/resume`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ requestId: crypto.randomUUID() }),
          })
            .then(async (r) => {
              if (!r.ok) {
                const why = (await r.json().catch(() => ({}))) as { error?: string };
                throw new Error(why.error ?? `${r.status}`);
              }
              return (await r.json()) as { jobId: string; status: string; lastError?: string; progress?: number };
            })
            .then((res) => {
              if (res.status === "blocked") {
                setNote(res.lastError ?? "blocked（具名原因待 backend）");
                setBusy(false);
                return;
              }
              router.push(`/?slate=${jobId}`);
            })
            .catch((e: unknown) => {
              setNote(`續做失敗：${e instanceof Error ? e.message : "error"}——原 ID，唔會 fallback 新建`);
              setBusy(false);
            });
        }}
      >
        {busy ? "續做緊…" : `▶ 續做（原 ID ${slate}——唔重填 brief、唔複製新項）`}
      </button>
      {note ? <p className="mt-0.5 text-[10px] text-destructive">{note}</p> : null}
    </div>
  );
}

function ProductLinks({ job }: { job: JobRecord | null }) {
  if (!job) return null;
  const out = job.outputs;
  const files = [
    out.callSheet,
    out.continuity,
    out.narrativePlan,
    out.voice,
    out.cutPlan,
    out.concatGate,
    out.scenePreview,
    out.pictureLock,
    out.qcReport,
    out.redo,
    out.blenderScript,
    out.blockingPreview,
    out.vault,
    ...out.stills,
    ...out.shots,
    ...out.blockout,
    ...out.receipts,
  ].filter((p): p is string => Boolean(p));
  if (!files.length) return null;
  return (
    <div className="flex max-h-24 flex-wrap gap-2 overflow-y-auto text-[11px] leading-relaxed">
      {files.map((file) => (
        <a key={file} className="text-primary underline" href={media(job.id, file)}>
          {file}
        </a>
      ))}
    </div>
  );
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
