// protects=connector→gateway frames stay under MAX_FRAME_BYTES by shortening embedded ACP fields (tool rawInput/rawOutput/content/diff texts, running turn text, turn.ended text, last_assistant_text) while ids, options and other fields survive;
// fails_when=a big Write/Edit permission, tool update, sync snapshot or turn text produces a frame the gateway rejects as too_large, shortening drops request ids/options, the end of a running text is lost instead of its start, a small frame is changed;
// no_claim=how gateways render the truncation marker
import { test } from "node:test";
import assert from "node:assert/strict";
import { decode, encode, makeEnvelope, MAX_FRAME_BYTES, type Envelope, type PayloadOf } from "@brain-boost-academy/agent-protocol";
import { fitEnvelope } from "../src/daemon/fit-frame.ts";

const session = { agent_id: "claude", session_id: "s1", cwd: "/w" };
const size = (e: Envelope) => Buffer.byteLength(encode(e), "utf8");
const MB = 1024 * 1024;

test("a permission.request for a Write of a 1.5 MB file fits and keeps its ids and options", () => {
  const content = "line of a big file ✓\n".repeat(Math.ceil((1.5 * MB) / 22));
  const params = {
    sessionId: "s1",
    toolCall: {
      toolCallId: "tc-write",
      title: "Write /w/big.txt",
      kind: "edit",
      status: "pending",
      rawInput: { file_path: "/w/big.txt", content },
      content: [{ type: "diff", path: "/w/big.txt", oldText: null, newText: content }],
    },
    options: [
      { optionId: "allow", kind: "allow_once", name: "Yes" },
      { optionId: "reject", kind: "reject_once", name: "No" },
    ],
  } as unknown as PayloadOf<"permission.request">["params"];
  const env = makeEnvelope("permission.request", { request_id: "r1", conversation_ids: ["c"], session, params });
  assert.ok(size(env) > MAX_FRAME_BYTES);
  const r = fitEnvelope(env);
  assert.ok(r.fits);
  assert.ok(r.truncated > 0);
  assert.ok(size(r.env) <= MAX_FRAME_BYTES, `${size(r.env)}`);
  const back = decode(encode(r.env));
  assert.ok(back.ok);
  const p = r.env.payload.params as unknown as typeof params & { toolCall: { rawInput: { file_path: string; content: string }; content: Array<{ newText: string }> } };
  assert.equal(r.env.payload.request_id, "r1");
  assert.equal(p.toolCall.toolCallId, "tc-write");
  assert.deepEqual(p.options, params.options);
  assert.equal(p.toolCall.rawInput.file_path, "/w/big.txt");
  assert.match(p.toolCall.rawInput.content, /^line of a big file/);
  assert.match(p.toolCall.rawInput.content, /…\[truncated \d+ bytes\]$/);
  assert.match(p.toolCall.content[0]!.newText, /…\[truncated \d+ bytes\]$/);
  // the original envelope is not modified
  assert.equal((env.payload.params as unknown as typeof p).toolCall.rawInput.content, content);
});

test("a sync with a 3 MB text_so_far fits and keeps the end of the text", () => {
  const text = "a".repeat(3 * MB) + "THE END";
  const env = makeEnvelope("sync", {
    conversations: [],
    running_turns: [{ turn_id: "t1", session, conversation_ids: ["c"], text_so_far: text, steps: 3, started_at: new Date().toISOString() }],
    pending: [],
  });
  const r = fitEnvelope(env);
  assert.ok(r.fits);
  assert.ok(size(r.env) <= MAX_FRAME_BYTES);
  const t = r.env.payload.running_turns[0]!;
  assert.equal(t.turn_id, "t1");
  assert.match(t.text_so_far, /^…\[truncated \d+ bytes\]a+THE END$/);
});

test("turn.ended text, last_assistant_text and a tool_call_update rawOutput are shortened; small frames are untouched", () => {
  const big = "x".repeat(2 * MB);
  const ended = fitEnvelope(makeEnvelope("turn.ended", { turn_id: "t", conversation_ids: ["c"], session, stop_reason: "end_turn", duration_ms: 1, tool_calls: 0, text: big + "tail" }));
  assert.ok(ended.fits && ended.env.payload.text.endsWith("tail"));
  const attach = fitEnvelope(makeEnvelope("session.attach.result", { session, last_assistant_text: big }));
  assert.ok(attach.fits && size(attach.env) <= MAX_FRAME_BYTES);
  const upd = fitEnvelope(
    makeEnvelope("session.update", {
      conversation_ids: ["c"], session, turn_id: "t",
      update: { sessionUpdate: "tool_call_update", toolCallId: "b1", status: "completed", rawOutput: { stdout: big, stderr: "", code: 0 } } as unknown as PayloadOf<"session.update">["update"],
    }),
  );
  assert.ok(upd.fits && size(upd.env) <= MAX_FRAME_BYTES);
  assert.equal((upd.env.payload.update as unknown as { toolCallId: string }).toolCallId, "b1");
  const small = makeEnvelope("turn.ended", { turn_id: "t", conversation_ids: ["c"], session, stop_reason: "end_turn", duration_ms: 1, tool_calls: 0, text: "hi" });
  const same = fitEnvelope(small);
  assert.equal(same.env, small);
  assert.equal(same.truncated, 0);
});

test("strings inside arrays (rawInput/rawOutput as arrays of strings) are shortened too", () => {
  const big = "y".repeat(2 * MB);
  const env = makeEnvelope("session.update", {
    conversation_ids: ["c"], session, turn_id: "t",
    update: { sessionUpdate: "tool_call", toolCallId: "a1", title: "Run", rawInput: ["--flag", big], rawOutput: { lines: [big] } } as unknown as PayloadOf<"session.update">["update"],
  });
  const r = fitEnvelope(env);
  assert.ok(r.fits, `${size(r.env)}`);
  assert.ok(size(r.env) <= MAX_FRAME_BYTES);
  const u = r.env.payload.update as unknown as { toolCallId: string; rawInput: string[]; rawOutput: { lines: string[] } };
  assert.equal(u.toolCallId, "a1");
  assert.equal(u.rawInput[0], "--flag");
  assert.match(u.rawInput[1]!, /…\[truncated \d+ bytes\]$/);
  assert.match(u.rawOutput.lines[0]!, /…\[truncated \d+ bytes\]$/);
});
