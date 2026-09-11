import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { loadConfig } from "./config";

const VIMAX_SECRETS_ENV = "/mnt/ssd/vimax_repo/.vimax/secrets.env";

/** D12 chain (shotdag creds route): env SLATECREW_SSH_PASS → env VIMAX_SSH_PASS
 *  → read-only vimax secrets.env key VIMAX_SSH_PASS; else throw listing the
 *  sources tried. The password never enters any SlateCrew file. */
export function sshPassword(): string {
  const tried: string[] = [];
  for (const varName of ["SLATECREW_SSH_PASS", "VIMAX_SSH_PASS"]) {
    tried.push(`env $${varName}`);
    const pw = process.env[varName] ?? "";
    if (pw) return pw;
  }
  tried.push(`file ${VIMAX_SECRETS_ENV} (key VIMAX_SSH_PASS)`);
  if (fs.existsSync(VIMAX_SECRETS_ENV)) {
    for (const line of fs.readFileSync(VIMAX_SECRETS_ENV, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#") || !t.includes("=")) continue;
      const eq = t.indexOf("=");
      const key = t.slice(0, eq).trim();
      const val = t.slice(eq + 1).trim();
      if (key === "VIMAX_SSH_PASS" && val) return val;
    }
  }
  throw new Error(
    `no ssh password found — tried: ${tried.join("; ")}. ` +
      "wav reaches ComfyUI input/ via sshpass scp (fork production route).",
  );
}

function runChecked(cmd: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${cmd[0]} exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** sshpass mkdir -p + scp -q to <user>@<host>:<remoteDir>/<name> (fork upload route) */
export async function scpToHost(host: string, user: string, local: string, remoteDir: string, name: string): Promise<void> {
  const pw = sshPassword();
  await runChecked(
    ["sshpass", "-p", pw, "ssh", "-o", "StrictHostKeyChecking=no", `${user}@${host}`, `mkdir -p ${remoteDir}`],
    60_000,
  );
  await runChecked(
    ["sshpass", "-p", pw, "scp", "-q", "-o", "StrictHostKeyChecking=no", local, `${user}@${host}:${remoteDir}/${name}`],
    180_000,
  );
}

/** content-hash node0 refs path — re-uploads of the same bytes overwrite themselves */
export function u15RefPath(local: string): string {
  const digest = crypto.createHash("md5").update(fs.readFileSync(local)).digest("hex").slice(0, 12);
  const refsDir = loadConfig().ssh.stillsRefsDir;
  return `${refsDir}/u15_${digest}${path.extname(local)}`;
}
