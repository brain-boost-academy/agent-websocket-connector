// protects=welcome.gateway.agent_instructions of the link a request came on reaches the agent process as systemPrompt (append): a prompt without a session, session.new, session.attach, and the load of the next turn; a gateway without instructions sends none; `agent-connector hook session-instructions` (opencode plugin) prints the text only while the connector runs a turn of that session;
// fails_when=one of the router paths drops the text, the text of another gateway is used, the field reaches the agent although the gateway sent none;
// no_claim=reload rules for open sessions (unit-instructions), real claude-agent-acp (test:adapters)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeGateway } from "./helpers/fake-gateway.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
/** The opencode plugin's call (async: the daemon runs in this process). */
function hookInstructions(session_id: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile(process.execPath, [MAIN, "hook", "session-instructions"], { env: { ...process.env, AGENT_CONNECTOR_SOCKET: h.socket }, timeout: 10_000 }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
    child.stdin!.end(JSON.stringify({ session_id }));
  });
}

let tg: FakeGateway;
let plain: FakeGateway;
let h: Harness;
const TEXT = "The user reads you in Telegram.";
const SP = { mode: "append", content: [{ type: "text", text: TEXT }] };

before(async () => {
  tg = new FakeGateway({ agentInstructions: TEXT });
  plain = new FakeGateway();
  await Promise.all([tg.start(), plain.start()]);
  h = await startHarness([{ name: "tg", gw: tg }, { name: "plain", gw: plain }], { agentEnv: { FAKE_AGENT_SYSTEM_PROMPT: "1" } });
  await Promise.all([tg.waitFor("sync"), plain.waitFor("sync")]);
});

after(async () => {
  await h.stop();
  await Promise.all([tg.stop(), plain.stop()]);
});

const calls = (from: number, m: string, sid?: string) => h.agentLog().slice(from).filter((c) => c.m === m && (!sid || c.sessionId === sid));

async function turn(gw: FakeGateway, conv: string, text: string) {
  const from = gw.received.length;
  const acc = await gw.request("conversation.prompt", { conversation_id: conv, text, origin: "text" });
  const end = await Promise.race([gw.waitFor("turn.ended", () => true, 8000, from), gw.waitFor("turn.error", () => true, 8000, from)]);
  assert.equal(end.type, "turn.ended", JSON.stringify(end.payload));
  return acc.session as { agent_id: string; session_id: string; cwd: string };
}

test("a prompt without a session: session/new and the next session/load carry the gateway's instructions", async () => {
  const from = h.agentLog().length;
  const session = await turn(tg, "t1", "one");
  assert.deepEqual(calls(from, "newSession", session.session_id)[0]?.systemPrompt, SP);
  const from2 = h.agentLog().length;
  await turn(tg, "t1", "two"); // after_turn closed it: loaded again
  assert.deepEqual(calls(from2, "loadSession", session.session_id)[0]?.systemPrompt, SP);
});

test("session.new and session.attach carry the instructions of the link they came on", async () => {
  const from = h.agentLog().length;
  const created = await tg.request("session.new", { conversation_id: "t2" });
  assert.deepEqual(calls(from, "newSession", created.session.session_id)[0]?.systemPrompt, SP);

  const session = await turn(plain, "p1", "from the plain gateway");
  assert.equal(calls(from, "newSession", session.session_id)[0]?.systemPrompt, undefined, "no instructions from this gateway");
  const from2 = h.agentLog().length;
  await tg.request("session.attach", { conversation_id: "t3", session });
  assert.deepEqual(calls(from2, "loadSession", session.session_id)[0]?.systemPrompt, SP);
  const from3 = h.agentLog().length;
  await turn(plain, "p1", "again from plain");
  const load = calls(from3, "loadSession", session.session_id);
  assert.equal(load.length, 1, "the plain turn loads the session again");
  assert.equal(load[0]!.systemPrompt, undefined);
});

test("hook session-instructions: the text while a turn of the session runs, nothing after it or for another session", async () => {
  const from = tg.received.length;
  const acc = await tg.request("conversation.prompt", { conversation_id: "t4", text: "work [slow]", origin: "text" });
  await tg.waitFor("turn.started", () => true, 5000, from);
  assert.equal(await hookInstructions(acc.session.session_id), TEXT);
  assert.equal(await hookInstructions("ses_unknown"), "");
  await tg.request("session.cancel", { conversation_id: "t4" });
  await tg.waitFor("turn.ended", (p) => p.session.session_id === acc.session.session_id, 8000, from);
  assert.equal(await hookInstructions(acc.session.session_id), "", "a later TUI turn of the same session gets nothing");
});
