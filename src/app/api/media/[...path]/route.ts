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
  const total = buf.byteLength;
  const type = TYPES[ext] ?? "application/octet-stream";
  // ROOT 1046Z §10：手機 playback/seek 要 Range——媒檔（mp4/wav）照 Range 回
  // 206＋Content-Range；其餘細檔全檔 200＋Content-Length。兩路都 Accept-Ranges。
  const range = _req.headers.get("range");
  const m = range?.match(/^bytes=(\d*)-(\d*)$/);
  if (m && (ext === ".mp4" || ext === ".wav")) {
    const start = m[1] ? Number(m[1]) : 0;
    const end = m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
    if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= total) {
      return new Response("range not satisfiable", { status: 416, headers: { "Content-Range": `bytes */${total}` } });
    }
    return new Response(buf.subarray(start, end + 1), {
      status: 206,
      headers: {
        "Content-Type": type,
        "Content-Length": String(end - start + 1),
        "Content-Range": `bytes ${start}-${end}/${total}`,
        "Accept-Ranges": "bytes",
        "Cache-Control": "no-store",
      },
    });
  }
  return new Response(buf, {
    headers: {
      "Content-Type": type,
      "Content-Length": String(total),
      "Accept-Ranges": "bytes",
      "Cache-Control": "no-store",
    },
  });
}
