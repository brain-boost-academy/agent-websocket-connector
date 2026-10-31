// Opt-in adapter contract for `opencode acp` (R7). Skipped when opencode is not installed.
// protects=opencode (v2) initialize caps, a turn through the connector, modes from configOptions (build/plan) and set_mode via set_config_option across a reload, session reload with replay suppressed, session/list;
// fails_when=opencode acp stops answering initialize/new/prompt as the connector expects, the gateway sees no opencode modes, a chosen mode is lost on reload;
// no_claim=opencode permission/elicitation shapes (its default config allows tools, so no permission request is triggered)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeGateway } from "../helpers/fake-gateway.ts";
import { startHarness } from "../helpers/harness.ts";

const found = spawnSync("opencode", ["--version"], { encoding: "utf8" });
const skip = found.status === 0 ? false : "opencode is not installed";

test("opencode acp: caps, turn, modes, reload with context, list", { skip, timeout: 180_000 }, async () => {
  const gw = new FakeGateway();
  await gw.start();
  // Isolated XDG dirs unless OPENCODE_TEST_REAL_HOME=1 (then the user's opencode auth/config is used).
  // Isolated runs need no credentials: opencode v2 defaults to a free model.
  const iso = mkdtempSync(join(tmpdir(), "acn-oc-"));
  const env = process.env.OPENCODE_TEST_REAL_HOME === "1" ? {} : { XDG_DATA_HOME: join(iso, "data"), XDG_CONFIG_HOME: join(iso, "config"), XDG_STATE_HOME: join(iso, "state"), XDG_CACHE_HOME: join(iso, "cache") };
  const h = await startHarness([{ name: "tg", gw }], { default_agent: "opencode", agents: { opencode: { env } } });
  try {
    const hello = await gw.waitFor("hello", () => true, 60_000);
    assert.equal(hello.payload.agents[0]!.caps.load_session, true);
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "c1", text: "Reply with exactly: pong", origin: "text" });
    const ended = await gw.waitFor("turn.ended", () => true, 170_000, from);
    assert.match(ended.payload.text, /pong/i);
    const modes = h.daemon.sessions.info(ended.payload.session).modes;
    assert.ok(modes, "opencode v2 sends modes as a configOptions select");
    for (const id of ["build", "plan"]) assert.ok(modes.available.some((m) => m.id === id), JSON.stringify(modes));
    await gw.request("session.set_mode", { conversation_id: "c1", mode_id: "plan" });
    // after_turn closed the session; the next prompt reloads it (replay suppressed) and keeps context
    const from2 = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "c1", text: "Which word did you reply with last time? Answer with that word only.", origin: "text" });
    const ended2 = await gw.waitFor("turn.ended", () => true, 170_000, from2);
    assert.match(ended2.payload.text, /pong/i);
    const replayed = gw.received.slice(from2).filter((e) => e.type === "session.update" && (e.payload as { update: { sessionUpdate: string } }).update.sessionUpdate === "user_message_chunk");
    assert.deepEqual(replayed, []);
    assert.equal(h.daemon.sessions.info(ended.payload.session).modes?.current, "plan", "the chosen mode is re-applied after the reload");
    const list = await gw.request("sessions.list", { conversation_id: "c1" });
    assert.ok(list.items.some((i) => i.session.session_id === ended.payload.session.session_id));
  } finally {
    await h.stop();
    await gw.stop();
  }
});
