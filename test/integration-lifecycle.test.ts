// protects=lru mode keeps sessions open between turns and reloads only when the Claude transcript changed outside the connector (R13), lru eviction cap, active_elsewhere warning, set_mode survives reloads, agent.select starts a new session;
// fails_when=an lru session is reloaded on every prompt or not reloaded after an external write, more than max_open_sessions stay open, the warning fires for our own writes or misses a fresh external write, the mode is lost after close/load;
// no_claim=real Claude transcript format (only mtime/size are compared), memory use
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync } from "node:fs";
import { FakeGateway } from "./helpers/fake-gateway.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";
import { claudeTranscriptPath } from "../src/acp/transcript.ts";

let gw: FakeGateway;
let h: Harness;

before(async () => {
  gw = new FakeGateway();
  await gw.start();
  h = await startHarness([{ name: "tg", gw }], { lifecycle: { mode: "lru", max_open_sessions: 2 } });
  await gw.waitFor("sync");
});

after(async () => {
  await h.stop();
  await gw.stop();
});

const calls = (from: number, m: string, sid?: string) => h.agentLog().slice(from).filter((c) => c.m === m && (!sid || c.sessionId === sid)).length;

async function turn(conv: string, text: string) {
  const from = gw.received.length;
  const acc = await gw.request("conversation.prompt", { conversation_id: conv, text, origin: "text" });
  await gw.waitFor("turn.ended", () => true, 8000, from);
  return acc.session;
}

test("lru: no reload between turns; external transcript change → close + load (R13)", async () => {
  const s = await turn("c1", "one");
  let mark = h.agentLog().length;
  await turn("c1", "two");
  assert.equal(calls(mark, "loadSession", s.session_id), 0);
  assert.equal(calls(mark, "closeSession", s.session_id), 0);

  // cloudcli appends to the same transcript
  appendFileSync(claudeTranscriptPath(s.session_id, s.cwd, h.claudeDir), JSON.stringify({ type: "user", text: "from cloudcli" }) + "\n");
  mark = h.agentLog().length;
  await turn("c1", "three");
  assert.equal(calls(mark, "closeSession", s.session_id), 1);
  assert.equal(calls(mark, "loadSession", s.session_id), 1);
});

test("active_elsewhere: only for a fresh transcript change made outside the connector", async () => {
  const s = await turn("c2", "hello");
  // our own write just now does not count
  let r = await gw.request("session.attach", { conversation_id: "c9", session: s });
  assert.equal(r.warning, undefined);
  appendFileSync(claudeTranscriptPath(s.session_id, s.cwd, h.claudeDir), "{}\n");
  r = await gw.request("session.attach", { conversation_id: "c9", session: s });
  assert.equal(r.warning, "active_elsewhere");
  assert.equal(r.last_assistant_text, "echo: hello");
});

test("lru eviction: at most max_open_sessions stay open per agent", async () => {
  const mark = h.agentLog().length;
  await turn("c3", "a");
  await turn("c4", "b");
  await turn("c5", "c");
  const open = h.daemon.sessions.summary().filter((s) => s.open).length;
  assert.ok(open <= 2, `open sessions: ${open}`);
  assert.ok(calls(mark, "closeSession") >= 1);
});

test("set_mode is applied and re-applied after the session is reloaded", async () => {
  const from = gw.received.length;
  const s = await turn("c6", "x");
  const r = await gw.request("session.set_mode", { conversation_id: "c6", mode_id: "plan" });
  assert.equal(r.mode_id, "plan");
  const st = await gw.waitFor("session.state", (p) => p.conversation_id === "c6" && p.modes?.current === "plan", 3000, from);
  assert.deepEqual(st.payload.modes!.available.map((m) => m.id), ["default", "plan"]);
  await assert.rejects(gw.request("session.set_mode", { conversation_id: "c6", mode_id: "nope" }), /unknown mode/);
  // force a reload (external write) and check the mode is set again after session/load
  appendFileSync(claudeTranscriptPath(s.session_id, s.cwd, h.claudeDir), "{}\n");
  const mark = h.agentLog().length;
  await turn("c6", "y");
  const seq = h.agentLog().slice(mark).filter((c) => c.sessionId === s.session_id && c.m !== "closeSession.done").map((c) => `${c.m}${c.modeId ? `:${c.modeId}` : ""}`);
  assert.deepEqual(seq.slice(0, 4), ["closeSession", "loadSession", "setSessionMode:plan", "prompt"]);
});

test("agent.select clears the session; the next prompt creates a new one", async () => {
  const s1 = await turn("c7", "first");
  const r = await gw.request("agent.select", { conversation_id: "c7", agent_id: "fake" });
  assert.equal(r.agent_id, "fake");
  const s2 = await turn("c7", "second");
  assert.notEqual(s1.session_id, s2.session_id);
  await assert.rejects(gw.request("agent.select", { conversation_id: "c7", agent_id: "nope" }), /unknown agent/);
});

test("sessions.list pages with a cursor without repeating items", async () => {
  const page1 = await gw.request("sessions.list", { conversation_id: "c1", limit: 2 });
  assert.equal(page1.items.length, 2);
  assert.ok(page1.next_cursor);
  const page2 = await gw.request("sessions.list", { conversation_id: "c1", limit: 2, cursor: page1.next_cursor! });
  assert.ok(page2.items.length >= 1);
  const ids = new Set([...page1.items, ...page2.items].map((i) => i.session.session_id));
  assert.equal(ids.size, page1.items.length + page2.items.length);
  assert.ok([...page1.items, ...page2.items].every((i) => i.busy === "idle"));
});
