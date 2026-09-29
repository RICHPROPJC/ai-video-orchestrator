"use client";

import { useEffect, useState } from "react";

/** World Studio API client（COLLAB-0929）。
 *  fetch base=/api/world（crew proxy 將來位）——:8791 直接 CORS 未通
 *  （OPTIONS preflight 400 實證 0929），等 production 裁 crew proxy 或 World 加 CORS；
 *  兩邊任一到位，呢個 client 零改生效（proxy 透傳 /api/projects 同構即可）。 */

export type WorldProjectOverview = {
  id: string; // prj_*
  name?: string;
  editSeq?: number;
  contentFingerprint?: string;
  updatedAt?: string;
};

const WORLD_BASE = "/api/world";

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
          list.map((p, i) => ({
            id: p.id,
            name: p.name,
            updatedAt: p.updated_at,
            editSeq: typeof docs[i]?.["editSeq"] === "number" ? (docs[i]?.["editSeq"] as number) : undefined,
            contentFingerprint: typeof docs[i]?.["contentFingerprint"] === "string" ? (docs[i]?.["contentFingerprint"] as string) : undefined,
          })),
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
