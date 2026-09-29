"use client";

import { useWorldProjectDoc, type WorldProjectDoc, type WorldShotBrief } from "@/lib/studio/world-client";

/** Pi 0929 授權·預寫 per-鏡世界/機位/軌/artifact 面板（試點真數據渲染）。
 *  零採納宣稱：crewConsumer＝未 named 橫幅常駐；binding 未落——呢個面板
 *  係組件預寫＋試點預覽，唔係 crew SH01↔world shot 映射。
 *  production job↔project binding 欄落齊後：AxisRow 傳 worldShot 即接真數據。 */

type CamBrief = { id?: string; name?: string; focalLengthMm?: number; rig?: string; lookAtTargetId?: string };
type ObjBrief = { id?: string; name?: string; kind?: string; assetId?: string | null; transform?: { location?: number[] } };

function shotScene(doc: WorldProjectDoc, shot: WorldShotBrief) {
  return doc.scenes.find((s) => s.id === shot.sceneId) ?? null;
}

/** 單鏡世界詳情（照 doc 查表：shot→scene→camera/actors→assets/render）。 */
export function WorldShotPanel({ doc, shot }: { doc: WorldProjectDoc; shot: WorldShotBrief }) {
  const scene = shotScene(doc, shot);
  const cams = (scene?.cameras ?? []) as CamBrief[];
  const cam = cams.find((c) => c.id === shot.cameraId) ?? null;
  const objs = (scene?.objects ?? []) as ObjBrief[];
  const actors = objs.filter((o) => o.assetId);
  const tracks = (scene as unknown as { tracks?: unknown[] } | null)?.tracks ?? [];
  return (
    <div className="space-y-1 rounded-lg border border-border/70 p-2 text-[10px] text-muted-foreground">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium text-foreground">世界·{shot.name ?? shot.id}</span>
        <span className="font-mono">{shot.id}</span>
        <span>
          {shot.timeIn ?? "?"}–{shot.timeOut ?? "?"}s
        </span>
        <span>e{doc.editSeq ?? "?"} f{(doc.contentFingerprint ?? "").slice(0, 8) || "?"}</span>
      </p>
      <p>
        場景 {scene?.name ?? shot.sceneId ?? "—"}（{scene?.id ?? "—"}）· 物件 {objs.length} 件（人物/帶資產 {actors.length}）
      </p>
      {cam ? (
        <p>
          機位 {cam.name ?? cam.id} · {cam.focalLengthMm ?? "?"}mm · rig {cam.rig ?? "?"}
          {cam.lookAtTargetId ? ` · lookAt ${cam.lookAtTargetId.slice(0, 12)}…` : ""}
        </p>
      ) : (
        <p>機位 {shot.cameraId ?? "—"}（scene.cameras 查不到——named missing）</p>
      )}
      {actors.map((o) => {
        const a = doc.assets.find((x) => x.id === o.assetId);
        return (
          <p key={o.id ?? o.name}>
            {o.name ?? o.id} · asset {a?.name ?? o.assetId ?? "?"}
            {a?.sha256 ? ` sha${a.sha256.slice(0, 8)}` : "（sha missing）"}
            {o.transform?.location ? ` · loc [${o.transform.location.map((v) => v.toFixed(1)).join(", ")}]` : ""}
          </p>
        );
      })}
      <p>
        動作軌 {Array.isArray(tracks) ? tracks.length : 0} 條
        {(!Array.isArray(tracks) || tracks.length === 0) ? "——未有軌（motion gap：BVH 匯入不支援／retarget 未驗，named）" : ""}
      </p>
      {doc.render ? (
        <p className="truncate" title={JSON.stringify(doc.render)}>
          render {String(doc.render["engine"] ?? "?")} · {String(doc.render["resolutionX"] ?? "?")}×{String(doc.render["resolutionY"] ?? "?")}
          {doc.render["blockout"] ? " · blockout" : ""}
        </p>
      ) : null}
      <p className="text-amber-400/80">crew consumer＝未（世界側數據；非 crew pipeline 採用——binding 未落）</p>
    </div>
  );
}

/** 試點預覽（Pi 指定 prj_0c521a31862e 真數據）：組件預寫驗證位——
 *  binding 落齊後呢塊換成 AxisRow 真接線，呢個 preview 就退場。 */
export function WorldPilotPreview() {
  const { doc, unreachable } = useWorldProjectDoc("prj_0c521a31862e");
  return (
    <details className="rounded-lg border border-dashed border-border px-2 py-1.5 text-[10px] text-muted-foreground">
      <summary className="cursor-pointer">
        🧪 世界試點預覽（prj_0c521a31862e·WSY6-SH01試點）——組件預寫，binding 未落非 crew 映射
      </summary>
      <div className="mt-1 space-y-1">
        {unreachable ? (
          <p>World API 未接（/api/world/api/projects/prj_0c521a31862e）</p>
        ) : !doc ? (
          <p>讀緊…</p>
        ) : doc.shots.length ? (
          doc.shots.map((s) => <WorldShotPanel key={s.id} doc={doc} shot={s} />)
        ) : (
          <p>doc 冇 shots（named missing）</p>
        )}
      </div>
    </details>
  );
}
