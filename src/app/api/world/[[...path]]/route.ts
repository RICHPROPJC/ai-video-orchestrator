// R22 三方協作（Chau 0929 COLLAB 授權，Album 裁決請求 b 路）：World Studio
// （127.0.0.1:8791）同 origin 透傳 proxy——Album UI 由 :43127 fetch /api/world/*，
// 零 CORS 面（:8791 OPTIONS preflight 400 實證 gap 由呢條路收口）。Album client
// （world-client.ts base=/api/world）已就緒，零改生效。World 側零改動。
// runtime 未驗語義：route 落 source 後要 :43127 重載先生效——現有「不部署/不重啟
// 43127」界線照守，重載時機由既有部署授權另行處理。
export const runtime = "nodejs";

const UPSTREAM = process.env.WORLD_STUDIO_URL || "http://127.0.0.1:8791";

async function pass(req: Request, path: string[]): Promise<Response> {
  const url = new URL(req.url);
  const target = `${UPSTREAM}/${path.join("/")}${url.search}`;
  try {
    const res = await fetch(target, {
      method: req.method,
      headers: {
        ...(req.headers.get("content-type")
          ? { "content-type": req.headers.get("content-type")! }
          : {}),
        accept: req.headers.get("accept") ?? "application/json",
      },
      body: ["GET", "HEAD"].includes(req.method) ? undefined : await req.text(),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await res.text();
    return new Response(text, {
      status: res.status,
      headers: {
        "content-type": res.headers.get("content-type") ?? "application/json",
        "x-world-upstream": target,
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return new Response(
      JSON.stringify({ error: `world_proxy_upstream_unreachable: ${message}`, upstream: target }),
      { status: 502, headers: { "content-type": "application/json" } },
    );
  }
}

type Ctx = { params: Promise<{ path?: string[] }> };

export async function GET(req: Request, ctx: Ctx) {
  const { path = [] } = await ctx.params;
  return pass(req, path);
}

export async function POST(req: Request, ctx: Ctx) {
  const { path = [] } = await ctx.params;
  return pass(req, path);
}
