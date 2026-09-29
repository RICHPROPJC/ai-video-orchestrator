"use client";

import { useEffect, useState } from "react";

/** World Studio API client（COLLAB-0929）。
 *  fetch base=/api/world（crew proxy 將來位）——:8791 直接 CORS 未通
 *  （OPTIONS preflight 400 實證 0929），等 production 裁 crew proxy 或 World 加 CORS；
 *  兩邊任一到位，呢個 client 零改生效（proxy 透傳 /api/projects 同構即可）。 */

/** 每鏡摘要（doc.project.shots[]——CONSUMER-0929-01 note 指路，probe 實證）。 */
export type WorldShotBrief = {
  id: string; // sht_*
  name?: string;
  sceneId?: string;
  cameraId?: string;
  timeIn?: number;
  timeOut?: number;
  order?: number;
};

export type WorldProjectOverview = {
  id: string; // prj_*
  name?: string;
  editSeq?: number;
  contentFingerprint?: string;
  updatedAt?: string;
  shots?: WorldShotBrief[];
};

/** crew proxy 原樣透傳（/api/world/<X> → :8791/<X>）；World 淨掛 /api/*——
 *  所以 base 含埋 /api：實際請求 /api/world/api/projects（0929 probe 200 實證）。 */
/** per-project tasks 概覽（GET /api/projects/{id}/tasks；state 計數＋error 照字）。 */
export function useWorldProjectTasks(projectId: string | null): {
  states: Record<string, number>;
  errors: string[];
  unreachable: boolean;
} {
  const [st, setSt] = useState<{ states: Record<string, number>; errors: string[] }>({ states: {}, errors: [] });
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    void fetch(worldApi(`/projects/${projectId}/tasks`), { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as { tasks?: { state?: string; error?: string }[] };
      })
      .then((d) => {
        if (stop) return;
        const states: Record<string, number> = {};
        const errors: string[] = [];
        for (const t of d.tasks ?? []) {
          const s = t.state ?? "?";
          states[s] = (states[s] ?? 0) + 1;
          if (t.error) errors.push(t.error);
        }
        setSt({ states, errors });
      })
      .catch(() => {
        if (!stop) setUnreachable(true);
      });
    return () => {
      stop = true;
    };
  }, [projectId]);
  return { ...st, unreachable };
}

const WORLD_BASE = "/api/world/api";

/** Phase world-stage（production 9726ff0 刀3）：job↔World 綁定四態真源——
 *  GET /api/jobs/{id}/world-stage。unbound＝job 未揀定 project（顯示「未揀定」，
 *  唔好空白當已接）；current/stale＝binding 凍結版 vs World latest editSeq 對比；
 *  unreachable＝World serve 離線（唔係 stale）。 */
export type WorldStageBinding = {
  projectId?: string;
  editSeqAtAdoption?: number;
  contentFingerprintAtAdoption?: string;
  shotMap?: Record<string, { taskId?: string; taskState?: string } & Record<string, unknown>>;
};

export type WorldStage = {
  state: "unbound" | "current" | "stale" | "unreachable";
  binding?: WorldStageBinding;
  latest?: { editSeq?: number; contentFingerprint?: string };
  error?: string;
};

export function useWorldStage(jobId: string | null | undefined): WorldStage | null {
  const [st, setSt] = useState<WorldStage | null>(null);
  useEffect(() => {
    if (!jobId) return;
    let stop = false;
    void fetch(`/api/jobs/${jobId}/world-stage`, { cache: "no-store" })
      .then(async (r) => (r.ok ? ((await r.json()) as WorldStage) : null))
      .then((d) => {
        if (!stop && d) setSt(d);
      })
      .catch(() => {
        if (!stop) setSt({ state: "unreachable", error: "crew world-stage route 唔通" });
      });
    return () => {
      stop = true;
    };
  }, [jobId]);
  return st;
}

