import fs from "node:fs";
import path from "node:path";
import { readEvents, readJob } from "@/lib/studio/store";
import { jobDir } from "@/lib/studio/paths";

export const runtime = "nodejs";

/** Chau 0927：「need stream really not shit plug」——舊版 SSE 淨識 in-memory
 *  subscribe，produce CLI 係另一個 process：佢 emit 只寫 events.jsonl＋推自己
 *  記憶體，UI 個 next process 永遠收唔到新事件，連線嗰刻 readEvents replay
 *  完就死寂＝假 stream。呢版以 events.jsonl 檔做唯一真源：replay 之後
 *  1s 輪詢增量 tail（byte 位針，半行回退等下一輪），跨 process 真流。 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  const job = readJob(id);
  if (!job) {
    return new Response("not found", { status: 404 });
  }
  const encoder = new TextEncoder();
  const file = path.join(jobDir(id), "events.jsonl");
  let timer: ReturnType<typeof setInterval> | null = null;
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch {
          /* client 已走 */
        }
      };
      send("job", job);
      let pos = 0;
      if (fs.existsSync(file)) {
        for (const e of readEvents(id)) send("log", e);
        pos = fs.statSync(file).size;
      }
      const pushBytes = (buf: Buffer) => {
        // 淨係食完整行（最後 \n 之後嘅半行回退，等下一輪——append 寫緊中途）
        const lastNl = buf.lastIndexOf(10);
        if (lastNl < 0) return -buf.length;
        const usable = buf.subarray(0, lastNl + 1);
        for (const line of usable.toString("utf8").split("\n")) {
          if (!line.trim()) continue;
          try {
            send("log", JSON.parse(line));
          } catch {
            /* 爛行照跳，位針以行界為準 */
          }
        }
        send("job", readJob(id));
        return usable.length;
      };
      timer = setInterval(() => {
        try {
          const st = fs.statSync(file);
          if (st.size < pos) pos = 0; // truncate（新輪由頭寫）→ replay
          if (st.size <= pos) return;
          const fd = fs.openSync(file, "r");
          const buf = Buffer.alloc(st.size - pos);
          fs.readSync(fd, buf, 0, buf.length, pos);
          fs.closeSync(fd);
          const used = pushBytes(buf);
          pos += used;
        } catch {
          /* 檔重寫中：下一輪再試 */
        }
      }, 1000);
    },
    cancel() {
      if (timer) clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
