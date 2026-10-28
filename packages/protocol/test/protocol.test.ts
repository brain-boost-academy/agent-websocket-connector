// protects=wire contract between connector and any gateway; fails_when=a catalog message no longer round-trips,
// broken envelope fields pass, or a new ACP update kind/field is rejected (R10); no_claim=semantics of handlers
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decode,
  encode,
  makeEnvelope,
  Payloads,
  GATEWAY_TO_CONNECTOR,
  CONNECTOR_TO_GATEWAY,
  BOTH_DIRECTIONS,
  ResponseOf,
  durableKey,
  MAX_FRAME_BYTES,
  type MessageType,
  type PayloadOf,
} from "../src/index.ts";
import { buildSchema } from "../scripts/schema.ts";

const S = { agent_id: "claude", session_id: "a4da2a16-2e36-4fb8-9105-b8a8f3765e0a", cwd: "/home/u/work" };
const B1 = "0199f3a2-7b10-7c3e-9a1d-5e2f4b6c8d01";
const PERM_PARAMS = {
  sessionId: S.session_id,
  toolCall: { toolCallId: "toolu_1", title: "touch hello.txt", kind: "execute" },
  options: [
    { optionId: "allow-once", name: "Yes", kind: "allow_once" },
    { optionId: "reject", name: "No", kind: "reject_once" },
  ],
};
const ELICIT_PARAMS = {
  mode: "form",
  sessionId: S.session_id,
  message: "Which color do you like?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: { type: "string", title: "Color", oneOf: [{ const: "Red", title: "Red" }] },
      question_0_custom: { type: "string", title: "Other" },
    },
  },
};

// One valid sample per message type. A new type without a sample fails the coverage test below.
const samples: { [T in MessageType]: PayloadOf<T> } = {
  hello: {
    protocol: { min: 1, max: 1 },
    acp_protocol: 1,
    connector_version: "0.1.0",
    agents: [{ agent_id: "claude", title: "Claude Code", default: true, caps: { load_session: true, list_sessions: true, images: true } }],
  },
  welcome: {
    protocol: 1,
    gateway: { kind: "telegram", label: "Telegram", version: "0.1.0" },
    connector_id: "c1",
    limits: { max_inbound_file_bytes: 20 << 20, max_outbound_file_bytes: 50 << 20 },
    pairing: { paired: true, user_display: "@owner", conversation_id: "123" },
  },
  sync: {
    conversations: [{ conversation_id: "123", session: S, agent_id: "claude", title: "t", modes: { current: "default", available: [{ id: "default", name: "Manual" }] }, busy: true, queue_length: 1 }],
    running_turns: [{ turn_id: "t1", session: S, conversation_ids: ["123"], text_so_far: "Hel", current_tool: "Bash", steps: 2, started_at: "2026-10-19T10:00:00Z" }],
    pending: [
      { kind: "permission", request_id: "r1", conversation_ids: ["123"], session: S, params: PERM_PARAMS },
      { kind: "elicitation", request_id: "r2", conversation_ids: ["123"], session: S, params: ELICIT_PARAMS },
    ],
  },
  error: { code: "not_paired", message: "no owner" },
  "conversation.prompt": { conversation_id: "123", text: "hi", origin: "voice", attachments: [B1], session: S },
  "sessions.list": { conversation_id: "123", limit: 10 },
  "session.new": { conversation_id: "123", agent_id: "opencode" },
  "session.attach": { conversation_id: "123", session: S },
  "session.cancel": { conversation_id: "123" },
  "session.set_mode": { conversation_id: "123", mode_id: "acceptEdits" },
  "agent.select": { conversation_id: "123", agent_id: "opencode" },
  "permission.respond": { request_id: "r1", outcome: { outcome: "selected", optionId: "allow-once" } },
  "elicitation.respond": { request_id: "r2", action: "accept", content: { question_0: "Red" } },
  "pairing.changed": { paired: false, reason: "admin_unpair" },
  delivered: { id: "notify:n1" },
  "pairing.code": { code: "abc", url: "https://t.me/bot?start=abc", expires_at: "2026-10-19T10:10:00Z" },
  "pairing.status.result": { paired: false },
  "pairing.revoke.result": { ok: true },
  "session.state": { conversation_id: "123", session: null, agent_id: "claude", busy: false, queue_length: 0 },
  "turn.started": { turn_id: "t1", conversation_ids: ["123"], session: S, origin: "text" },
  "session.update": { conversation_ids: ["123"], session: S, turn_id: "t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hi" } } },
  "turn.ended": { turn_id: "t1", conversation_ids: ["123"], session: S, stop_reason: "end_turn", duration_ms: 1200, tool_calls: 2, cost_usd: 0.19, text: "Hi" },
  "turn.error": { turn_id: "t1", conversation_ids: ["123"], session: S, message: "agent crashed" },
  "permission.request": { request_id: "r1", conversation_ids: ["123"], session: S, params: PERM_PARAMS },
  "permission.resolved": { request_id: "r1", by: "timeout", outcome: { outcome: "selected", optionId: "reject" } },
  "elicitation.request": { request_id: "r2", conversation_ids: ["123"], session: S, params: ELICIT_PARAMS },
  "elicitation.resolved": { request_id: "r2", by: "user" },
  notify: { notify_id: "n1", conversation_id: "123", session: S, text: "*morning*", files: ["b2"], switched: true },
  "pairing.request": {},
  "pairing.status": {},
  "pairing.revoke": {},
  "prompt.accepted": { session: S, queued_position: 0 },
  "sessions.list.result": { items: [{ session: S, title: "x", updated_at: "2026-10-19T10:00:00Z", busy: "foreign" }], next_cursor: "offset:10" },
  "session.new.result": { session: S },
  "session.attach.result": { session: S, title: "x", last_assistant_text: "done", warning: "active_elsewhere" },
  "session.cancel.result": { cancelled: true },
  "session.set_mode.result": { mode_id: "acceptEdits" },
  "agent.select.result": { agent_id: "opencode" },
  "blob.begin": { blob_id: B1, name: "a.pdf", mime: "application/pdf", size: 3, sha256: "a".repeat(64) },
  "blob.chunk": { blob_id: B1, index: 0, data: "AAAA" },
  "blob.end": { blob_id: B1 },
  "blob.stored": { blob_id: B1, path: "/home/u/work/uploads/2026-10-19/a.pdf" },
};

