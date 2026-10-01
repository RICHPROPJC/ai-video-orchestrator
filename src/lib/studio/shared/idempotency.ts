/** PR-0 §5：冪等鍵——唔含 checkpoint（每個 checkpoint 產生新 key 係錯嘅） */

export function idempotencyKey(
  jobId: string,
  attemptId: string,
  seatId: string,
  capability: string,
  inputManifestSha: string,
): string {
  return `${jobId}:${attemptId}:${seatId}:${capability}:${inputManifestSha}`;
}

export interface ResumeToken {
  checkpointId: string;
  checkpointSha: string;
}
