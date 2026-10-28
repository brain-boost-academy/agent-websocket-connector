// protects=gateway prompt reaches the ACP agent and the answer, tools, cost and turn end flow back to the same conversation; sync snapshot content; load-replay suppression with preview (R4); queue merge; /stop; crash → turn.error;
// fails_when=chunks go to another conversation, a never-run session stays bound after its process died, turn.ended lacks text/cost/tool_calls, replayed history reaches the gateway, queued prompts are not merged, cancel does not end the turn as cancelled, a crash leaves the turn hanging;
// no_claim=real claude-agent-acp behaviour (test:adapters), Telegram rendering
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeGateway } from "./helpers/fake-gateway.ts";
import { startHarness, waitUntil, type Harness } from "./helpers/harness.ts";

let gw: FakeGateway;
let h: Harness;

before(async () => {
  gw = new FakeGateway();
  await gw.start();
  h = await startHarness([{ name: "tg", gw }]);
  await gw.waitFor("sync");
});

after(async () => {
  await h.stop();
  await gw.stop();
});

test("hello advertises the agent with its caps; sync follows welcome", async () => {
  const hello = await gw.waitFor("hello");
  assert.equal(hello.payload.agents[0]!.agent_id, "fake");
  assert.deepEqual(hello.payload.agents[0]!.caps, { load_session: true, list_sessions: true, images: true });
  const types = gw.received.map((e) => e.type);
  assert.ok(types.indexOf("sync") > types.indexOf("hello"));
});

test("full cycle: prompt → turn.started → session.update chunks → turn.ended with text, cost, tool calls", async () => {
  const from = gw.received.length;
  const acc = await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "hello [tools]", origin: "text" });
  assert.equal(acc.queued_position, 0);
  assert.equal(acc.session.agent_id, "fake");
  assert.equal(acc.session.cwd, h.workDir);
  const ended = await gw.waitFor("turn.ended", () => true, 8000, from);
  assert.deepEqual(ended.payload.conversation_ids, ["chat-1"]);
  assert.equal(ended.payload.stop_reason, "end_turn");
  assert.equal(ended.payload.text, "echo: hello [tools]");
  assert.equal(ended.payload.tool_calls, 2);
  assert.equal(ended.payload.cost_usd, 0.0123);
  const started = gw.received.slice(from).find((e) => e.type === "turn.started")!;
  assert.equal((started.payload as { turn_id: string }).turn_id, ended.payload.turn_id);
  const chunks = gw.received.slice(from).filter((e) => e.type === "session.update" && (e.payload as { update: { sessionUpdate: string } }).update.sessionUpdate === "agent_message_chunk");
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.equal((c.payload as { turn_id?: string }).turn_id, ended.payload.turn_id);
  // the new session is bound to the conversation
  const st = gw.received.slice(from).filter((e) => e.type === "session.state").at(-1)!;
  assert.equal((st.payload as { session: { session_id: string } }).session.session_id, acc.session.session_id);
});

test("after_turn: the session is closed after the turn, the next prompt reloads it with replay suppressed", async () => {
  const before = h.agentLog().length;
  const from = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "second", origin: "text" });
  const ended = await gw.waitFor("turn.ended", () => true, 8000, from);
  assert.equal(ended.payload.text, "echo: second");
  const calls = h.agentLog().slice(before).map((c) => c.m);
  assert.ok(calls.includes("loadSession"), `expected loadSession, got ${calls.join(",")}`);
  await waitUntil(() => h.agentLog().slice(before).filter((c) => c.m === "closeSession").length >= 1, 3000, "closeSession");
  // replay of the first turn ("echo: hello [tools]") must not reach the gateway
  const leaked = gw.received.slice(from).filter((e) => e.type === "session.update" && JSON.stringify(e.payload).includes("hello [tools]"));
  assert.deepEqual(leaked, []);
});

test("after_turn: a run_in_background tool call holds the session open after the turn", async () => {
  const before = h.agentLog().length;
  const from = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "chat-bg", text: "start job [background]", origin: "text" });
  await gw.waitFor("turn.ended", () => true, 8000, from);
  await new Promise((r) => setTimeout(r, 500));
  assert.equal(h.agentLog().slice(before).filter((c) => c.m === "closeSession").length, 0, "held session must not be closed");
  const acc = (gw.received.slice(from).find((e) => e.type === "turn.started")!.payload as { session: { agent_id: string; session_id: string } }).session;
  assert.equal(h.daemon.sessions.info(acc as never).open, true);
});

