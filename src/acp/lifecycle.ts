import type { LifecycleConfig } from "../daemon/config.ts";

/** What the lifecycle policy needs to know about one session. */
export type SessionView = {
  open: boolean;
  /** A turn is running, prompts are queued, or the session is being opened. */
  busy: boolean;
  /** Pending permission requests / elicitations. */
  pending: number;
  /** Background tasks the agent reported (async_task_*), or out-of-turn activity. */
  backgroundTasks: number;
  /** Created with session/new and never prompted: no transcript yet, cannot be re-loaded (closing it unbinds it). */
  neverRan: boolean;
  lastUsedAt: number;
  lastActivityAt: number;
};

export type LifecycleEvent = { kind: "turn_ended" } | { kind: "attached" } | { kind: "tick"; now: number };

const MIN = 60_000;

/**
 * R12/R12b: decide whether to `session/close` a session.
 * after_turn: close right after a turn (or a preview load) unless held by background work or
 *   pending interactions; held sessions close once idle for busy_hold_minutes.
 * lru: never close on turn end; close after idle_close_minutes (eviction is pickEvictions).
 * A never-run session (/new) has nothing to lose but its binding: both modes close it after
 *   idle_close_minutes, never right after a preview.
 */
export function shouldClose(s: SessionView, e: LifecycleEvent, cfg: LifecycleConfig): boolean {
  if (!s.open || s.busy) return false;
  if (s.neverRan) return e.kind === "tick" && s.pending === 0 && e.now - s.lastUsedAt >= cfg.idle_close_minutes * MIN;
  const held = s.pending > 0 || s.backgroundTasks > 0;
  if (cfg.mode === "after_turn") {
    if (e.kind !== "tick") return !held;
    return !held || e.now - s.lastActivityAt >= cfg.busy_hold_minutes * MIN;
  }
  if (e.kind !== "tick") return false;
  if (held && e.now - s.lastActivityAt < cfg.busy_hold_minutes * MIN) return false;
  return e.now - s.lastUsedAt >= cfg.idle_close_minutes * MIN;
}

/**
 * lru: before opening one more session of an agent, choose least-recently-used idle sessions to
 * close so that at most max_open_sessions stay open. Busy sessions are never evicted.
 */
export function pickEvictions<K>(sessions: Array<{ key: K; view: SessionView }>, cfg: LifecycleConfig): K[] {
  if (cfg.mode !== "lru") return [];
  const open = sessions.filter((s) => s.view.open);
  const excess = open.length + 1 - cfg.max_open_sessions;
  if (excess <= 0) return [];
  return open
    .filter((s) => !s.view.busy && s.view.pending === 0)
    .sort((a, b) => a.view.lastUsedAt - b.view.lastUsedAt)
    .slice(0, excess)
    .map((s) => s.key);
}
