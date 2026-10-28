// protects=a lifecycle close decided before an await does not run when a turn started meanwhile;
// fails_when=#close goes on after `agent.get()` although the session became busy, so session/close (and a reload) races the new turn;
// no_claim=ACP transport behaviour (integration tests use the fake agent process)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type SessionEvents } from "../src/acp/session-manager.ts";
import type { Config } from "../src/daemon/config.ts";
import { createLogger } from "../src/log.ts";

process.env.AGENT_CONNECTOR_LOG ??= "warn";

test("#close re-checks busy after awaiting the agent: a turn that started meanwhile keeps its session", async () => {
  const calls: string[] = [];
  let release!: () => void;
  let gate: Promise<void> = new Promise((r) => (release = r));
  const conn = {
    newSession: async () => ({ sessionId: "s1", modes: null }),
    loadSession: async () => (calls.push("load"), {}),
    closeSession: async () => (calls.push("close"), {}),
    prompt: async () => (calls.push("prompt"), { stopReason: "end_turn" }),
    cancel: async () => {},
    signal: { aborted: false },
  };
  const live = { conn, caps: { loadSession: true, listSessions: true, closeSession: true, images: false }, generation: 1 };
  const agent = { id: "a", generation: 1, running: true, cfg: { kind: "other", env: {} }, get: async () => (await gate, live) };
  const pool = { agents: new Map([["a", agent]]), has: (id: string) => id === "a", agent: () => agent };
  let ended!: () => void;
  const turnEnded = new Promise<void>((r) => (ended = r));
  const events: SessionEvents = {
    boundTargets: () => [], turnStarted() {}, update() {}, turnEnded: () => ended(), turnError: (_t, m) => assert.fail(m),
    interactionRequested() {}, interactionResolved() {}, stateChanged() {}, sessionLost() {},
  };
  const cfg = { session_lifecycle: { mode: "after_turn", max_open_sessions: 3, idle_close_minutes: 30, busy_hold_minutes: 10 }, permission_timeout_s: 1800 } as Config;
  let now = 0;
  const sm = new SessionManager(cfg, pool as never, events, createLogger("test"), () => now);
  release();
  const ref = await sm.newSession("a", "/w");
  gate = new Promise((r) => (release = r)); // the agent is now slow to answer get()
  now += 31 * 60_000;
  const ticking = sm.tick(); // idle /new session: the policy decides to close it, then awaits the agent
  sm.enqueue(ref, { text: "hi", origin: "text", uploads: [], from: { gateway: "g", conversation_id: "c" } });
  await new Promise((r) => setImmediate(r)); // the turn starts and also waits for the agent
  release();
  await ticking;
  await turnEnded;
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(calls, ["prompt", "close"]); // no close/load before the prompt; after_turn closes after it
});
