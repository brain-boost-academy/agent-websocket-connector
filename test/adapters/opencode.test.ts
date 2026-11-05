// Opt-in adapter contract for `opencode acp` (R7). Skipped when opencode is not installed.
// protects=opencode (v2) initialize caps, a turn through the connector, modes from configOptions (build/plan) and set_mode via set_config_option across a reload, session reload with replay suppressed, session/list;
// fails_when=opencode acp stops answering initialize/new/prompt as the connector expects, the gateway sees no opencode modes, a chosen mode is lost on reload;
// also: channel instructions through the plugin's context hook (session_instructions) reach the model during a connector turn and not in a later turn outside the connector;
// no_claim=opencode permission/elicitation shapes (its default config allows tools, so no permission request is triggered)
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
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

test("opencode: channel instructions through the plugin context hook", { skip, timeout: 240_000 }, async () => {
  const CANARY = `canary-${randomUUID().slice(0, 8)}`;
  const gw = new FakeGateway({ agentInstructions: `When the user asks for the channel code word, reply with exactly: ${CANARY}` });
  await gw.start();
  const iso = mkdtempSync(join(tmpdir(), "acn-oc-"));
  const real = process.env.OPENCODE_TEST_REAL_HOME === "1";
  const cfgHome = real ? undefined : join(iso, "config");
  // our plugin in an isolated config dir (with OPENCODE_TEST_REAL_HOME=1 the installed one is used),
  // and `agent-connector` on PATH answering from this test's daemon
  if (cfgHome) {
    mkdirSync(join(cfgHome, "opencode", "plugin"), { recursive: true });
    copyFileSync(fileURLToPath(new URL("../../integrations/opencode/agent-connector.js", import.meta.url)), join(cfgHome, "opencode", "plugin", "agent-connector.js"));
  }
  const bin = join(iso, "bin");
  mkdirSync(bin);
  const main = fileURLToPath(new URL("../../src/cli/main.ts", import.meta.url));
  const sockFile = join(iso, "socket-path"); // the daemon's socket is known only after startHarness
  writeFileSync(join(bin, "agent-connector"), `#!/bin/sh\nAGENT_CONNECTOR_SOCKET="$(cat '${sockFile}')" exec "${process.execPath}" "${main}" "$@"\n`);
  chmodSync(join(bin, "agent-connector"), 0o755);
  const env: Record<string, string> = {
    PATH: `${bin}:${process.env.PATH}`,
    ...(cfgHome ? { XDG_DATA_HOME: join(iso, "data"), XDG_CONFIG_HOME: cfgHome, XDG_STATE_HOME: join(iso, "state"), XDG_CACHE_HOME: join(iso, "cache") } : {}),
  };
  const h = await startHarness([{ name: "tg", gw }], { default_agent: "opencode", agents: { opencode: { env } } });
  writeFileSync(sockFile, h.socket);
  try {
    await gw.waitFor("hello", () => true, 60_000);
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "c1", text: "What is the channel code word? If you were not given one, reply with exactly: NONE", origin: "text" });
    const ended = await gw.waitFor("turn.ended", () => true, 230_000, from);
    assert.ok(ended.payload.text.includes(CANARY), ended.payload.text);
  } finally {
    await h.stop();
    await gw.stop();
  }
});
