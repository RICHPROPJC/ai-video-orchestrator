/** T37 眼板 — pictureQc contact sheet. Pure sharp + SVG text, zero LLM.
 *  Per shot: stills/SHxx.qc-sheet.png (left f0, middle generated still, right
 *  text column). Per scene: stills/SCxx.qc-sheet.html listing every shot.
 *  D3: no absolute paths anywhere — text is scrubbed, HTML uses bare filenames. */
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const SHEET_W = 1600;
const SHEET_H = 600;
const PANEL_W = 500;
const TEXT_W = SHEET_W - PANEL_W * 2;

/** D3: absolute paths never reach the sheet — scrub /home|/mnt|/Users trees. */
export function sanitizeSheetText(s: string): string {
  return s.replace(/\/(?:home|mnt|Users)\/[^\s，。；、）】」"']*/g, "[路徑]");
}

export function firstSentences(s: string, n = 3): string {
  const parts = s
    .split(/(?<=[。！？!?])/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.slice(0, n).join(" ");
}

export function lastSentence(s: string): string {
  const parts = s
    .split(/(?<=[。！？!?])/)
    .map((x) => x.trim())
    .filter(Boolean);
  return parts.at(-1) ?? "";
}

function wrap(s: string, width: number): string[] {
  const out: string[] = [];
  for (const para of s.split(/\n/)) {
    let line = "";
    for (const ch of para) {
      if (line.length + 1 > width) {
        out.push(line);
        line = "";
      }
      line += ch;
    }
    if (line) out.push(line);
  }
  return out;
}

function escapeXml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export type QcSheetShot = {
  shotId: string;
  f0File: string;
  stillFile: string;
  status: string;
  failReasons: string[];
  requireLocation?: string;
  blind: string;
  prompt: string;
};

/** One SHxx.qc-sheet.png. Left: f0 keyframe; middle: the generated still;
 *  right: text column (require.location / blind first 3 sentences / status +
 *  fail_reasons / prompt last sentence). */
export async function buildQcSheet(shot: QcSheetShot, outFile: string): Promise<void> {
  const lines: string[] = [];
  lines.push(`${shot.shotId} — ${shot.status}`);
  lines.push(`require: ${sanitizeSheetText(shot.requireLocation ?? "—")}`);
  lines.push("");
  lines.push("blind 頭三句:");
  for (const l of wrap(sanitizeSheetText(firstSentences(shot.blind, 3)), 36)) lines.push(`  ${l}`);
  lines.push("");
  lines.push(shot.failReasons.length ? "fail_reasons:" : "fail_reasons: —");
  for (const r of shot.failReasons.slice(0, 6)) for (const l of wrap(sanitizeSheetText(r), 36)) lines.push(`  ${l}`);
  lines.push("");
  lines.push("prompt 尾句:");
  for (const l of wrap(sanitizeSheetText(lastSentence(shot.prompt)) || "—", 36)) lines.push(`  ${l}`);

  const body = lines
    .map((l, i) => `<tspan x="16" dy="${i === 0 ? 0 : 21}" xml:space="preserve">${escapeXml(l)}</tspan>`)
    .join("");
  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${TEXT_W}" height="${SHEET_H}">` +
      `<rect width="100%" height="100%" fill="#101318"/>` +
      `<text x="16" y="34" font-family="Noto Serif CJK SC, sans-serif" font-size="16" fill="#e8e6e3">${body}</text>` +
      `</svg>`,
  );

  const panel = async (file: string) =>
    sharp(file)
      .resize(PANEL_W, SHEET_H, { fit: "contain", background: { r: 6, g: 7, b: 9 } })
      .toBuffer();
  const left = await panel(shot.f0File);
  const mid = await panel(shot.stillFile);
  await sharp({
    create: { width: SHEET_W, height: SHEET_H, channels: 3, background: { r: 6, g: 7, b: 9 } },
  })
    .composite([
      { input: left, left: 0, top: 0 },
      { input: mid, left: PANEL_W, top: 0 },
      { input: svg, left: PANEL_W * 2, top: 0 },
    ])
    .png()
    .toFile(outFile);
}

/** SCxx.qc-sheet.html — one page, every shot, bare filenames only (D3). */
export function buildQcSheetHtml(
  rows: { shotId: string; status: string; failReasons: string[]; sheetBasename: string }[],
  outFile: string,
): void {
  const cards = rows
    .map(
      (r) =>
        `    <figure class="${r.status === "FAIL" ? "fail" : "ok"}">` +
        `<img src="${r.sheetBasename}" alt="${r.shotId}">` +
        `<figcaption><b>${r.shotId}</b> · ${r.status}` +
        (r.failReasons.length ? ` — ${escapeXml(r.failReasons.join("; "))}` : "") +
        `</figcaption></figure>`,
    )
    .join("\n");
  fs.writeFileSync(
    outFile,
    `<!doctype html><meta charset="utf-8"><title>${path.basename(outFile)}</title>
<style>body{background:#0d1014;color:#e8e6e3;font-family:sans-serif;margin:24px}
figure{display:inline-block;margin:8px;max-width:820px}img{width:100%;border:1px solid #2a2f36}
figcaption{font-size:13px;padding:6px 2px;max-width:800px}.fail figcaption b{color:#ff8484}</style>
<h1>${path.basename(outFile)}</h1>
${cards}
`,
  );
}

export type QcSheetReceipt = {
  shotId: string;
  status: string;
  failReasons: string[];
  blind: string;
};

/** Receipt reader — a shot's photo_qc.json is the single source for status/
 *  fail_reasons/blind whether it was judged this run or on a resume. */
export function readQcReceipt(file: string): QcSheetReceipt {
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as {
    status?: string;
    checks?: { fail_reasons?: string[] };
    blind?: string;
  };
  return {
    shotId: path.basename(file, ".photo_qc.json"),
    status: raw.status ?? "UNKNOWN",
    failReasons: raw.checks?.fail_reasons ?? [],
    blind: raw.blind ?? "",
  };
}
