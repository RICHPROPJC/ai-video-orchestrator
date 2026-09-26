"use client";

import { useEffect, useState } from "react";

type ShotInspect = {
  slate: string;
  shot: string;
  revision: string;
  jobStatus: string;
  pictureLock: string | null;
  whyUnlocked: string | null;
  call: { action?: string; location?: string; keyframePositions?: string } | null;
  world: { id: string; role: string; meters: number; evidence: string }[];
  files: { still: boolean; blockout: boolean; characterRig: boolean; bottleRig: boolean };
  h3: {
    motionForm: string | null;
    promptId: string | null;
    keyframePositions: string;
    blockout: string | null;
    kfStart: string | null;
    kfEnd: string | null;
    refImages: string[];
    sources: { role: string; sha256: string }[];
    outputSha: string | null;
    sameRunKeyframeAndVideo: boolean;
  } | null;
  qc: { status: string | null; frames: { frame: number; t_s: number; status: string; reasons: string[] }[] } | null;
};

export function ShotInspector({ jobId, shots }: { jobId: string; shots: string[] }) {
  const [shot, setShot] = useState(shots.includes("SH02") ? "SH02" : shots[0] ?? "SH01");
  const [data, setData] = useState<ShotInspect | null>(null);
  const [frame, setFrame] = useState<number | null>(null);
  useEffect(() => {
    let stop = false;
    setError("");
    void fetch(`/api/jobs/${jobId}/shot/${shot}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status}`);
        return res.json() as Promise<ShotInspect>;
      })
      .then((body) => { if (!stop) setData(body); })
      .catch((err: unknown) => { if (!stop) setError(err instanceof Error ? err.message : "load failed"); });
    return () => { stop = true; };
  }, [jobId, shot]);
  return (
    <section className="mt-3 space-y-2 rounded-lg border p-3 text-xs">
      <div className="flex items-center gap-2">
        <p className="font-medium">逐鏡</p>
        <select className="bg-background" value={shot} onChange={(e) => setShot(e.target.value)}>
          {shots.map((id) => <option key={id} value={id}>{id}</option>)}
        </select>
      </div>
      {error ? <p className="text-destructive">{error}</p> : null}
      {data ? (
        <div className="space-y-1 text-muted-foreground">
          <p>run {data.slate} · revision {data.revision} · status {data.jobStatus}</p>
          <p>分鏡 {data.call?.location ?? "—"} · {data.call?.action ?? "—"} · 計劃鍵格 {data.call?.keyframePositions || "冇"}</p>
          <p>檔案 still {String(data.files.still)} · blockout {String(data.files.blockout)} · A rig {String(data.files.characterRig)} · 樽 rig {String(data.files.bottleRig)}</p>
          <p>world {data.world.map((piece) => `${piece.id} ${piece.meters}m ${piece.evidence}`).join(" · ") || "冇"}</p>
          <p>H3 {data.h3 ? `${data.h3.motionForm} prompt ${data.h3.promptId ?? "—"} · Video1 ${data.h3.blockout ?? "冇"} · kf ${data.h3.kfStart ?? "冇"}/${data.h3.kfEnd ?? "冇"} · 同次鍵格+片 ${String(data.h3.sameRunKeyframeAndVideo)}` : "冇提交"}</p>
          <p>來源 SHA {data.h3?.sources.length ? data.h3.sources.map((row) => `${row.role}:${row.sha256.slice(0, 8)}`).join(" ") : "舊收據冇 sources"}</p>
          <p>QC {data.qc?.status ?? "冇"}</p>
          {(data.qc?.frames ?? []).filter((item) => item.status === "FAIL").map((item) => (
            <button key={item.frame} type="button" className="block text-left text-destructive" onClick={() => setFrame(item.frame)}>
              f{item.frame} {item.t_s}s {item.reasons[0] ?? ""}
            </button>
          ))}
          {frame != null ? (
            <p>選中 f{frame}：{(data.qc?.frames ?? []).find((item) => item.frame === frame)?.reasons.join("；") || "冇判詞"}。未分誤報定真缺陷。</p>
          ) : null}
          <p>未鎖 {data.whyUnlocked ?? "—"}</p>
        </div>
      ) : null}
    </section>
  );
}
