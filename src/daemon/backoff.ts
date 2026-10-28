export type BackoffOptions = { baseMs: number; maxMs: number; jitter: number };

export const DEFAULT_BACKOFF: BackoffOptions = { baseMs: 1000, maxMs: 60_000, jitter: 0.2 };

/** Exponential backoff 1 s → 60 s with ±20 % jitter (protocol transport rules). */
export function backoffDelay(attempt: number, o: BackoffOptions = DEFAULT_BACKOFF, random = Math.random): number {
  const raw = Math.min(o.maxMs, o.baseMs * 2 ** Math.max(0, attempt));
  return Math.round(raw * (1 + (random() * 2 - 1) * o.jitter));
}
