// protects=R12/R12b session lifecycle policy (after_turn default, lru idle close, busy_hold for held sessions, never closing busy sessions, never-run /new sessions closed only after idle_close_minutes) and lru eviction choice;
// fails_when=a busy/held session is closed, after_turn keeps idle sessions open, lru closes on turn end or evicts busy sessions, more than max_open_sessions remain, a never-run session stays open forever or is closed right away;
// no_claim=timer wiring and ACP session/close effects (integration tests)
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickEvictions, shouldClose, type SessionView } from "../src/acp/lifecycle.ts";
import type { LifecycleConfig } from "../src/daemon/config.ts";

const MIN = 60_000;
const afterTurn: LifecycleConfig = { mode: "after_turn", max_open_sessions: 3, idle_close_minutes: 30, busy_hold_minutes: 10 };
const lru: LifecycleConfig = { ...afterTurn, mode: "lru" };
const now = 100 * MIN;
const base: SessionView = { open: true, busy: false, pending: 0, backgroundTasks: 0, neverRan: false, lastUsedAt: now, lastActivityAt: now };
const v = (o: Partial<SessionView>): SessionView => ({ ...base, ...o });

const table: Array<[string, SessionView, Parameters<typeof shouldClose>[1], LifecycleConfig, boolean]> = [
  ["after_turn closes an idle session when the turn ends", base, { kind: "turn_ended" }, afterTurn, true],
  ["after_turn closes after a preview load", base, { kind: "attached" }, afterTurn, true],
  ["after_turn keeps a session with background tasks", v({ backgroundTasks: 1 }), { kind: "turn_ended" }, afterTurn, false],
  ["after_turn keeps a session with a pending question", v({ pending: 1 }), { kind: "turn_ended" }, afterTurn, false],
  ["after_turn: held session closes after busy_hold of inactivity", v({ backgroundTasks: 1, lastActivityAt: now - 10 * MIN }), { kind: "tick", now }, afterTurn, true],
  ["after_turn: held session with recent activity stays", v({ backgroundTasks: 1, lastActivityAt: now - 9 * MIN }), { kind: "tick", now }, afterTurn, false],
  ["after_turn: an idle open session is closed on tick", base, { kind: "tick", now }, afterTurn, true],
  ["never closes a busy session", v({ busy: true }), { kind: "turn_ended" }, afterTurn, false],
  ["after_turn: a never-run session (/new) is not closed on attach", v({ neverRan: true }), { kind: "attached" }, afterTurn, false],
  ["after_turn: a never-run session stays while idle < idle_close_minutes", v({ neverRan: true, lastUsedAt: now - 29 * MIN }), { kind: "tick", now }, afterTurn, false],
  ["after_turn: a never-run session closes after idle_close_minutes", v({ neverRan: true, lastUsedAt: now - 30 * MIN, lastActivityAt: now - 30 * MIN }), { kind: "tick", now }, afterTurn, true],
  ["lru: a never-run session stays while idle < idle_close_minutes", v({ neverRan: true, lastUsedAt: now - 29 * MIN }), { kind: "tick", now }, lru, false],
  ["lru: a never-run session closes after idle_close_minutes", v({ neverRan: true, lastUsedAt: now - 30 * MIN, lastActivityAt: now - 30 * MIN }), { kind: "tick", now }, lru, true],
  ["nothing to close when not open", v({ open: false }), { kind: "turn_ended" }, afterTurn, false],
  ["lru keeps the session after a turn", base, { kind: "turn_ended" }, lru, false],
  ["lru keeps a recently used session on tick", v({ lastUsedAt: now - 29 * MIN }), { kind: "tick", now }, lru, false],
  ["lru closes after idle_close_minutes", v({ lastUsedAt: now - 30 * MIN, lastActivityAt: now - 30 * MIN }), { kind: "tick", now }, lru, true],
  ["lru: held with recent activity stays even when idle long", v({ backgroundTasks: 1, lastUsedAt: now - 60 * MIN, lastActivityAt: now - 5 * MIN }), { kind: "tick", now }, lru, false],
  ["lru: busy is never closed", v({ busy: true, lastUsedAt: 0 }), { kind: "tick", now }, lru, false],
];

for (const [name, view, event, cfg, expected] of table) {
  test(`shouldClose: ${name}`, () => assert.equal(shouldClose(view, event, cfg), expected));
}

test("pickEvictions: lru evicts least recently used idle sessions down to max-1 before opening one more", () => {
  const sessions = [
    { key: "a", view: v({ lastUsedAt: 3 }) },
    { key: "b", view: v({ lastUsedAt: 1, busy: true }) },
    { key: "c", view: v({ lastUsedAt: 2 }) },
    { key: "d", view: v({ lastUsedAt: 0, open: false }) },
  ];
  assert.deepEqual(pickEvictions(sessions, { ...lru, max_open_sessions: 2 }), ["c", "a"]);
  assert.deepEqual(pickEvictions(sessions, { ...lru, max_open_sessions: 3 }), ["c"]);
  assert.deepEqual(pickEvictions(sessions, { ...lru, max_open_sessions: 4 }), []);
  assert.deepEqual(pickEvictions(sessions, { ...afterTurn, max_open_sessions: 1 }), []);
});

test("pickEvictions: an idle never-run session (/new) is evictable like any other", () => {
  const sessions = [
    { key: "fresh", view: v({ lastUsedAt: 1, neverRan: true }) },
    { key: "ran", view: v({ lastUsedAt: 2 }) },
  ];
  assert.deepEqual(pickEvictions(sessions, { ...lru, max_open_sessions: 2 }), ["fresh"]);
});
