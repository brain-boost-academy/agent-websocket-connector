// protects=caller-session resolution order (hook → env → none), the PreToolUse hook output contract, AC20 hook scope (matcher hits only send_message/list_channels of our plugin, pair_channel keeps the normal permission flow), hooks never block or fail;
// fails_when=the matcher catches other tools (cloudcli/terminal regression) or pair_channel, updatedInput drops original fields, a broken or slow hook input makes the hook exit non-zero or hang;
// no_claim=Claude Code applying updatedInput (verified once in spike (b), README "Verified"), opencode running the v2 plugin (checked live against opencode 2.0.24, README "Verified")
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

// protects=the opencode v2 plugin contract: `export default {id, setup}`, caller fields added only to our two tools (root session via parentID, caller_cwd = ctx.location.directory), turn-end events spawn `agent-connector hook session-end`, nothing ever throws into opencode;
// fails_when=other tools get caller fields, a subagent's call reports the child session, a failing session lookup or a non-object input breaks the hook, session.execution.started or foreign events trigger session-end, the end-of-turn event does not reach the agent-connector binary on PATH;
// no_claim=opencode's own plugin loader and event names in later versions (event names verified live on 2.0.24)
type Ev = { type?: string; data?: Record<string, unknown> };
async function loadOpencodePlugin(opts: { sessions?: Record<string, { parentID?: string; data?: { parentID?: string } } | Error>; directory?: string | null } = {}) {
  // plain JS without type declarations: import by URL
  const mod = await import(new URL("../integrations/opencode/agent-connector.js", import.meta.url).href);
  const plugin = mod.default as { id: string; setup: (ctx: unknown) => Promise<() => void> };
  const hooks: Record<string, (e: Record<string, unknown>) => Promise<void>> = {};
  const queue: Ev[] = [];
  let wake: (() => void) | undefined;
  const gets: string[] = [];
  const ctx = {
    location: opts.directory === null ? {} : { directory: opts.directory ?? "/proj/a" },
    tool: { hook: (name: string, fn: (e: Record<string, unknown>) => Promise<void>) => void (hooks[name] = fn) },
    session: {
      get: async ({ sessionID }: { sessionID: string }) => {
        gets.push(sessionID);
        const r = opts.sessions?.[sessionID] ?? {};
        if (r instanceof Error) throw r;
        return { id: sessionID, ...r };
      },
    },
    event: {
      subscribe: ({ signal }: { signal: AbortSignal }) => (async function* () {
        while (!signal.aborted) {
          const ev = queue.shift();
          if (ev) yield ev;
          else await new Promise<void>((r) => { wake = r; signal.addEventListener("abort", () => r(), { once: true }); });
        }
      })(),
    },
  };
  const dispose = await plugin.setup(ctx);
  return { plugin, hooks, gets, dispose, emit: (ev: Ev) => { queue.push(ev); wake?.(); } };
}

test("opencode plugin: v2 default export; caller fields only for our tools, caller_cwd = location.directory", async () => {
  const { plugin, hooks, dispose } = await loadOpencodePlugin();
  try {
    assert.equal(plugin.id, "agent-connector");
    const hook = hooks["execute.before"];
    assert.ok(hook);
    const ours = { tool: "connector_send_message", sessionID: "ses_1", input: { text: "hi" } };
    await hook(ours);
    assert.deepEqual(ours.input, { text: "hi", caller_session_id: "ses_1", caller_cwd: "/proj/a", caller_agent: "opencode" });
    const list: Record<string, unknown> = { tool: "connector_list_channels", sessionID: "ses_1", input: "garbage" };
    await hook(list);
    assert.deepEqual(list.input, { caller_session_id: "ses_1", caller_cwd: "/proj/a", caller_agent: "opencode" }, "non-object input is replaced");
    for (const tool of ["connector_pair_channel", "bash", "execute", "telegram_send_message", undefined]) {
      const e = { tool, sessionID: "ses_1", input: { text: "x" } };
      await hook(e);
      assert.deepEqual(e.input, { text: "x" }, String(tool));
    }
    await hook(undefined as never); // never throws
  } finally {
    dispose();
  }
});

test("opencode plugin: caller fields written by the model never pass through, even without a session id or directory", async () => {
  const { hooks, dispose } = await loadOpencodePlugin({ directory: null });
  try {
    const e = { tool: "connector_send_message", input: { text: "x", caller_session_id: "ses_other", caller_cwd: "/elsewhere", caller_agent: "claude" } as Record<string, unknown> };
    await hooks["execute.before"]!(e);
    assert.deepEqual(e.input, { text: "x", caller_agent: "opencode" });
  } finally {
    dispose();
  }
});

