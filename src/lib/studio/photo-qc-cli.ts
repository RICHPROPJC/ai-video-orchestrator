/** T40: thin CLI over runPhotoQc — the earn line calls the SAME gate, zero
 *  duplicated logic (E3: this file only imports runPhotoQc; no local re-
 *  implementation of any check).
 *  bun photo-qc <png> --require <require.json> [--out <photo_qc.json>]
 *  stdout: the full record JSON. exit 0 = non-FAIL (GREEN / PASS_UNCONFIRMED /
 *  PASS_WITH_WARN), 1 = FAIL, 2 = usage error. Empty require object reaches
 *  the existing gate and FAILs with "no require: cannot accept" — no new
 *  invention here. */
import fs from "node:fs";
import path from "node:path";
import { runPhotoQc, type PhotoQcEyes, type PhotoQcRecord } from "./photo-qc";

export type CliResult = { code: 0 | 1 | 2; message?: string; record?: PhotoQcRecord };

export function parseCliArgs(argv: string[]): { png: string; requirePath: string; out?: string } | null {
  const args = [...argv];
  let png = "";
  let requirePath = "";
  let out: string | undefined;
  while (args.length) {
    const a = args.shift()!;
    if (a === "--require") requirePath = args.shift() ?? "";
    else if (a === "--out") out = args.shift() ?? "";
    else if (!a.startsWith("--") && !png) png = a;
    else return null;
  }
  if (!png || !requirePath) return null;
  return { png, requirePath, out };
}

export async function runCli(argv: string[], eyes?: PhotoQcEyes): Promise<CliResult> {
  const parsed = parseCliArgs(argv);
  if (!parsed) {
    return { code: 2, message: "usage: bun photo-qc <png> --require <require.json> [--out <photo_qc.json>]" };
  }
  const { png, requirePath, out } = parsed;
  if (!fs.existsSync(png)) {
    return { code: 2, message: `png not found: ${png}` };
  }
  let require: unknown;
  try {
    require = JSON.parse(fs.readFileSync(requirePath, "utf8"));
  } catch {
    return { code: 2, message: `require json unreadable: ${requirePath}` };
  }
  const outPath =
    out ?? path.join(path.dirname(png), `${path.basename(png, path.extname(png))}.photo_qc.json`);
  const record = await runPhotoQc(png, outPath, require as Parameters<typeof runPhotoQc>[2], {}, eyes);
  return { code: record.status === "FAIL" ? 1 : 0, record };
}

// entry via main(): top-level await breaks tsx/esbuild's CJS transform, and
// import.meta.main keeps tsx --test imports side-effect free (bun-only flag).
async function main() {
  const res = await runCli(process.argv.slice(2));
  if (res.record) console.log(JSON.stringify(res.record, null, 2));
  else if (res.message) console.error(res.message);
  process.exit(res.code);
}
if (import.meta.main) void main();
