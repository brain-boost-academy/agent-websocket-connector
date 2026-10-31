// agent-connector plugin for opencode v2 (installed by `agent-connector install-integrations --opencode`).
// Adds the calling session to our MCP tool arguments (like the Claude PreToolUse hook) and reports
// finished turns so the connector releases sessions it marked as running elsewhere (Flow 9).
//
// Verified live against opencode 2.0.24 (isolated XDG dirs, background service and `opencode acp`):
// - one plugin instance per directory; ctx.location.directory == the session's directory == the MCP
//   process cwd, so it is a valid `caller_cwd` for a later `session/load`;
// - ctx.tool.hook("execute.before") gets a mutable `e.input`; in Code Mode it fires again for the
//   nested `connector_send_message` call and the mutated input reaches the MCP server;
// - a subagent's call carries the child session id; ctx.session.get({ sessionID }) returns `parentID`;
// - ctx.event.subscribe({ signal }) is an async iterator; a turn ends with
//   session.execution.succeeded | failed | interrupted, session id in `data.sessionID`.
// Every error is swallowed: this plugin must never break opencode.
import { spawn } from "node:child_process";

const OUR_TOOLS = new Set(["connector_send_message", "connector_list_channels"]);
const TURN_END = /^session\.execution\.(succeeded|failed|interrupted)$/;
const MAX_PARENT_STEPS = 10;

/** Walk parentID up to the root session (a subagent's call should bind the chat to the main session). */
async function rootSession(ctx, sessionID) {
  let id = sessionID;
  try {
    for (let i = 0; i < MAX_PARENT_STEPS; i++) {
      const rec = await ctx.session.get({ sessionID: id });
      const parent = rec?.parentID ?? rec?.data?.parentID;
      if (typeof parent !== "string" || !parent || parent === id) break;
      id = parent;
    }
    return id;
  } catch {
    return sessionID;
  }
}

function sessionEnd(sessionID, cwd) {
  try {
    const child = spawn("agent-connector", ["hook", "session-end"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    child.on("error", () => {});
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd, agent: "opencode" }));
    child.unref();
  } catch {
    // never break opencode
  }
}

export default {
  id: "agent-connector",
  async setup(ctx) {
    const directory = ctx?.location?.directory;
    ctx.tool.hook("execute.before", async (e) => {
      try {
        if (!e || !OUR_TOOLS.has(e.tool)) return;
        if (!e.input || typeof e.input !== "object") e.input = {};
        // only this plugin may name the caller: drop anything the model wrote before filling them in
        delete e.input.caller_session_id;
        delete e.input.caller_cwd;
        const root = typeof e.sessionID === "string" && e.sessionID ? await rootSession(ctx, e.sessionID) : undefined;
        if (root) e.input.caller_session_id = root;
        if (typeof directory === "string" && directory) e.input.caller_cwd = directory;
        e.input.caller_agent = "opencode";
      } catch {
        // never break opencode
      }
    });
    const abort = new AbortController();
    (async () => {
      for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
        const sessionID = ev?.data?.sessionID;
        if (TURN_END.test(ev?.type ?? "") && typeof sessionID === "string" && sessionID) sessionEnd(sessionID, directory);
      }
    })().catch(() => {});
    return () => abort.abort();
  },
};
