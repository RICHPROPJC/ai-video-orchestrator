import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { assertPng, snap32 } from "./u15-edit";

// node:http like the /edit lane: undici's header timeout cannot cover a serial
// t2i on a queued node
const POST_TIMEOUT_MS = 3_600_000;

/** The t2i lane is the one that has thinking (the fork's GenerateRequest
 *  defaults it on); /edit has no such switch. */
export const PORTRAIT_PX = 1024;
const NUM_STEPS = 50;

export type GeneratePayload = {
  prompt: string;
  width: number;
  height: number;
  num_steps: number;
  think_mode: boolean;
  seed?: number;
};

export function buildGeneratePayload(opts: {
  prompt: string;
  width?: number;
  height?: number;
  steps?: number;
  seed?: number;
  thinkMode?: boolean;
}): GeneratePayload {
  const prompt = opts.prompt.trim();
  if (!prompt) throw new Error("nothing to generate: empty prompt");
  const payload: GeneratePayload = {
    prompt,
    width: snap32(opts.width ?? PORTRAIT_PX),
    height: snap32(opts.height ?? PORTRAIT_PX),
    num_steps: opts.steps ?? NUM_STEPS,
    think_mode: opts.thinkMode ?? true,
  };
  if (opts.seed != null) payload.seed = opts.seed;
  return payload;
}

function postForBytes(url: string, payload: unknown, timeoutMs = POST_TIMEOUT_MS): Promise<{ status: number; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = Buffer.from(JSON.stringify(payload));
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": data.length },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks) }));
      },
    );
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`POST ${url} timed out after ${timeoutMs}ms`)));
    req.on("error", reject);
    req.end(data);
  });
}

export async function runGenerate(server: string, payload: GeneratePayload): Promise<{ png: Buffer; elapsedMs: number }> {
  const t0 = Date.now();
  const { status, body } = await postForBytes(`${server.replace(/\/$/, "")}/generate`, payload);
  if (status !== 200) {
    throw new Error(`/generate HTTP ${status}: ${body.subarray(0, 300).toString("utf8")}`);
  }
  assertPng(body);
  return { png: body, elapsedMs: Date.now() - t0 };
}

export type U15GenerateRecord = {
  tool: "slatecrew.u15_generate";
  ts: string;
  url: string;
  payload: GeneratePayload;
  output: string;
  elapsed_ms: number;
  bytes: number;
};

export async function u15Generate(opts: {
  server: string;
  payload: GeneratePayload;
  outFile: string;
  recordJson: string;
}): Promise<U15GenerateRecord> {
  const { png, elapsedMs } = await runGenerate(opts.server, opts.payload);
  fs.mkdirSync(path.dirname(opts.outFile), { recursive: true });
  fs.writeFileSync(opts.outFile, png);
  const record: U15GenerateRecord = {
    tool: "slatecrew.u15_generate",
    ts: new Date().toISOString(),
    url: `${opts.server.replace(/\/$/, "")}/generate`,
    payload: opts.payload,
    output: opts.outFile,
    elapsed_ms: elapsedMs,
    bytes: png.length,
  };
  fs.mkdirSync(path.dirname(opts.recordJson), { recursive: true });
  fs.writeFileSync(opts.recordJson, JSON.stringify(record, null, 2));
  return record;
}
