import fs from "node:fs";
import path from "node:path";
import { resolveInJob } from "@/lib/studio/isolate";

export const runtime = "nodejs";

const TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".png": "image/png",
  ".wav": "audio/wav",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
  ".py": "text/x-python; charset=utf-8",
};

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ path: string[] }> },
) {
  const { path: parts } = await ctx.params;
  if (!parts?.length) return new Response("not found", { status: 404 });
  const rel = parts.join("/");
  if (rel.includes("..")) return new Response("bad path", { status: 400 });
  const [id, ...rest] = parts;
  if (!id || !rest.length) return new Response("not found", { status: 404 });
  let abs: string;
  try {
    abs = resolveInJob(id, rest.join("/"));
  } catch {
    return new Response("bad path", { status: 400 });
  }
  if (!fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
    return new Response("not found", { status: 404 });
  }
  const ext = path.extname(abs).toLowerCase();
  const buf = fs.readFileSync(abs);
  return new Response(buf, {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
