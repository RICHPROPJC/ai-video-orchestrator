import fs from "node:fs";
import path from "node:path";

/** Story nouns live in projects/<drama>/entities.json — src/ and seats/ code
 *  never contains one (D1a call-6 law). Frozen excerpts under fixture dirs
 *  are exempt: fixtures may quote the sheet, code may not. Every D1a
 *  constraint is primitive: it names fields and sets, never a story noun. */

export type NounHit = {
  token: string;
  file: string;
  line: number;
  text: string;
};

/** skip dirs that hold frozen sheet excerpts or vendored trees */
const SKIP_DIRS = new Set(["node_modules", "fixtures", "trace-fixtures", ".git"]);

function isLintableToken(token: string): boolean {
  // CJK tokens need >= 2 chars, ASCII >= 4 — a lone id letter matches nothing useful
  const cjk = /[一-鿿]/.test(token);
  return token.trim().length >= (cjk ? 2 : 4);
}

/** every noun token from every projects/<drama>/entities.json under root */
export function entityTokens(projectsDir: string): string[] {
  if (!fs.existsSync(projectsDir)) return [];
  const tokens: string[] = [];
  for (const drama of fs.readdirSync(projectsDir)) {
    const file = path.join(projectsDir, drama, "entities.json");
    if (!fs.existsSync(file)) continue;
    const data = JSON.parse(fs.readFileSync(file, "utf8")) as { nouns?: unknown };
    if (!Array.isArray(data.nouns)) continue;
    for (const t of data.nouns) if (typeof t === "string" && isLintableToken(t)) tokens.push(t);
  }
  return [...new Set(tokens)];
}

function walkFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walkFiles(path.join(dir, entry.name), out);
    } else {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

/** every hit of any token in src/ or seats/ under root — [] means green */
export function lintTree(root: string, tokens: string[]): NounHit[] {
  const hits: NounHit[] = [];
  if (tokens.length === 0) return hits;
  for (const tree of ["src", "seats"]) {
    const dir = path.join(root, tree);
    if (!fs.existsSync(dir)) continue;
    for (const file of walkFiles(dir)) {
      let text: string;
      try {
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue; // unreadable (binary) — no text to leak
      }
      if (text.includes("\u0000")) continue; // binary by content
      const lines = text.split("\n");
      lines.forEach((line, i) => {
        for (const token of tokens) {
          if (line.includes(token)) {
            hits.push({ token, file: path.relative(root, file), line: i + 1, text: line.trim().slice(0, 160) });
          }
        }
      });
    }
  }
  return hits;
}

/** lint one repo root: tokens from its projects/, scanned against src/ + seats/ */
export function lintRepo(root: string): { ok: boolean; tokens: string[]; hits: NounHit[] } {
  const tokens = entityTokens(path.join(root, "projects"));
  const hits = lintTree(root, tokens);
  return { ok: hits.length === 0, tokens, hits };
}

function main(root: string): number {
  const { ok, tokens, hits } = lintRepo(root);
  console.log(`noun-lint: ${tokens.length} story noun tokens from projects/*/entities.json`);
  for (const hit of hits) {
    console.error(`HIT ${hit.token} ${hit.file}:${hit.line} ${hit.text}`);
  }
  console.log(ok ? "noun-lint: GREEN — src/ and seats/ carry no story nouns" : `noun-lint: FAIL — ${hits.length} hits`);
  return ok ? 0 : 1;
}

/* eslint-disable-next-line @typescript-eslint/no-unsafe-member-access */
if (typeof require !== "undefined" && require.main === module) {
  process.exit(main(path.resolve(__dirname, "..", "..", "..")));
}

export { main as lintMain };
