import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { loadConfig } from "./config";

/** Read VIMAX_SSH_PASS from machine-local secrets.env — never copy into SlateCrew files. */
function passwordFromVimaxSecrets(): string | null {
  const secrets = "/mnt/ssd/vimax_repo/.vimax/secrets.env";
  if (!fs.existsSync(secrets)) return null;
  for (const line of fs.readFileSync(secrets, "utf8").split("\n")) {
    if (!line.startsWith("VIMAX_SSH_PASS=")) continue;
    const pw = line.slice("VIMAX_SSH_PASS=".length).trim();
    return pw || null;
  }
  return null;
}

/** D12: env SLATECREW_SSH_PASS → env VIMAX_SSH_PASS → vimax secrets.env.
 *  node0/node1 同 user 同 pass → 直接 sshpass，唔 jump。 */
export function sshPasswordOptional(): string | null {
  for (const varName of ["SLATECREW_SSH_PASS", "VIMAX_SSH_PASS"]) {
    const pw = process.env[varName] ?? "";
    if (pw) return pw;
  }
  return passwordFromVimaxSecrets();
}

export function sshPassword(): string {
  const pw = sshPasswordOptional();
  if (pw) return pw;
  throw new Error(
    "no ssh password — set $SLATECREW_SSH_PASS / $VIMAX_SSH_PASS，或 /mnt/ssd/vimax_repo/.vimax/secrets.env",
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

async function scpWithPassword(
  pw: string,
  host: string,
  user: string,
  local: string,
  remoteDir: string,
  name: string,
): Promise<void> {
  await runChecked(
    ["sshpass", "-p", pw, "ssh", "-o", "StrictHostKeyChecking=no", `${user}@${host}`, `mkdir -p ${remoteDir}`],
    60_000,
  );
  await runChecked(
    ["sshpass", "-p", pw, "scp", "-q", "-o", "StrictHostKeyChecking=no", local, `${user}@${host}:${remoteDir}/${name}`],
    180_000,
  );
}

/** Direct sshpass — same password both nodes. */
export async function scpToHost(host: string, user: string, local: string, remoteDir: string, name: string): Promise<void> {
  await scpWithPassword(sshPassword(), host, user, local, remoteDir, name);
}

export function u15RefPath(local: string): string {
  const digest = crypto.createHash("md5").update(fs.readFileSync(local)).digest("hex").slice(0, 12);
  const refsDir = loadConfig().ssh.stillsRefsDir;
  return `${refsDir}/u15_${digest}${path.extname(local)}`;
}
