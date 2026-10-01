/** PR-0 §4：Receipt——驗證閉環核心
 * 冇 consumption receipt = 唔可以證明下游實際用過輸入。 */

export type ReceiptKind =
  | "provider_execution"
  | "artifact_commit"
  | "artifact_consumption"
  | "gate_evaluation"
  | "route_decision";

export interface ReceiptRef {
  receiptId: string;
  kind: ReceiptKind;
  schemaVersion: number;
  artifactId?: string;
  producerAttemptId: string;
  consumerAttemptId?: string;
  sha256: string;
  createdAt: string;
  payload: Record<string, unknown>;
}
