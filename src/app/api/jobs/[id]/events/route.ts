import { readEvents, readJob, subscribe } from "@/lib/studio/store";

export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  if (!readJob(id)) {
    return new Response("not found", { status: 404 });
  }
  const encoder = new TextEncoder();
  let unsub = () => {};
  const stream = new ReadableStream({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      for (const e of readEvents(id)) send("log", e);
      send("job", readJob(id));
      unsub = subscribe(id, (e) => {
        send("log", e);
        send("job", readJob(id));
      });
    },
    cancel() {
      unsub();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
