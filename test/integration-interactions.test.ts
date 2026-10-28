// protects=AC17 permission fan-out to every gateway bound to the session with first-answer-wins, permission timeout → reject_once, /stop answers pending permission with cancelled, elicitation form round trip without timeout, sync.pending content;
// fails_when=a second gateway never sees the request, both answers are applied, the losing gateway is not told, a timeout picks an allow option, /stop leaves the agent waiting, an elicitation answer does not reach the agent;
// no_claim=Telegram button rendering, real adapter option/form shapes (test:adapters)
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { FakeGateway } from "./helpers/fake-gateway.ts";
import { startHarness, type Harness } from "./helpers/harness.ts";

let a: FakeGateway;
let b: FakeGateway;
let h: Harness;

before(async () => {
  a = new FakeGateway({ token: "tok-a" });
  b = new FakeGateway({ token: "tok-b" });
  await a.start();
  await b.start();
  h = await startHarness([{ name: "tg", gw: a }, { name: "web", gw: b }], { permission_timeout_s: 1 });
  await a.waitFor("sync");
  await b.waitFor("sync");
});

after(async () => {
  await h.stop();
  await a.stop();
  await b.stop();
});

async function sharedSession() {
  const created = await a.request("session.new", { conversation_id: "tg-chat" });
  await b.request("session.attach", { conversation_id: "web-tab", session: created.session });
  return created.session;
}

test("AC17: permission goes to both gateways, the first answer wins, the other gets permission.resolved", async () => {
  const session = await sharedSession();
  const fa = a.received.length;
  const fb = b.received.length;
  const acc = await a.request("conversation.prompt", { conversation_id: "tg-chat", text: "do it [permission]", origin: "text" });
  assert.equal(acc.session.session_id, session.session_id);
  const pa = await a.waitFor("permission.request", () => true, 5000, fa);
  const pb = await b.waitFor("permission.request", () => true, 5000, fb);
  assert.equal(pa.payload.request_id, pb.payload.request_id);
  assert.deepEqual(pa.payload.conversation_ids, ["tg-chat"]);
  assert.deepEqual(pb.payload.conversation_ids, ["web-tab"]);
  assert.deepEqual(pa.payload.params.options.map((o) => o.kind), ["allow_once", "reject_once"]);
  // pending interactions are part of the sync snapshot (R2)
  const snap = h.daemon.router.sync(h.daemon.router.links.get("web")!);
  assert.equal(snap.pending.length, 1);
  assert.equal(snap.pending[0]!.kind, "permission");
  assert.deepEqual(snap.pending[0]!.conversation_ids, ["web-tab"]);

  b.send("permission.respond", { request_id: pb.payload.request_id, outcome: { outcome: "selected", optionId: "reject" } });
  const ra = await a.waitFor("permission.resolved", () => true, 5000, fa);
  a.send("permission.respond", { request_id: pa.payload.request_id, outcome: { outcome: "selected", optionId: "allow-once" } }); // too late, ignored
  assert.equal(ra.payload.by, "user");
  assert.deepEqual(ra.payload.outcome, { outcome: "selected", optionId: "reject" });
  const ended = await a.waitFor("turn.ended", () => true, 5000, fa);
  assert.equal(ended.payload.text, 'permission: {"outcome":"selected","optionId":"reject"}');
  // both gateways got the turn (pinned to both conversations)
  await b.waitFor("turn.ended", (p) => p.turn_id === ended.payload.turn_id, 5000, fb);
});

test("permission timeout → reject_once and permission.resolved {by: timeout}", async () => {
  const fa = a.received.length;
  await a.request("conversation.prompt", { conversation_id: "tg-chat", text: "again [permission]", origin: "text" });
  const req = await a.waitFor("permission.request", () => true, 5000, fa);
  const res = await a.waitFor("permission.resolved", (p) => p.request_id === req.payload.request_id, 5000, fa);
  assert.equal(res.payload.by, "timeout");
  assert.deepEqual(res.payload.outcome, { outcome: "selected", optionId: "reject" });
  const ended = await a.waitFor("turn.ended", () => true, 5000, fa);
  assert.match(ended.payload.text, /"optionId":"reject"/);
});

test("/stop answers a pending permission with cancelled and the turn ends cancelled", async () => {
  const fa = a.received.length;
  await a.request("conversation.prompt", { conversation_id: "tg-chat", text: "third [permission]", origin: "text" });
  const req = await a.waitFor("permission.request", () => true, 5000, fa);
  const r = await a.request("session.cancel", { conversation_id: "tg-chat" });
  assert.equal(r.cancelled, true);
  const res = await a.waitFor("permission.resolved", (p) => p.request_id === req.payload.request_id, 5000, fa);
  assert.equal(res.payload.by, "cancelled");
  const ended = await a.waitFor("turn.ended", () => true, 5000, fa);
  assert.equal(ended.payload.stop_reason, "cancelled");
});

test("elicitation form: request reaches both gateways, answer returns to the agent, resolved fans out", async () => {
  const fa = a.received.length;
  const fb = b.received.length;
  await a.request("conversation.prompt", { conversation_id: "tg-chat", text: "ask [elicit]", origin: "text" });
  const ea = await a.waitFor("elicitation.request", () => true, 5000, fa);
  await b.waitFor("elicitation.request", () => true, 5000, fb);
  const schema = ea.payload.params as unknown as { requestedSchema: { properties: Record<string, unknown> } };
  assert.ok("question_0_custom" in schema.requestedSchema.properties);
  // no timeout for questions (R20): still pending after the permission timeout elapsed
  await new Promise((r) => setTimeout(r, 1300));
  assert.equal(h.daemon.sessions.pendingInteractions().length, 1);
  a.send("elicitation.respond", { request_id: ea.payload.request_id, action: "accept", content: { question_0_custom: "purple" } });
  const ended = await a.waitFor("turn.ended", () => true, 5000, fa);
  assert.equal(ended.payload.text, 'elicitation: {"action":"accept","content":{"question_0_custom":"purple"}}');
  const rb = await b.waitFor("elicitation.resolved", () => true, 5000, fb);
  assert.equal(rb.payload.by, "user");
});

test("durable requests are acked per gateway and dropped once resolved", async () => {
  const fa = a.received.length;
  a.autoAck = false;
  await a.request("conversation.prompt", { conversation_id: "tg-chat", text: "x [permission]", origin: "text" });
  const req = await a.waitFor("permission.request", () => true, 5000, fa);
  const link = h.daemon.router.links.get("tg")!;
  assert.equal(link.hasDurable(`req:${req.payload.request_id}`), true);
  a.send("permission.respond", { request_id: req.payload.request_id, outcome: { outcome: "selected", optionId: "allow-once" } });
  const ended = await a.waitFor("turn.ended", () => true, 5000, fa);
  assert.equal(link.hasDurable(`req:${req.payload.request_id}`), false);
  assert.equal(link.hasDurable(`turn:${ended.payload.turn_id}`), true);
  a.send("delivered", { id: `turn:${ended.payload.turn_id}` });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(link.hasDurable(`turn:${ended.payload.turn_id}`), false);
  a.autoAck = true;
});
