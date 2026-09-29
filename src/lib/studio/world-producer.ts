import { createHash } from "node:crypto";
import fs from "node:fs";
import type { SlateConfig } from "./config";
import type { WorldPlan } from "./world-assemble";

/** world-producer（CHAU-DIRECT-WORLD-INTEGRATION-CONTINUE production 段）：
 *  由已採納 worldPlan/assets 自動建立或重用 World project——唔再等外來
 *  worldProjectId。typed commands（opId 冪等：同 opId deduped 唔寫第二次）
 *  ＋asset sha 對賬（已匯入重用 assetId）＋shot.add 回 sht_* 組 shotMap。
 *  resume 認 `crew:${jobId}` 名重用同一 project，唔每輪建新。
 *  座標映射 named：crew plan＝Blender Z-up（placeWorld「Scenes sit on z=0」）
 *  →World Y-up＝[x, -z, y]（callsheet_camera.py --up zup 同款語義）。
 *  相機精確 pos/focal 唔喺 plan 層（ShotAim 淨 lensMm/size）——camera 物件
 *  由 object.add kind=camera 建立＋shot.aim 對主體；精確擺位接 blockout
 *  計算係 named gap（world-producer-camera-pos），唔作數。 */

export type WorldIdMap = {
  projectId: string;
  reused: boolean;
  sceneId?: string;
  /** pieceId → 匯入收據（assetId=World ast_*；skipped=named 缺檔） */
  assets: Record<string, { assetId?: string; sha256?: string; skipped?: string }>;
  /** pieceId → instantiate 返嘅 obj_* */
  objects: Record<string, string>;
  shotMap: Record<string, { worldShotId?: string; sceneId?: string; cameraId?: string }>;
  commands: number;
  skipped: string[];
  editSeq?: number;
  contentFingerprint?: string;
};

type Doc = {
  editSeq?: number;
  contentFingerprint?: string;
  project?: { scenes?: { id: string; name?: string; cameras?: { id: string }[] }[]; assets?: { id: string; sha256?: string }[]; shots?: { id: string; name?: string }[]; activeSceneId?: string };
};

const hdr = (jobId: string) => ({ "x-writer-id": `crew:${jobId}` });

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) throw new Error(`GET ${url} HTTP ${r.status}`);
  return r.json();
}

/** GET project doc 全形（外層 editSeq/fingerprint＋project 主體）。 */
export async function readWorldDoc(cfg: SlateConfig, projectId: string): Promise<Doc> {
  return (await getJson(`${cfg.world.base}/api/projects/${projectId}`)) as Doc;
}