test("session.attach on a closed session loads it silently and returns the last agent text as preview", async () => {
  const list = await gw.request("sessions.list", { conversation_id: "chat-1" });
  const s = list.items[0]!.session;
  const from = gw.received.length;
  const r = await gw.request("session.attach", { conversation_id: "chat-2", session: s });
  assert.equal(r.last_assistant_text, "echo: second");
  assert.equal(r.warning, undefined);
  assert.deepEqual(gw.received.slice(from).filter((e) => e.type === "session.update"), []);
});

test("prompts queued during a turn are merged into one prompt", async () => {
  const from = gw.received.length;
  const a = await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "first [slow]", origin: "text" });
  assert.equal(a.queued_position, 0);
  await gw.waitFor("turn.started", () => true, 5000, from);
  const b = await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "queued one", origin: "text" });
  const c = await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "queued two", origin: "voice" });
  assert.equal(b.queued_position, 1);
  assert.equal(c.queued_position, 2);
  const st = await gw.waitFor("session.state", (p) => p.queue_length === 2, 5000, from);
  assert.equal(st.payload.busy, true);
  const cancel = await gw.request("session.cancel", { conversation_id: "chat-1" });
  assert.equal(cancel.cancelled, true);
  const first = await gw.waitFor("turn.ended", () => true, 5000, from);
  assert.equal(first.payload.stop_reason, "cancelled");
  // /stop also drops the queue: no further turn starts
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(gw.received.slice(from).filter((e) => e.type === "turn.started").length, 1);

  const from2 = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "again [slow]", origin: "text" });
  await gw.waitFor("session.update", (p) => JSON.stringify(p.update).includes("working"), 5000, from2);
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "m1", origin: "text" });
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "m2", origin: "text" });
  const sync = h.daemon.router.sync(h.daemon.router.links.get("tg")!);
  assert.equal(sync.running_turns.length, 1);
  assert.equal(sync.running_turns[0]!.text_so_far, "working");
  // chat-2 attached the same session above: the turn is pinned to both bound conversations
  assert.deepEqual(sync.running_turns[0]!.conversation_ids, ["chat-1", "chat-2"]);
  assert.equal(sync.conversations.find((c) => c.conversation_id === "chat-1")!.queue_length, 2);
  await h.daemon.sessions.cancel(sync.running_turns[0]!.session); // drops the queue too
  await gw.waitFor("turn.ended", (p) => p.stop_reason === "cancelled", 5000, from2);

  const from3 = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "busy [permission]", origin: "text" });
  const perm = await gw.waitFor("permission.request", () => true, 5000, from3);
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "m1", origin: "text" });
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "m2", origin: "voice" });
  gw.send("permission.respond", { request_id: perm.payload.request_id, outcome: { outcome: "selected", optionId: "allow-once" } });
  const merged = await gw.waitFor("turn.ended", (p) => p.text.startsWith("echo: m1"), 8000, from3);
  assert.equal(merged.payload.text, "echo: m1\n\nm2");
});

test("agent crash → turn.error for the running turn; the agent restarts and the session continues", async () => {
  const fresh = await gw.request("session.new", { conversation_id: "fresh" }); // never prompted: dies with the process
  const from = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "die [crash]", origin: "text" });
  const err = await gw.waitFor("turn.error", () => true, 8000, from);
  assert.match(err.payload.message, /exited/);
  const unbound = await gw.waitFor("session.state", (p) => p.conversation_id === "fresh" && p.session === null, 5000, from);
  assert.equal(unbound.payload.agent_id, fresh.session.agent_id);
  const from2 = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "after crash", origin: "text" });
  const ended = await gw.waitFor("turn.ended", () => true, 10000, from2);
  assert.equal(ended.payload.text, "echo: after crash");
});

test("invalid frames get error invalid_message and the link stays up", async () => {
  const from = gw.received.length;
  gw.sendRaw(JSON.stringify({ v: 1, id: "bad-1", type: "conversation.prompt", ts: "x", payload: { conversation_id: 5 } }));
  const e = await gw.waitFor("error", () => true, 3000, from);
  assert.equal(e.payload.code, "invalid_message");
  assert.equal(e.re, "bad-1");
  const list = await gw.request("sessions.list", { conversation_id: "chat-1" });
  assert.ok(list.items.length >= 1);
});