test("every catalog type has a sample and a direction", () => {
  const all = Object.keys(Payloads).sort();
  assert.deepEqual(Object.keys(samples).sort(), all);
  const directed = [...GATEWAY_TO_CONNECTOR, ...CONNECTOR_TO_GATEWAY, ...BOTH_DIRECTIONS].sort();
  assert.deepEqual(directed, all);
});

for (const [type, payload] of Object.entries(samples)) {
  test(`round-trip ${type}`, () => {
    const env = makeEnvelope(type as MessageType, payload as never, { re: type.endsWith("result") ? "x" : undefined });
    const res = decode(encode(env));
    assert.equal(res.ok, true, res.ok ? "" : res.message);
    if (res.ok) assert.deepEqual(res.env, JSON.parse(encode(env)));
  });
}

test("responses map to existing types", () => {
  for (const [req, resp] of Object.entries(ResponseOf)) {
    assert.ok(req in Payloads, req);
    assert.ok(resp in Payloads, resp);
  }
});

test("broken envelope is invalid_message and keeps id when present", () => {
  for (const bad of [
    "not json",
    JSON.stringify({ v: 2, id: "x", type: "hello", ts: "t", payload: {} }),
    JSON.stringify({ v: 1, type: "hello", ts: "t", payload: {} }),
    JSON.stringify({ v: 1, id: "x", type: "no.such.type", ts: "t", payload: {} }),
    JSON.stringify({ v: 1, id: "x", type: "session.cancel", ts: "t", payload: { conversation_id: 5 } }),
    JSON.stringify({ v: 1, id: "x", type: "conversation.prompt", ts: "t", payload: { conversation_id: "1", text: "a", origin: "fax" } }),
    JSON.stringify({ v: 1, id: "x", type: "session.attach", ts: "t", payload: { conversation_id: "1", session: { agent_id: "a", session_id: "s" } } }),
    JSON.stringify({ v: 1, id: "x", type: "notify", ts: "t", payload: { notify_id: "n", switched: false } }),
  ]) {
    const res = decode(bad);
    assert.equal(res.ok, false, bad);
    if (!res.ok) assert.equal(res.code, "invalid_message");
  }
  const res = decode(JSON.stringify({ v: 1, id: "keep-me", type: "session.cancel", ts: "t", payload: {} }));
  assert.equal(res.ok ? undefined : res.id, "keep-me");
});

test("unknown ACP update kinds and fields pass through untouched (R10)", () => {
  const update = { sessionUpdate: "future_kind_v2", whatever: { nested: [1, 2] }, _meta: { x: 1 } };
  const env = makeEnvelope("session.update", { conversation_ids: ["1"], session: S, update });
  const res = decode(encode(env));
  assert.equal(res.ok, true);
  if (res.ok && res.env.type === "session.update") assert.deepEqual(res.env.payload.update, update);

  const params = { ...PERM_PARAMS, toolCall: { ...PERM_PARAMS.toolCall, newField: true }, _meta: { y: 2 } };
  const pres = decode(encode(makeEnvelope("permission.request", { request_id: "r", conversation_ids: [], session: S, params })));
  assert.equal(pres.ok, true);
  if (pres.ok && pres.env.type === "permission.request") assert.deepEqual(pres.env.payload.params, params);
});

test("ACP payload without its discriminator is rejected", () => {
  const res = decode(JSON.stringify(makeEnvelope("session.update", { conversation_ids: ["1"], session: S, update: { text: "x" } } as never)));
  assert.equal(res.ok, false);
});

test("oversized frame is too_large", () => {
  const res = decode("x".repeat(MAX_FRAME_BYTES + 1));
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "too_large");
});

test("durable keys are stable per durable message", () => {
  assert.equal(durableKey("notify", samples.notify), "notify:n1");
  assert.equal(durableKey("turn.ended", samples["turn.ended"]), "turn:t1");
  assert.equal(durableKey("permission.request", samples["permission.request"]), "req:r1");
  assert.equal(durableKey("elicitation.request", samples["elicitation.request"]), "req:r2");
});

test("JSON Schema snapshot matches protocol.schema.json", () => {
  const committed = JSON.parse(readFileSync(new URL("../protocol.schema.json", import.meta.url), "utf8"));
  assert.deepEqual(JSON.parse(JSON.stringify(buildSchema())), committed, "run `npm run schema` and commit the result");
});
