// protects=session open/close ordering against the agent (no session/load while session/close of the same id is in flight, one load for concurrent attaches), set_mode on a session not yet opened, never-run (/new) sessions closed and unbound after idle_close_minutes, pruning of idle session records;
// fails_when=a slow close undoes a load and the next turn fails, two attaches load the same session twice, an unknown mode chosen before the first load fails the turn, a /new session stays open forever or stays bound after it was closed, closed idle records pile up;
// no_claim=real claude-agent-acp close/load timing (test:adapters), memory use of a long-running daemon
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeGateway } from "./helpers/fake-gateway.ts";
import { startHarness, waitUntil, type Harness } from "./helpers/harness.ts";

let gw: FakeGateway;
let h: Harness;

before(async () => {
  gw = new FakeGateway();
  await gw.start();
  // after_turn (default): every turn ends with session/close, which the agent answers slowly
  h = await startHarness([{ name: "tg", gw }], { agentEnv: { FAKE_AGENT_CLOSE_DELAY_MS: "400" } });
  await gw.waitFor("sync");
});

after(async () => {
  await h.stop();
  await gw.stop();
});

const MIN = 60_000;
const log = (from: number, m: string, sid?: string) => h.agentLog().slice(from).filter((c) => c.m === m && (!sid || c.sessionId === sid));

async function turn(conv: string, text: string) {
  const from = gw.received.length;
  const acc = await gw.request("conversation.prompt", { conversation_id: conv, text, origin: "text" });
  const end = await Promise.race([gw.waitFor("turn.ended", () => true, 8000, from), gw.waitFor("turn.error", () => true, 8000, from)]);
  return { session: acc.session, end };
}

test("a prompt right after a turn waits for the in-flight session/close before session/load", async () => {
  const first = await turn("c1", "one");
  assert.equal(first.end.type, "turn.ended");
  // the after_turn close of "one" is still running in the agent
  const second = await turn("c1", "two");
  assert.equal(second.end.type, "turn.ended", JSON.stringify(second.end.payload));
  assert.equal((second.end.payload as { text: string }).text, "echo: two");
  await waitUntil(() => log(0, "closeSession.done", first.session.session_id).length === 2, 3000, "second close done");
  // replay the agent's view: a load must never overlap a close of the same session
  let closing = 0;
  const seq = h.agentLog().filter((c) => c.sessionId === first.session.session_id).map((c) => c.m);
  for (const m of seq) {
    if (m === "closeSession") closing++;
    if (m === "closeSession.done") closing--;
    if (m === "loadSession") assert.equal(closing, 0, `load during close: ${seq.join(",")}`);
  }
  assert.ok(seq.includes("loadSession"), seq.join(","));
});

test("two concurrent attaches of a closed session run one session/load", async () => {
  const { session } = await turn("c2", "hello");
  // crash the agent: while it restarts, both attaches wait for the process at the same point
  const from = gw.received.length;
  await gw.request("conversation.prompt", { conversation_id: "c-crash", text: "die [crash]", origin: "text" });
  await gw.waitFor("turn.error", () => true, 8000, from);
  const mark = h.agentLog().length;
  const [a, b] = await Promise.all([
    gw.request("session.attach", { conversation_id: "c3", session }),
    gw.request("session.attach", { conversation_id: "c4", session }),
  ]);
  assert.equal(a.last_assistant_text, "echo: hello");
  assert.equal(b.last_assistant_text, "echo: hello");
  assert.equal(log(mark, "loadSession", session.session_id).length, 1);
});

test("a never-run session (/new) is closed after idle_close_minutes and its conversation unbound", async () => {
  const created = await gw.request("session.new", { conversation_id: "c5" });
  const mark = h.agentLog().length;
  const from = gw.received.length;
  await h.daemon.sessions.tick();
  assert.equal(log(mark, "closeSession", created.session.session_id).length, 0);
  h.advance(31 * MIN);
  await h.daemon.sessions.tick();
  await waitUntil(() => log(mark, "closeSession", created.session.session_id).length === 1, 3000, "closeSession");
  const st = await gw.waitFor("session.state", (p) => p.conversation_id === "c5" && p.session === null, 3000, from);
  assert.equal(st.payload.agent_id, "fake");
});

test("closed idle session records are pruned after idle_close_minutes", async () => {
  await waitUntil(() => h.daemon.sessions.summary().every((s) => !s.open), 3000, "all closed");
  h.advance(31 * MIN);
  await h.daemon.sessions.tick();
  assert.deepEqual(h.daemon.sessions.summary(), []);
  // a pruned session still works: it is loaded again on the next prompt
  const again = await turn("c1", "three");
  assert.equal(again.end.type, "turn.ended");
});

test("set_mode before the first load: an unknown mode does not fail the turn, the state shows the real mode", async () => {
  const { session } = await turn("c6", "x");
  await waitUntil(() => !h.daemon.sessions.info(session).open, 3000, "closed");
  await h.restart(); // modes of the session are unknown again
  await waitUntil(() => h.daemon.router.links.get("tg")!.online, 5000, "reconnected");
  const r = await gw.request("session.set_mode", { conversation_id: "c6", mode_id: "bogus" });
  assert.equal(r.mode_id, "bogus");
  const from = gw.received.length;
  const res = await turn("c6", "y");
  assert.equal(res.end.type, "turn.ended", JSON.stringify(res.end.payload));
  const st = await gw.waitFor("session.state", (p) => p.conversation_id === "c6" && p.modes?.current === "default" && !p.busy, 3000, from);
  assert.deepEqual(st.payload.modes!.available.map((m) => m.id), ["default", "plan"]);
  // now the modes are known: unknown ids are rejected up front
  await assert.rejects(gw.request("session.set_mode", { conversation_id: "c6", mode_id: "bogus" }), /unknown mode/);
});