test("opencode plugin D11: a subagent's call reports the root session; lookup errors fall back; the walk stops after 10 steps", async () => {
  {
    const { hooks, dispose } = await loadOpencodePlugin({ sessions: { ses_child: { parentID: "ses_mid" }, ses_mid: { parentID: "ses_root" } } });
    const e = { tool: "connector_send_message", sessionID: "ses_child", input: {} as Record<string, unknown> };
    await hooks["execute.before"]!(e);
    assert.equal(e.input.caller_session_id, "ses_root");
    dispose();
  }
  {
    const { hooks, dispose } = await loadOpencodePlugin({ sessions: { ses_child: { parentID: "ses_mid" }, ses_mid: new Error("boom") } });
    const e = { tool: "connector_send_message", sessionID: "ses_child", input: {} as Record<string, unknown> };
    await hooks["execute.before"]!(e);
    assert.equal(e.input.caller_session_id, "ses_child", "lookup error → the calling session");
    assert.equal(e.input.caller_agent, "opencode");
    dispose();
  }
  {
    const { hooks, dispose } = await loadOpencodePlugin({ sessions: { ses_child: { data: { parentID: "ses_root" } } } });
    const e = { tool: "connector_send_message", sessionID: "ses_child", input: {} as Record<string, unknown> };
    await hooks["execute.before"]!(e);
    assert.equal(e.input.caller_session_id, "ses_root", "SDK-style {data: {parentID}} record");
    dispose();
  }
  {
    const loop = { a: { parentID: "b" }, b: { parentID: "a" } };
    const { hooks, gets, dispose } = await loadOpencodePlugin({ sessions: loop });
    const e = { tool: "connector_send_message", sessionID: "a", input: {} as Record<string, unknown> };
    await hooks["execute.before"]!(e);
    assert.equal(gets.length, 10);
    assert.ok(e.input.caller_session_id === "a" || e.input.caller_session_id === "b");
    dispose();
  }
});

test("opencode plugin G3: turn-end events spawn `agent-connector hook session-end` from PATH, other events do not", async (t) => {
  const bin = mkdtempSync(join(tmpdir(), "acn-ocbin-"));
  const out = mkdtempSync(join(tmpdir(), "acn-ocout-"));
  const oldPath = process.env.PATH;
  t.after(() => {
    process.env.PATH = oldPath;
    delete process.env.ACN_FAKE_OUT;
    rmSync(bin, { recursive: true, force: true });
    rmSync(out, { recursive: true, force: true });
  });
  writeFileSync(join(bin, "agent-connector"), '#!/bin/sh\nf="$ACN_FAKE_OUT/$$"\n{ echo "$*"; cat; } > "$f.tmp" && mv "$f.tmp" "$f.json"\n');
  chmodSync(join(bin, "agent-connector"), 0o755);
  process.env.PATH = `${bin}${delimiter}${oldPath}`;
  process.env.ACN_FAKE_OUT = out;
  const { emit, dispose } = await loadOpencodePlugin();
  const read = () => readdirSync(out).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(out, f), "utf8"));
  const waitFor = async (n: number) => {
    for (let i = 0; i < 100 && read().length < n; i++) await sleep(50);
    return read();
  };
  try {
    emit({ type: "session.execution.started", data: { sessionID: "ses_x" } });
    emit({ type: "session.idle", data: { sessionID: "ses_x" } });
    emit({ type: "message.updated", data: { sessionID: "ses_x" } });
    emit({ type: "session.execution.succeeded", data: {} });
    emit({ type: "session.execution.succeeded", data: { sessionID: "ses_s" } });
    emit({ type: "session.execution.failed", data: { sessionID: "ses_f" } });
    emit({ type: "session.execution.interrupted", data: { sessionID: "ses_i" } });
    const got = await waitFor(3);
    await sleep(300); // nothing else arrives
    const lines = read().map((s) => s.split("\n"));
    assert.equal(got.length, 3);
    assert.equal(lines.length, 3);
    for (const [args] of lines) assert.equal(args, "hook session-end");
    const payloads = lines.map(([, json]) => JSON.parse(json ?? "")).sort((a, b) => a.session_id.localeCompare(b.session_id));
    assert.deepEqual(payloads, [
      { session_id: "ses_f", cwd: "/proj/a", agent: "opencode" },
      { session_id: "ses_i", cwd: "/proj/a", agent: "opencode" },
      { session_id: "ses_s", cwd: "/proj/a", agent: "opencode" },
    ]);
  } finally {
    dispose();
  }
});