/** doc 全形（Pi 0929 授權預寫試點用；parse 寬鬆——World schema 演進欄位照 unknown 食）。 */
export type WorldProjectDoc = {
  editSeq?: number;
  contentFingerprint?: string;
  shots: WorldShotBrief[];
  scenes: { id: string; name?: string; cameras?: unknown[]; objects?: unknown[] }[];
  assets: { id: string; name?: string; sha256?: string; logicalPath?: string }[];
  render?: Record<string, unknown>;
};

/** 讀單一 project doc 全形（project.shots/scenes/assets/render）。 */
export function useWorldProjectDoc(projectId: string | null): { doc: WorldProjectDoc | null; unreachable: boolean } {
  const [doc, setDoc] = useState<WorldProjectDoc | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    if (!projectId) return;
    let stop = false;
    void fetch(worldApi(`/projects/${projectId}`), { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as Record<string, unknown>;
      })
      .then((raw) => {
        if (stop) return;
        const inner = (raw["project"] ?? {}) as Record<string, unknown>;
        setDoc({
          editSeq: typeof raw["editSeq"] === "number" ? (raw["editSeq"] as number) : undefined,
          contentFingerprint: typeof raw["contentFingerprint"] === "string" ? (raw["contentFingerprint"] as string) : undefined,
          shots: Array.isArray(inner["shots"]) ? (inner["shots"] as WorldShotBrief[]) : [],
          scenes: Array.isArray(inner["scenes"]) ? (inner["scenes"] as WorldProjectDoc["scenes"]) : [],
          assets: Array.isArray(inner["assets"]) ? (inner["assets"] as WorldProjectDoc["assets"]) : [],
          render: (inner["render"] ?? undefined) as WorldProjectDoc["render"],
        });
      })
      .catch(() => {
        if (!stop) setUnreachable(true);
      });
    return () => {
      stop = true;
    };
  }, [projectId]);
  return { doc, unreachable };
}

export function worldApi(rel: string) {
  return `${WORLD_BASE}${rel}`;
}

/** 集級概覽：projects 列表＋每 project doc 補 editSeq/contentFingerprint
 *  （save 過先有；讀唔到＝undefined named）。API 唔通＝unreachable（UI named-missing）。 */
export function useWorldOverview() {
  const [projects, setProjects] = useState<WorldProjectOverview[] | null>(null);
  const [unreachable, setUnreachable] = useState(false);
  useEffect(() => {
    let stop = false;
    void fetch(worldApi("/projects"), { cache: "no-store" })
      .then(async (r) => {
        if (!r.ok) throw new Error(`${r.status}`);
        return (await r.json()) as { projects?: { id: string; name?: string; updated_at?: string }[] };
      })
      .then(async (d) => {
        const list = (d.projects ?? []).slice(0, 6);
        const docs = await Promise.all(
          list.map((p) =>
            fetch(worldApi(`/projects/${p.id}`), { cache: "no-store" })
              .then(async (r) => (r.ok ? ((await r.json()) as Record<string, unknown>) : null))
              .catch(() => null),
          ),
        );
        if (stop) return;
        setProjects(
          list.map((p, i) => {
            const doc = docs[i];
            const inner = (doc?.["project"] ?? {}) as Record<string, unknown>;
            const shots = Array.isArray(inner["shots"]) ? (inner["shots"] as WorldShotBrief[]) : undefined;
            return {
              id: p.id,
              name: p.name,
              updatedAt: p.updated_at,
              editSeq: typeof doc?.["editSeq"] === "number" ? (doc?.["editSeq"] as number) : undefined,
              contentFingerprint: typeof doc?.["contentFingerprint"] === "string" ? (doc?.["contentFingerprint"] as string) : undefined,
              shots,
            };
          }),
        );
      })
      .catch(() => {
        if (!stop) setUnreachable(true);
      });
    return () => {
      stop = true;
    };
  }, []);
  return { projects, unreachable };
}
