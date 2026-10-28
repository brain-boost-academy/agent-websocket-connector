// protects=caller-session resolution order (hook → env → none), the PreToolUse hook output contract, AC20 hook scope (matcher hits only send_message/list_channels of our plugin, pair_channel keeps the normal permission flow), hooks never block or fail;
// fails_when=the matcher catches other tools (cloudcli/terminal regression) or pair_channel, updatedInput drops original fields, a broken or slow hook input makes the hook exit non-zero or hang;
// no_claim=Claude Code applying updatedInput (verified once in spike (b), README "Verified"), opencode plugin behaviour
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolveCaller } from "../src/control/caller.ts";
import { preToolUseOutput } from "../src/cli/hook.ts";

const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const PLUGIN = new URL("../integrations/claude-plugin/plugin/", import.meta.url);

test("resolveCaller: hook fields win, then CLAUDE_CODE_SESSION_ID of the MCP process, else none", () => {
  assert.deepEqual(resolveCaller({ caller_session_id: "h1", caller_cwd: "/p", caller_agent: "opencode" }, { env_session_id: "e1", env_cwd: "/e" }), { source: "hook", session_id: "h1", cwd: "/p", agent_id: "opencode" });
  assert.deepEqual(resolveCaller({ caller_session_id: "h1" }, { env_cwd: "/e" }), { source: "hook", session_id: "h1", cwd: "/e", agent_id: "claude" });
  assert.deepEqual(resolveCaller({}, { env_session_id: "e1", env_cwd: "/e" }), { source: "env", session_id: "e1", cwd: "/e", agent_id: "claude" });
  assert.deepEqual(resolveCaller({ caller_session_id: "" }, {}), { source: "none", cwd: undefined });
  assert.deepEqual(resolveCaller({ caller_session_id: 5 }, { env_cwd: "/e" }), { source: "none", cwd: "/e" });
});

test("preToolUseOutput: allow + updatedInput = original input + caller fields", () => {
  const out = preToolUseOutput({ session_id: "s1", cwd: "/w", tool_name: "mcp__plugin_agent-connector_connector__send_message", tool_input: { text: "hi", files: ["a"] } });
  assert.deepEqual(out, {
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput: { text: "hi", files: ["a"], caller_session_id: "s1", caller_agent: "claude", caller_cwd: "/w" } },
  });
  assert.equal(preToolUseOutput({ tool_input: {} }), undefined);
  assert.notEqual(preToolUseOutput({ session_id: "s1", tool_name: "mcp__plugin_agent-connector_connector__list_channels" }), undefined);
});

// protects=the hook grants permissionDecision "allow" only to our two tools, even if the matcher is looser than intended;
// fails_when=any other tool name (another MCP server, a suffixed name, pair_channel, a built-in tool) gets an allow decision;
// no_claim=Claude Code's own matcher semantics
test("preToolUseOutput: no decision for any tool other than our send_message / list_channels", () => {
  for (const tool_name of [
    "x", undefined, "Bash",
    "mcp__plugin_agent-connector_connector__pair_channel",
    "mcp__plugin_agent-connector_connector__send_message_x",
    "xmcp__plugin_agent-connector_connector__send_message",
    "mcp__plugin_core_telegram-mcp__send_message",
  ]) {
    assert.equal(preToolUseOutput({ session_id: "s1", cwd: "/w", tool_name, tool_input: { text: "hi" } }), undefined, String(tool_name));
  }
});

