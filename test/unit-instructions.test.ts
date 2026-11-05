// protects=channel instructions reach the agent as ACP systemPrompt (append) on session/new and session/load, an open session started with other instructions is reloaded, except a never-run session (D4), one with background tasks (D6) an agent without systemPrompt (no reload loop, C1) or one that cannot load or close sessions; the check also runs in after_turn for a session that stayed open (OV#4); turnInstructions only while the connector runs a turn;
// fails_when=systemPrompt is missing or sent to an agent that did not advertise it, a /new session is lost because the text changed, background work is killed, lru reloads on every prompt, the opencode plugin sees instructions for a session the connector is not running;
// no_claim=what a real agent does with systemPrompt (test/adapters/claude.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionManager, type SessionEvents } from "../src/acp/session-manager.ts";
import type { Config } from "../src/daemon/config.ts";
import { createLogger } from "../src/log.ts";

process.env.AGENT_CONNECTOR_LOG ??= "error";

type Call = { m: string; systemPrompt?: unknown; _meta?: unknown };
type Caps = { loadSession: boolean; listSessions: boolean; closeSession: boolean; images: boolean; systemPrompt: boolean };

function setup(o: { caps?: Partial<Caps>; mode?: "after_turn" | "lru"; kind?: string; holdOpen?: boolean } = {}) {
  const calls: Call[] = [];
  let seen: string | undefined;
  let sm!: SessionManager;
  let n = 0;
  const conn = {
    newSession: async (p: { systemPrompt?: unknown; _meta?: unknown }) => (calls.push({ m: "new", systemPrompt: p.systemPrompt, ...(p._meta ? { _meta: p._meta } : {}) }), { sessionId: `s${++n}`, modes: null }),
    loadSession: async (p: { systemPrompt?: unknown; _meta?: unknown }) => (calls.push({ m: "load", systemPrompt: p.systemPrompt, ...(p._meta ? { _meta: p._meta } : {}) }), {}),
    closeSession: async () => (calls.push({ m: "close" }), {}),
    prompt: async (p: { sessionId: string }) => {
      calls.push({ m: "prompt" });
      seen = sm.turnInstructions(p.sessionId);
      if (o.holdOpen && calls.filter((c) => c.m === "prompt").length === 1) {
        void sm.onRequestPermission("a", { sessionId: p.sessionId, toolCall: { toolCallId: "t1" }, options: [] } as never);
      }
      return { stopReason: "end_turn" };
    },
    cancel: async () => {},
    signal: { aborted: false },
  };
  const caps: Caps = { loadSession: true, listSessions: true, closeSession: true, images: false, systemPrompt: true, ...o.caps };
  const live = { conn, caps, generation: 1 };
  const agent = { id: "a", generation: 1, running: true, cfg: { kind: o.kind ?? "other", env: {} }, get: async () => live };
  const pool = { agents: new Map([["a", agent]]), has: (id: string) => id === "a", agent: () => agent };
  let ended: (() => void) | undefined;
  const lost: string[] = [];
  const events: SessionEvents = {
    boundTargets: () => [], turnStarted() {}, update() {}, turnEnded: () => ended?.(), turnError: (_t, m) => assert.fail(m),
    interactionRequested() {}, interactionResolved() {}, stateChanged() {}, sessionLost: (r) => void lost.push(r.session_id),
  };
  const cfg = { session_lifecycle: { mode: o.mode ?? "lru", max_open_sessions: 3, idle_close_minutes: 30, busy_hold_minutes: 10 }, permission_timeout_s: 1800 } as Config;
  sm = new SessionManager(cfg, pool as never, events, createLogger("test"), () => 0);
  const from = { gateway: "g", conversation_id: "c" };
  async function prompt(ref: Parameters<SessionManager["enqueue"]>[0], instructions?: string) {
    const done = new Promise<void>((r) => (ended = r));
    sm.enqueue(ref, { text: "hi", origin: "text", uploads: [], from, instructions });
    await done;
    await new Promise((r) => setTimeout(r, 5)); // the after_turn close runs after turnEnded
  }
  const sp = (text: string) => ({ mode: "append", content: [{ type: "text", text }] });
  return { sm, calls, lost, prompt, sp, seen: () => seen, names: () => calls.map((c) => c.m) };
}

