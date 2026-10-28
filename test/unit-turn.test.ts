// protects=queue merging, prompt blocks for uploads (Flow 4), turn bookkeeping for sync.running_turns and turn.ended, last-message preview during load replay (R4);
// fails_when=queued prompts are not merged in order, images are sent to agents without image support, resource_link or the saved-path line is missing, steps/cost/current tool are wrong, the preview mixes several messages;
// no_claim=what a real agent does with the blocks
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPromptBlocks, mergePrompts, type QueuedPrompt } from "../src/acp/prompt.ts";
import { LastMessage, Turn } from "../src/acp/turn.ts";

const from = (c: string) => ({ gateway: "tg", conversation_id: c });
const q = (text: string, o: Partial<QueuedPrompt> = {}): QueuedPrompt => ({ text, origin: "text", uploads: [], from: from("1"), ...o });

test("mergePrompts joins queued texts in order, keeps uploads and every sender once", () => {
  const m = mergePrompts([q("a"), q("b", { origin: "voice", from: from("2") }), q("", { uploads: [{ path: "/u/x.png", name: "x.png", mime: "image/png", size: 3 }] }), q("c")]);
  assert.equal(m.text, "a\n\nb\n\nc");
  assert.equal(m.origin, "text");
  assert.equal(m.uploads.length, 1);
  assert.deepEqual(m.from, [from("1"), from("2")]);
  assert.throws(() => mergePrompts([]));
});

test("buildPromptBlocks: image block only when the agent accepts images, resource_link and saved path for every file", async () => {
  const p = mergePrompts([q("look", { uploads: [{ path: "/u/a.png", name: "a.png", mime: "image/png", size: 3 }, { path: "/u/b.pdf", name: "b.pdf", mime: "application/pdf", size: 9 }] })]);
  const readFile = async () => Buffer.from("img");
  const withImages = await buildPromptBlocks(p, { images: true, readFile });
  assert.deepEqual(withImages.map((b) => b.type), ["text", "image", "resource_link", "resource_link"]);
  assert.equal((withImages[0] as { text: string }).text, "look\nФайл сохранён: /u/a.png\nФайл сохранён: /u/b.pdf");
  assert.equal((withImages[1] as { data: string }).data, Buffer.from("img").toString("base64"));
  assert.equal((withImages[2] as { uri: string }).uri, "file:///u/a.png");
  const noImages = await buildPromptBlocks(p, { images: false, readFile });
  assert.deepEqual(noImages.map((b) => b.type), ["text", "resource_link", "resource_link"]);
});

test("Turn tracks text, tool calls as steps, current tool and USD cost", () => {
  const t = new Turn("t1", { agent_id: "a", session_id: "s", cwd: "/w" }, [from("1")], "text", 0);
  t.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Hel" } });
  t.apply({ sessionUpdate: "tool_call", toolCallId: "x", title: "Read a.ts", status: "in_progress" });
  t.apply({ sessionUpdate: "tool_call", toolCallId: "x", title: "Read a.ts (again)" }); // same id is not a new step
  t.apply({ sessionUpdate: "tool_call_update", toolCallId: "x", status: "completed" });
  t.apply({ sessionUpdate: "tool_call", toolCallId: "y", title: "Bash" });
  t.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "lo" } });
  t.apply({ sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 0.5, currency: "USD" } });
  t.apply({ sessionUpdate: "usage_update", used: 1, size: 2, cost: { amount: 9, currency: "EUR" } });
  assert.equal(t.text, "Hel\n\nlo"); // a tool call in between: two agent messages
  assert.equal(t.steps, 2);
  assert.equal(t.toolCalls, 2);
  assert.equal(t.currentTool, "Bash");
  assert.equal(t.costUsd, 0.5);
});

test("LastMessage keeps only the last agent message of a replay", () => {
  const l = new LastMessage();
  const chunk = (text: string) => l.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
  l.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q1" } });
  chunk("first ");
  chunk("answer");
  l.apply({ sessionUpdate: "user_message_chunk", content: { type: "text", text: "q2" } });
  chunk("second");
  l.apply({ sessionUpdate: "usage_update", used: 1, size: 1 });
  chunk(" answer");
  l.apply({ sessionUpdate: "tool_call", toolCallId: "t", title: "x" });
  assert.equal(l.text, "second answer");
  l.boundary();
  chunk("third");
  assert.equal(l.text, "third");
});

// protects=turn.ended.text / sync.text_so_far keep agent messages apart;
// fails_when=two agent messages of one turn are glued ("…checking.Done"), thoughts/usage split one message, a turn starting with a tool call gets a leading separator;
// no_claim=how a gateway renders the separator
test("Turn.text separates agent messages: after a tool call, on a new messageId; not on thoughts or usage", () => {
  const t = new Turn("t1", { agent_id: "a", session_id: "s", cwd: "/w" }, [from("1")], "text", 0);
  const chunk = (text: string, messageId?: string) => t.apply({ sessionUpdate: "agent_message_chunk", content: { type: "text", text }, ...(messageId ? { messageId } : {}) });
  t.apply({ sessionUpdate: "tool_call", toolCallId: "a", title: "Read" });
  chunk("Let me ");
  t.apply({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "hmm" } });
  t.apply({ sessionUpdate: "usage_update", used: 1, size: 2 });
  chunk("check.");
  t.apply({ sessionUpdate: "tool_call", toolCallId: "b", title: "Bash" });
  t.apply({ sessionUpdate: "tool_call_update", toolCallId: "b", status: "completed" });
  chunk("Done");
  chunk(" here", "m2");
  chunk(" too", "m2");
  chunk("Next", "m3");
  assert.equal(t.text, "Let me check.\n\nDone here too\n\nNext");
});
