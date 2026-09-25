import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";
import { resolveInJob } from "@/lib/studio/isolate";

export const runtime = "nodejs";

const previews = new Map<string, Buffer>();

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
  if (new URL(_req.url).searchParams.get("preview") === "1" && ext === ".png") {
    const stat = fs.statSync(abs);
    const key = `${abs}:${stat.mtimeMs}:${stat.size}`;
    let preview = previews.get(key);
    if (!preview) {
      preview = await sharp(abs).resize({ width: 320, height: 240, fit: "inside", withoutEnlargement: true }).webp({ quality: 72 }).toBuffer();
      if (previews.size >= 128) previews.delete(previews.keys().next().value!);
      previews.set(key, preview);
    }
    return new Response(new Uint8Array(preview), { headers: { "Content-Type": "image/webp", "Cache-Control": "no-cache" } });
  }
  const buf = fs.readFileSync(abs);
  return new Response(buf, {
    headers: {
      "Content-Type": TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store",
    },
  });
}
