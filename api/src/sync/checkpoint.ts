/**
 * Checkpoint advancement rules for sync exchange.
 * Advance only when the client batch has zero permanent validation failures.
 * Empty outbox is allowed to advance (pull-only / heartbeat exchange).
 */

export function shouldAdvanceCheckpoint(permanentRejectCount: number): boolean {
  return permanentRejectCount === 0;
}

export function nextCheckpointToken(tenantId: string, nextSeq: number): string {
  return `cp-${tenantId}-${nextSeq}`;
}

export function initialCheckpointToken(tenantId: string): string {
  return `cp-${tenantId}-0`;
}
