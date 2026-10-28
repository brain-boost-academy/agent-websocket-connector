// Opt-in (npm run test:adapters, needs a logged-in `claude`; costs a few cents). Required before bumping
// the pinned @agentclientprotocol/claude-agent-acp version (R7).
// protects=the M0 facts the connector relies on, through the real connector stack: sessionId == jsonl name, session/list sees a `claude -p` session, load replay is suppressed and gives a preview, permission option kinds, AskUserQuestion → form elicitation with a `_custom` free-text field, cancel → stop_reason cancelled, cost in turn.ended;
// fails_when=a new adapter version changes any of these;
// no_claim=opencode (see opencode.test.ts), Telegram rendering
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { FakeGateway } from "../helpers/fake-gateway.ts";
import { startHarness, type Harness } from "../helpers/harness.ts";
import { claudeTranscriptPath } from "../../src/acp/transcript.ts";

const CLAUDE = process.env.CLAUDE_CODE_EXECUTABLE ?? join(homedir(), ".local/bin/claude");
const MODEL = process.env.ADAPTER_TEST_MODEL ?? "haiku";
const skip = existsSync(CLAUDE) ? false : `claude not found at ${CLAUDE}`;

let gw: FakeGateway;
let h: Harness;
const T = 180_000;

before(async () => {
  if (skip) return;
  gw = new FakeGateway();
  await gw.start();
  h = await startHarness([{ name: "tg", gw }], {
    default_agent: "claude",
    agents: { claude: { env: { CLAUDE_CODE_EXECUTABLE: CLAUDE, ANTHROPIC_MODEL: MODEL } } },
  });
  await gw.waitFor("sync", () => true, 60_000);
});

after(async () => {
  if (skip) return;
  await h.stop();
  await gw.stop();
});

async function prompt(conv: string, text: string) {
  const from = gw.received.length;
  const acc = await gw.request("conversation.prompt", { conversation_id: conv, text, origin: "text" });
  return { acc, from };
}

test("initialize caps: load_session, list_sessions, images", { skip, timeout: T }, async () => {
  const hello = await gw.waitFor("hello");
  assert.deepEqual(hello.payload.agents[0]!.caps, { load_session: true, list_sessions: true, images: true });
});

let first: { agent_id: string; session_id: string; cwd: string };

test("turn: answer, cost; sessionId equals the jsonl transcript name", { skip, timeout: T }, async () => {
  const { acc, from } = await prompt("c1", "Reply with exactly the word: pong");
  const ended = await gw.waitFor("turn.ended", () => true, T, from);
  assert.equal(ended.payload.stop_reason, "end_turn");
  assert.match(ended.payload.text, /pong/i);
  assert.ok((ended.payload.cost_usd ?? 0) > 0, "cost_usd from usage_update");
  first = acc.session;
  assert.ok(existsSync(claudeTranscriptPath(first.session_id, first.cwd)), "jsonl named after the ACP sessionId");
});

test("after_turn reload: replayed history never reaches the gateway, preview from load", { skip, timeout: T }, async () => {
  const { from } = await prompt("c1", "What word did you reply with last time? Answer with that word only.");
  const ended = await gw.waitFor("turn.ended", () => true, T, from);
  assert.match(ended.payload.text, /pong/i);
  const replayed = gw.received.slice(from).filter((e) => e.type === "session.update" && ["user_message_chunk"].includes((e.payload as { update: { sessionUpdate: string } }).update.sessionUpdate));
  assert.deepEqual(replayed, [], "user_message_chunk only appears in load replay");
  const before = gw.received.length;
  const r = await gw.request("session.attach", { conversation_id: "c2", session: first });
  assert.match(r.last_assistant_text ?? "", /pong/i);
  assert.equal(gw.received.slice(before).filter((e) => e.type === "session.update").length, 0);
});

test("session/list sees a session created by `claude -p` in the same cwd", { skip, timeout: T }, async () => {
  const out = execFileSync(CLAUDE, ["-p", "--model", MODEL, "--output-format", "json", "Reply with exactly: from-cli"], { cwd: h.workDir, encoding: "utf8", timeout: T });
  const cliSession = JSON.parse(out).session_id as string;
  const list = await gw.request("sessions.list", { conversation_id: "c1", limit: 20 });
  assert.ok(list.items.some((i) => i.session.session_id === cliSession), "claude -p session listed");
  const r = await gw.request("session.attach", { conversation_id: "c3", session: { agent_id: "claude", session_id: cliSession, cwd: h.workDir } });
  assert.match(r.last_assistant_text ?? "", /from-cli/);
});

test("permission request: Bash asks with allow_once / reject_once options; reject reaches the agent", { skip, timeout: T }, async () => {
  const { from } = await prompt("c4", "Use the Bash tool to run exactly this command: touch adapter-permission-test.txt");
  const req = await gw.waitFor("permission.request", () => true, T, from);
  const kinds = req.payload.params.options.map((o) => o.kind);
  assert.ok(kinds.includes("allow_once") && kinds.includes("reject_once"), kinds.join(","));
  const reject = req.payload.params.options.find((o) => o.kind === "reject_once")!;
  gw.send("permission.respond", { request_id: req.payload.request_id, outcome: { outcome: "selected", optionId: reject.optionId } });
  await gw.waitFor("permission.resolved", (p) => p.request_id === req.payload.request_id, T, from);
  await gw.waitFor("turn.ended", () => true, T, from);
  assert.equal(existsSync(join(h.workDir, "adapter-permission-test.txt")), false);
});

test("AskUserQuestion arrives as a form elicitation with question_0 and question_0_custom", { skip, timeout: T }, async () => {
  const { from } = await prompt("c5", "Use the AskUserQuestion tool to ask me which color I like, with exactly the options red, green and blue. After my answer, reply with the chosen color only.");
  const el = await gw.waitFor("elicitation.request", () => true, T, from);
  const params = el.payload.params as unknown as { mode: string; requestedSchema: { properties: Record<string, { oneOf?: Array<{ const: string }> }> } };
  assert.equal(params.mode, "form");
  const props = params.requestedSchema.properties;
  assert.ok(props.question_0, Object.keys(props).join(","));
  assert.ok(props.question_0_custom, "free-text Other field");
  const options = (props.question_0.oneOf ?? []).map((o) => o.const.toLowerCase());
  assert.ok(options.some((o) => o.includes("green")), options.join(","));
  gw.send("elicitation.respond", { request_id: el.payload.request_id, action: "accept", content: { question_0_custom: "purple" } });
  const ended = await gw.waitFor("turn.ended", () => true, T, from);
  assert.match(ended.payload.text, /purple/i);
});

test("/stop during a turn ends it with stop_reason cancelled", { skip, timeout: T }, async () => {
  const { from } = await prompt("c6", "Write the numbers from 1 to 400, one per line, no other text.");
  await gw.waitFor("session.update", (p) => p.update.sessionUpdate === "agent_message_chunk", T, from);
  const t0 = Date.now();
  const r = await gw.request("session.cancel", { conversation_id: "c6" });
  assert.equal(r.cancelled, true);
  const ended = await gw.waitFor("turn.ended", () => true, T, from);
  assert.equal(ended.payload.stop_reason, "cancelled");
  assert.ok(Date.now() - t0 < 3000, "AC9: ≤3 s");
});
