import fs from "node:fs";
import path from "node:path";

export function dataRoot() {
  return path.join(process.cwd(), "data", "jobs");
}

export function jobDir(id: string) {
  return path.join(dataRoot(), id);
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function jobFile(id: string, ...parts: string[]) {
  const dir = jobDir(id);
  ensureDir(path.join(dir, ...parts.slice(0, -1)));
  return path.join(dir, ...parts);
}