test("systemPrompt goes to session/new and session/load when the agent advertises it", async () => {
  const t = setup({ mode: "after_turn" });
  const ref = await t.sm.newSession("a", "/w", "TG");
  assert.deepEqual(t.calls[0], { m: "new", systemPrompt: t.sp("TG") });
  await t.prompt(ref, "TG");
  assert.equal(t.seen(), "TG");
  assert.equal(t.sm.turnInstructions(ref.session_id), undefined, "only while the turn runs");
  await t.prompt(ref, "TG"); // after_turn closed it: loaded again with the text
  assert.deepEqual(t.names(), ["new", "prompt", "close", "load", "prompt", "close"]);
  assert.deepEqual(t.calls[3], { m: "load", systemPrompt: t.sp("TG") });
  await t.prompt(ref, undefined); // a gateway without instructions: no field
  assert.equal(t.calls.findLast((c) => c.m === "load")!.systemPrompt, undefined);
});

test("claude: the same text with snapshot: false, so Claude Code does not freeze it into the session's recorded prompt", async () => {
  const t = setup({ kind: "claude", mode: "after_turn" });
  const ref = await t.sm.newSession("a", "/w", "TG");
  const meta = { claudeCode: { options: { systemPrompt: { type: "preset", preset: "claude_code", append: "TG", snapshot: false } } } };
  assert.deepEqual(t.calls[0], { m: "new", systemPrompt: t.sp("TG"), _meta: meta });
  await t.prompt(ref, "TG");
  await t.prompt(ref, "TG");
  assert.deepEqual(t.calls.find((c) => c.m === "load"), { m: "load", systemPrompt: t.sp("TG"), _meta: meta });
  await t.prompt(ref, undefined);
  assert.deepEqual(t.calls.findLast((c) => c.m === "load"), { m: "load", systemPrompt: undefined });
});

test("an agent without systemPrompt gets no field and lru does not reload on every prompt", async () => {
  const t = setup({ caps: { systemPrompt: false }, kind: "opencode" });
  const ref = await t.sm.newSession("a", "/w", "TG");
  assert.equal(t.calls[0]!.systemPrompt, undefined);
  await t.prompt(ref, "TG");
  await t.prompt(ref, "TG");
  assert.deepEqual(t.names(), ["new", "prompt", "prompt"]);
  assert.equal(t.seen(), "TG", "the opencode plugin still gets the text of the running turn");
});

test("lru: a session that ran is reloaded when the instructions change, and not again while they stay", async () => {
  const t = setup();
  const ref = await t.sm.newSession("a", "/w", "A");
  await t.prompt(ref, "A");
  await t.prompt(ref, "B");
  await t.prompt(ref, "B");
  assert.deepEqual(t.names(), ["new", "prompt", "close", "load", "prompt", "prompt"]);
  assert.deepEqual(t.calls[3], { m: "load", systemPrompt: t.sp("B") });
});

test("a never-run session is not closed when the instructions change: the turn runs, the session is not lost (D4)", async () => {
  const t = setup();
  const ref = await t.sm.newSession("a", "/w", "A");
  await t.prompt(ref, "B");
  assert.deepEqual(t.names(), ["new", "prompt"]);
  assert.deepEqual(t.lost, []);
});

test("a session with background tasks is not closed when the instructions change (D6)", async () => {
  const t = setup();
  const ref = await t.sm.newSession("a", "/w", "A");
  await t.prompt(ref, "A");
  t.sm.onSessionUpdate("a", { sessionId: ref.session_id, update: { sessionUpdate: "tool_call", toolCallId: "bg1", title: "Bash", rawInput: { run_in_background: true } } as never });
  await t.prompt(ref, "B");
  assert.deepEqual(t.names(), ["new", "prompt", "prompt"]);
});

test("after_turn: a session that stayed open is reloaded on a change too (the check runs before the lru-only return)", async () => {
  const t = setup({ mode: "after_turn", holdOpen: true }); // a permission left pending holds it open
  const ref = await t.sm.newSession("a", "/w", "A");
  await t.prompt(ref, "A");
  assert.deepEqual(t.names(), ["new", "prompt"], "held open after the turn");
  await t.prompt(ref, "B");
  assert.deepEqual(t.names(), ["new", "prompt", "close", "load", "prompt"]);
  assert.deepEqual(t.calls[3], { m: "load", systemPrompt: t.sp("B") });
});

test("an agent that cannot load sessions keeps the open session when the instructions change", async () => {
  const t = setup({ caps: { loadSession: false } });
  const ref = await t.sm.newSession("a", "/w", "A");
  await t.prompt(ref, "A");
  await t.prompt(ref, "B");
  assert.deepEqual(t.names(), ["new", "prompt", "prompt"]);
  assert.deepEqual(t.lost, []);
});

test("an agent that cannot close sessions keeps the open session: no second session/load into it", async () => {
  const t = setup({ mode: "after_turn", caps: { closeSession: false } }); // no session/close: it stays open
  const ref = await t.sm.newSession("a", "/w", "A");
  await t.prompt(ref, "A");
  await t.prompt(ref, "B");
  assert.deepEqual(t.names(), ["new", "prompt", "prompt"]);
});