/** 建立或重用 project（name=`crew:${jobId}`——resume 冪等錨）。 */
export async function ensureWorldProject(cfg: SlateConfig, jobId: string): Promise<{ projectId: string; reused: boolean }> {
  const list = (await getJson(`${cfg.world.base}/api/projects`)) as { projects?: { id: string; name?: string }[] };
  const hit = (list.projects ?? []).find((p) => p.name === `crew:${jobId}`);
  if (hit) return { projectId: hit.id, reused: true };
  const r = await fetch(`${cfg.world.base}/api/projects`, {
    method: "POST",
    headers: { "content-type": "application/json", ...hdr(jobId) },
    body: JSON.stringify({ name: `crew:${jobId}` }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`create project HTTP ${r.status}`);
  const d = (await r.json()) as { project?: { id?: string } } | { id?: string };
  const pid = (d as { project?: { id?: string } }).project?.id ?? (d as { id?: string }).id;
  if (!pid) throw new Error("create project 回覆冇 project id（named unknown——交 World 席對 shape）");
  return { projectId: pid, reused: false };
}

/** asset 匯入（sha 對賬冪等）：doc.assets 已有同 sha＝重用 assetId；缺檔＝
 *  skipped named。multipart POST（file＋opId=`jobId:asset:<piece>:<sha8>`）。 */
async function importAssetIfMissing(
  cfg: SlateConfig,
  projectId: string,
  jobId: string,
  pieceId: string,
  glbPath: string,
  doc: Doc,
): Promise<{ assetId?: string; sha256?: string; skipped?: string }> {
  if (!fs.existsSync(glbPath)) return { skipped: `glb 缺檔：${glbPath}` };
  const sha = createHash("sha256").update(fs.readFileSync(glbPath)).digest("hex");
  const hit = (doc.project?.assets ?? []).find((a) => a.sha256 === sha);
  if (hit) return { assetId: hit.id, sha256: sha };
  const form = new FormData();
  form.append("file", new Blob([fs.readFileSync(glbPath)]), glbPath.split("/").pop() ?? `${pieceId}.glb`);
  form.append("opId", `${jobId}:asset:${pieceId}:${sha.slice(0, 8)}`);
  const r = await fetch(`${cfg.world.base}/api/projects/${projectId}/assets`, {
    method: "POST",
    headers: hdr(jobId),
    body: form,
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`asset ${pieceId} upload HTTP ${r.status}`);
  const d = (await r.json()) as { asset?: { id?: string } } | { id?: string };
  const aid = (d as { asset?: { id?: string } }).asset?.id ?? (d as { id?: string }).id;
  if (!aid) throw new Error(`asset ${pieceId} 回覆冇 id（named unknown）`);
  return { assetId: aid, sha256: sha };
}

/** typed command（opId 冪等：同 opId 再送＝deduped）。回 meta（target＝新 id）。 */
export async function worldCommand(
  cfg: SlateConfig,
  projectId: string,
  jobId: string,
  opKey: string,
  command: Record<string, unknown>,
): Promise<{ target?: string; deduped?: boolean; meta?: Record<string, unknown> }> {
  const r = await fetch(`${cfg.world.base}/api/projects/${projectId}/commands`, {
    method: "POST",
    headers: { "content-type": "application/json", ...hdr(jobId) },
    body: JSON.stringify({ command: { ...command, opId: `${jobId}:${opKey}` } }),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`command ${opKey} HTTP ${r.status}`);
  return (await r.json()) as { target?: string; deduped?: boolean; meta?: Record<string, unknown> };
}

/** Z-up（crew plan）→ World Y-up。 */
const yup = (x: number, y: number, z: number): [number, number, number] => [x, -z, y];

/** 主入口：由 plan 鋪世界。每步 named 收據；任何一步 throw＝caller named
 *  emit 唔殺 job（缺入口具名回責任席，唔靜默落舊 bake）。 */
export async function buildWorldFromPlan(
  cfg: SlateConfig,
  jobId: string,
  plan: WorldPlan,
  shots: { id: string; durationSec: number; lookAtId?: string }[],
): Promise<WorldIdMap> {
  const out: WorldIdMap = {
    projectId: "",
    reused: false,
    assets: {},
    objects: {},
    shotMap: {},
    commands: 0,
    skipped: [],
  };
  const ens = await ensureWorldProject(cfg, jobId);
  out.projectId = ens.projectId;
  out.reused = ens.reused;
  let doc = await readWorldDoc(cfg, ens.projectId);

  // 場景：新 project 預設場景用佢；冇（或 doc 冇 scenes）→scene.add
  let sceneId = doc.project?.scenes?.[0]?.id ?? doc.project?.activeSceneId;
  if (!sceneId) {
    const m = await worldCommand(cfg, ens.projectId, jobId, "scene:main", { type: "scene.add", name: "main" });
    sceneId = m.target;
    out.commands += 1;
  }
  if (!sceneId) throw new Error("scene.add 冇回 target id（named unknown）");
  out.sceneId = sceneId;

  // assets：逐件 sha 對賬匯入（缺檔 named skipped，唔阻其他件）
  for (const piece of plan.pieces) {
    try {
      const a = await importAssetIfMissing(cfg, ens.projectId, jobId, piece.id, piece.glb, doc);
      out.assets[piece.id] = a;
      if (a.skipped) out.skipped.push(`${piece.id}: ${a.skipped}`);
    } catch (e) {
      out.assets[piece.id] = { skipped: String(e) };
      out.skipped.push(`${piece.id}: ${String(e)}`);
    }
  }

  // instantiate＋transform：件→asset.instantiate→object.setTransform（Y-up 映射）
  for (const piece of plan.pieces) {
    const a = out.assets[piece.id];
    if (!a.assetId) continue;
    const inst = await worldCommand(cfg, ens.projectId, jobId, `inst:${piece.id}`, {
      type: "asset.instantiate",
      sceneId,
      assetId: a.assetId,
      name: piece.id,
    });
    const objId = inst.target;
    if (!objId) throw new Error(`asset.instantiate ${piece.id} 冇回 target obj id（named unknown）`);
    out.objects[piece.id] = objId;
    await worldCommand(cfg, ens.projectId, jobId, `tf:${piece.id}`, {
      type: "object.setTransform",
      sceneId,
      objectId: objId,
      transform: { location: yup(piece.x, piece.y, piece.z) },
    });
    out.commands += 2;
  }

  // 相機＋鏡頭：每鏡 object.add kind=camera→（cam 條目由 World 自動起、
  // 鏡住 obj，id 空間係 cam_*）→re-read doc 建 obj→cam map→shot.add（帶
  // cam_* id，timeIn/out 累計）→shot.aim（lookAtId＝piece id→objects map）。
  const camObjIds: Record<string, string> = {};
  for (const shot of shots) {
    const cam = await worldCommand(cfg, ens.projectId, jobId, `cam:${shot.id}`, {
      type: "object.add",
      sceneId,
      kind: "camera",
      name: `cam-${shot.id}`,
    });
    const camObjId = cam.target;
    if (!camObjId) throw new Error(`camera add ${shot.id} 冇回 obj id（named unknown）`);
    camObjIds[shot.id] = camObjId;
    out.commands += 1;
  }
  doc = await readWorldDoc(cfg, ens.projectId);
  const objToCam = new Map(
    (doc.project?.scenes ?? [])
      .flatMap((s) => (s.cameras ?? []).map((c) => c as unknown as { id: string; objectId?: string }))
      .filter((c) => c.objectId)
      .map((c) => [c.objectId as string, c.id]),
  );
  let t = 0;
  for (const shot of shots) {
    const camObjId = camObjIds[shot.id]!;
    const camId = objToCam.get(camObjId);
    if (!camId) throw new Error(`${shot.id}: 相機 obj ${camObjId} 冇對應 cam_* 條目（named unknown——World 側 object.add camera 接線）`);
    const added = await worldCommand(cfg, ens.projectId, jobId, `shot:${shot.id}`, {
      type: "shot.add",
      sceneId,
      cameraId: camId,
      name: shot.id,
      timeIn: t,
      timeOut: t + Math.max(shot.durationSec, 0.1),
    });
    t += Math.max(shot.durationSec, 0.1);
    const shtId = added.target;
    if (!shtId) throw new Error(`shot.add ${shot.id} 冇回 target sht id（named unknown）`);
    out.commands += 1;
    out.shotMap[shot.id] = { worldShotId: shtId, sceneId, cameraId: camId };
    const aimAt = shot.lookAtId ? out.objects[shot.lookAtId] : undefined;
    if (aimAt) {
      await worldCommand(cfg, ens.projectId, jobId, `aim:${shot.id}`, {
        type: "shot.aim",
        shotId: shtId,
        cameraId: camId,
        subjectId: aimAt,
      });
      out.commands += 1;
    } else if (shot.lookAtId) {
      out.skipped.push(`${shot.id}: aim 對象 ${shot.lookAtId} 未 instantiate（缺 asset？）`);
    }
  }

  // 採納版本：最終 doc 外層 editSeq/fingerprint（caller 落 binding 凍結）
  doc = await readWorldDoc(cfg, ens.projectId);
  out.editSeq = doc.editSeq;
  out.contentFingerprint = doc.contentFingerprint;
  return out;
}
