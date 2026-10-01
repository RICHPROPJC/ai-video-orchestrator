/** PR-0 §1：狀態轉移表——唯一合法寫入口
 * 所有席位必須經過 transition() 改狀態，唔准直接改 string。
 * 參考：REFACTOR-SPEC-v3 §State Machine + PR-0-CONTRACTS §1 */

export type SeatStatus =
  | "PENDING" | "READY" | "RUNNING"
  | "PASSED" | "PARTIAL" | "BLOCKED"
  | "FAILED_RETRYABLE" | "FAILED_TERMINAL" | "SKIPPED" | "SUPERSEDED";

export interface StateTransition {
  from: SeatStatus;
  event: string;
  to: SeatStatus;
  sameAttempt: boolean;
}

export const TRANSITIONS: readonly StateTransition[] = [
  { from: "PENDING",          event: "dependencies_ready",    to: "READY",            sameAttempt: true },
  { from: "READY",            event: "lease_acquired",        to: "RUNNING",          sameAttempt: true },
  { from: "RUNNING",          event: "checkpoint_saved",      to: "RUNNING",          sameAttempt: true },
  { from: "RUNNING",          event: "completed",             to: "PASSED",           sameAttempt: true },
  { from: "RUNNING",          event: "completed_partial",     to: "PARTIAL",          sameAttempt: true },
  { from: "RUNNING",          event: "blocked",               to: "BLOCKED",          sameAttempt: true },
  { from: "RUNNING",          event: "failed_retryable",      to: "FAILED_RETRYABLE", sameAttempt: true },
  { from: "RUNNING",          event: "failed_terminal",       to: "FAILED_TERMINAL",  sameAttempt: true },
  { from: "RUNNING",          event: "lease_expired",         to: "READY",            sameAttempt: true },
  { from: "RUNNING",          event: "skipped",               to: "SKIPPED",          sameAttempt: true },
  { from: "BLOCKED",          event: "dependency_resolved",   to: "READY",            sameAttempt: true },
  { from: "BLOCKED",          event: "unblocked_new_attempt", to: "SUPERSEDED",       sameAttempt: false },
  { from: "FAILED_RETRYABLE", event: "retry_authorized",      to: "READY",            sameAttempt: true },
  { from: "FAILED_RETRYABLE", event: "replacement_authorized",to: "SUPERSEDED",       sameAttempt: false },
  { from: "PASSED",           event: "repair_requested",      to: "SUPERSEDED",       sameAttempt: false },
  { from: "PARTIAL",          event: "repair_requested",      to: "SUPERSEDED",       sameAttempt: false },
  { from: "PARTIAL",          event: "accepted_partial",      to: "PASSED",           sameAttempt: true },
  { from: "FAILED_TERMINAL",  event: "replacement_authorized",to: "SUPERSEDED",       sameAttempt: false },
  { from: "SKIPPED",          event: "reactivated",           to: "PENDING",          sameAttempt: true },
] as const;

export function transition(
  current: SeatStatus,
  event: string,
): { next: SeatStatus; sameAttempt: boolean } {
  const t = TRANSITIONS.find(x => x.from === current && x.event === event);
  if (!t) throw new Error(`state_transition_invalid: ${current} + ${event}`);
  return { next: t.to, sameAttempt: t.sameAttempt };
}

export function canTransition(from: SeatStatus, event: string): boolean {
  return TRANSITIONS.some(x => x.from === from && x.event === event);
}
