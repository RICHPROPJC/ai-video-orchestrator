import fs from "node:fs";

/** T39 / TEAM_BOARD 21:35 §1: the earn line out-earns us on the U1.5/H3 GPU
 *  pair and signals with a lock file it owns — earn touches and removes the
 *  lock itself (protocol: /mnt/ssd/earn/demo_u15_20260914/peer_handoff/
 *  GPU_LOCK.md). SlateCrew never writes, deletes or otherwise manages the
 *  lock: it waits, speaking once, until earn lifts it. */
const EARN_LOCK_DEFAULT = "/mnt/ssd/earn/.lock";
export const EARN_LOCK_POLL_MS = 5_000;

/** SLATECREW_EARN_LOCK overrides the lock path (tests); default is earn's.
 *  An explicit override wins over the env (tests inject a temp path so
 *  concurrent test files never stomp each other through process.env). */
export function earnLockPath(explicit?: string): string {
  return explicit?.trim() || process.env.SLATECREW_EARN_LOCK?.trim() || EARN_LOCK_DEFAULT;
}

/** dry-run never POSTs the pair, and --until boards/blockout stops before
 *  the first u15Edit — neither touches the GPU, so neither waits on earn. */
export function shouldWaitEarnLock(input: { dryRun?: boolean; until?: string }): boolean {
  return !input.dryRun && input.until !== "boards" && input.until !== "blockout";
}

export type EarnLockWaitOpts = {
  /** explicit lock path (tests); falls back to SLATECREW_EARN_LOCK, then earn's */
  lockPath?: string;
  /** spoken once when the wait starts — the operator sees why produce parked */
  speak?: () => void | Promise<void>;
  /** test clock: receives every poll wait instead of really sleeping */
  sleep?: (ms: number) => Promise<void>;
  pollMs?: number;
};

/** No lock → pass straight through (the common case). Lock present → speak
 *  once, then poll (≤5s) until earn removes it. This module never deletes,
 *  moves or writes the lock — rm belongs to the earn line alone. */
export async function waitEarnGpuLock(opts: EarnLockWaitOpts = {}): Promise<void> {
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const pollMs = opts.pollMs ?? EARN_LOCK_POLL_MS;
  const lock = () => earnLockPath(opts.lockPath);
  if (!fs.existsSync(lock())) return;
  await opts.speak?.();
  while (fs.existsSync(lock())) {
    await sleep(pollMs);
  }
}
