import type { JobEvent, JobRecord } from "./types";
import { CREW, FLOOR, whoLine } from "./crew";
import { readEvents, readJob, subscribe } from "./store";

const ESC = "\x1b";
const hide = `${ESC}[?25l`;
const show = `${ESC}[?25h`;
const clear = `${ESC}[2J${ESC}[H`;
const dim = `${ESC}[2m`;
const reset = `${ESC}[0m`;
const amber = `${ESC}[33m`;
const green = `${ESC}[32m`;
const red = `${ESC}[31m`;
const cyan = `${ESC}[36m`;

function paint(job: JobRecord | null, events: JobEvent[], extra: string) {
  const lines: string[] = [];
  lines.push(`${amber}SLATECREW TUI${reset}  ${dim}q 離開 · floor handoff · 故事＝分鏡＝剪接${reset}`);
  lines.push(extra);
  lines.push("");
  const row = FLOOR.map((id) => {
    const who = CREW[id];
    const active = job?.currentAgent === id;
    const logs = events.filter((e) => e.agent === id);
    const pass = logs.some((e) => e.level === "pass");
    const fail = logs.some((e) => e.level === "fail");
    const color = fail ? red : pass ? green : active ? cyan : dim;
    return `${color}${who.name}${reset}`;
  }).join(`${dim}→${reset}`);
  lines.push(row);
  const now = job?.currentAgent ? CREW[job.currentAgent] : null;
  if (now) {
    lines.push(`${cyan}${now.name}／${now.job}${reset}  ${dim}想：${now.thinking}${reset}`);
  }
  const pct = job?.progress ?? 0;
  const bar = "█".repeat(Math.round(pct / 5)).padEnd(20, "░");
  lines.push("");
  const cut = job?.continuity?.cut.join("→") ?? "";
  lines.push(`${amber}${job?.slate ?? "———"}${reset}  ${bar} ${pct}%  ${job?.status ?? "idle"}${cut ? `  ${dim}${cut}${reset}` : ""}`);
  if (job?.providers) {
    lines.push(`${dim}${job.providers.stills} · ${job.providers.motion}${reset}`);
  }
  lines.push("");
  lines.push(`${dim}場地對講${reset}`);
  for (const e of events.slice(-10)) {
    const c = e.level === "pass" ? green : e.level === "fail" ? red : dim;
    const name = e.agent === "system" ? "system" : whoLine(e.agent);
    lines.push(` ${c}${name.padEnd(8)}${reset} ${e.message.slice(0, 84)}`);
  }
  process.stdout.write(clear + hide + lines.join("\n") + "\n");
}

export async function runTui(jobId: string, extra: string) {
  if (!process.stdout.isTTY) {
    return;
  }
  const tty = process.stdin;
  const wasRaw = tty.isRaw;
  if (tty.isTTY) tty.setRawMode?.(true);
  tty.resume();
  let quit = false;
  const onData = (buf: Buffer) => {
    const s = buf.toString();
    if (s === "q" || s === "Q" || s === "\u0003") quit = true;
  };
  tty.on("data", onData);
  const draw = () => paint(readJob(jobId), readEvents(jobId), extra);
  draw();
  const unsub = subscribe(jobId, draw);
  const timer = setInterval(draw, 400);
  try {
    while (!quit) {
      const job = readJob(jobId);
      if (job && ["locked", "failed", "blocked"].includes(job.status)) {
        draw();
        break;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
  } finally {
    clearInterval(timer);
    unsub();
    tty.off("data", onData);
    if (tty.isTTY) tty.setRawMode?.(wasRaw ?? false);
    process.stdout.write(show + "\n");
  }
}