test("hook pre-tool-use CLI prints the decision and exits 0; other tools and garbage input → no output, exit 0", () => {
  const input = JSON.stringify({ session_id: "s1", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "mcp__plugin_agent-connector_connector__send_message", tool_input: { text: "hi" } });
  const ok = spawnSync(process.execPath, [MAIN, "hook", "pre-tool-use"], { input, encoding: "utf8", timeout: 10_000 });
  assert.equal(ok.status, 0);
  assert.equal(JSON.parse(ok.stdout).hookSpecificOutput.updatedInput.caller_session_id, "s1");
  const other = spawnSync(process.execPath, [MAIN, "hook", "pre-tool-use"], { input: JSON.stringify({ session_id: "s1", cwd: "/w", tool_name: "x", tool_input: {} }), encoding: "utf8", timeout: 10_000 });
  assert.equal(other.status, 0);
  assert.equal(other.stdout, "");
  const bad = spawnSync(process.execPath, [MAIN, "hook", "pre-tool-use"], { input: "{not json", encoding: "utf8", timeout: 10_000 });
  assert.equal(bad.status, 0);
  assert.equal(bad.stdout, "");
  const end = spawnSync(process.execPath, [MAIN, "hook", "session-end"], { input: JSON.stringify({ session_id: "s1" }), encoding: "utf8", timeout: 10_000, env: { ...process.env, AGENT_CONNECTOR_SOCKET: "/nonexistent/x.sock" } });
  assert.equal(end.status, 0);
});

test("hook with stdin left open does not hang (gives up after 2 s)", () => {
  const t0 = Date.now();
  // no `input` and stdin as a pipe that is never closed
  const r = spawnSync(process.execPath, ["-e", `const c=require("child_process").spawn(process.execPath,[${JSON.stringify(MAIN)},"hook","pre-tool-use"],{stdio:["pipe","inherit","inherit"]});c.on("exit",(code)=>process.exit(code))`], { timeout: 10_000 });
  assert.equal(r.status, 0);
  assert.ok(Date.now() - t0 < 8000);
});

test("AC20: plugin hook matcher hits only our send_message and list_channels", () => {
  const hooks = JSON.parse(readFileSync(new URL("hooks/hooks.json", PLUGIN), "utf8"));
  const pre = hooks.hooks.PreToolUse;
  assert.equal(pre.length, 1);
  // Claude Code may test the matcher unanchored: check both readings
  const anchored = new RegExp(`^(?:${pre[0].matcher})$`);
  const unanchored = new RegExp(pre[0].matcher);
  for (const re of [anchored, unanchored]) {
    // exact names observed in spike (b)
    assert.ok(re.test("mcp__plugin_agent-connector_connector__send_message"));
    assert.ok(re.test("mcp__plugin_agent-connector_connector__list_channels"));
    for (const other of [
      "mcp__plugin_agent-connector_connector__pair_channel",
      "mcp__plugin_agent-connector_connector__send_message_x",
      "mcp__plugin_agent-connector_connector__list_channels2",
      "xmcp__plugin_agent-connector_connector__send_message",
      "Bash", "Read", "Edit", "ToolSearch",
      "mcp__plugin_core_telegram-mcp__send_message",
      "mcp__connector__send_message",
      "mcp__plugin_other_connector__send_message",
    ]) assert.equal(re.test(other), false, `${re}: ${other}`);
  }
  assert.deepEqual(pre[0].hooks[0].args, ["hook", "pre-tool-use"]);
  assert.deepEqual(hooks.hooks.SessionEnd[0].hooks[0].args, ["hook", "session-end"]);
  const mcp = JSON.parse(readFileSync(new URL(".mcp.json", PLUGIN), "utf8"));
  assert.deepEqual(mcp.mcpServers.connector, { command: "agent-connector", args: ["mcp"] });
  const plugin = JSON.parse(readFileSync(new URL(".claude-plugin/plugin.json", PLUGIN), "utf8"));
  assert.equal(plugin.name, "agent-connector"); // tool prefix mcp__plugin_<plugin>_<server>__
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const market = JSON.parse(readFileSync(new URL("../integrations/claude-plugin/.claude-plugin/marketplace.json", import.meta.url), "utf8"));
  assert.equal(plugin.version, pkg.version, "plugin version follows the package (claude plugin update relies on it)");
  assert.equal(market.plugins[0].version, pkg.version);
});
