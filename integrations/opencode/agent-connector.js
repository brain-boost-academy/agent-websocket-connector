// agent-connector plugin for opencode v2 (installed by `agent-connector install-integrations --opencode`).
// Adds the calling session to our MCP tool arguments (like the Claude PreToolUse hook), reports
// finished turns so the connector releases sessions it marked as running elsewhere (Flow 9), and adds
// the channel instructions of a turn the connector runs (opencode has no ACP systemPrompt) to the system prompt.
//
// Verified live against opencode 2.0.24 (isolated XDG dirs, background service and `opencode acp`):
// - one plugin instance per directory; ctx.location.directory == the session's directory == the MCP
//   process cwd, so it is a valid `caller_cwd` for a later `session/load`;
// - ctx.tool.hook("execute.before") gets a mutable `e.input`; in Code Mode it fires again for the
//   nested `connector_send_message` call and the mutated input reaches the MCP server;
// - a subagent's call carries the child session id; ctx.session.get({ sessionID }) returns `parentID`;
// - ctx.event.subscribe({ signal }) is an async iterator; a turn ends with
//   session.execution.succeeded | failed | interrupted, session id in `data.sessionID`;
// - ctx.session.hook("context") runs before every model request with {sessionID, model, system, messages,
//   options, agent, tools}; `system` is an array of {type: "text", text} (a plain string fails schema validation).
// Every error is swallowed: this plugin must never break opencode.
import { execFile, spawn } from "node:child_process";

const OUR_TOOLS = new Set(["connector_send_message", "connector_list_channels"]);
const TURN_END = /^session\.execution\.(succeeded|failed|interrupted)$/;
const MAX_PARENT_STEPS = 10;
/** A cached answer is asked again after this, in case the turn-end event never came (a dead event stream). */
const INSTRUCTIONS_TTL_MS = 30_000;

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

/** `agent-connector hook <event>` with JSON on stdin; resolves to its stdout ("" on any failure or after 3 s). */
function hookOutput(event, input) {
  return new Promise((resolve) => {
    try {
      // execFile decodes the whole stdout at the end (no split UTF-8 characters) and kills the child on timeout
      const child = execFile("agent-connector", ["hook", event], { timeout: 3000 }, (err, out) => resolve(err ? "" : out));
      child.stdin.on("error", () => {});
      child.stdin.end(JSON.stringify(input));
    } catch {
      resolve("");
    }
  });
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
    // Channel instructions: asked once per turn of a root session (every model request of the turn reuses
    // them), dropped when the turn ends or after INSTRUCTIONS_TTL_MS. Empty for sessions the connector does
    // not run (the TUI's).
    const instructions = new Map();
    const roots = new Map(); // subagent session → root (a parent never changes); root sessions are not stored
    if (typeof ctx?.session?.hook === "function") ctx.session.hook("context", async (e) => {
      try {
        if (!e || typeof e.sessionID !== "string" || !e.sessionID || !Array.isArray(e.system)) return;
        let root = roots.get(e.sessionID);
        if (!root) {
          root = await rootSession(ctx, e.sessionID);
          if (root !== e.sessionID) roots.set(e.sessionID, root);
        }
        let cached = instructions.get(root);
        if (!cached || Date.now() - cached.at >= INSTRUCTIONS_TTL_MS) {
          cached = { at: Date.now(), text: hookOutput("session-instructions", { session_id: root }) };
          instructions.set(root, cached);
        }
        const value = await cached.text;
        if (value) e.system.push({ type: "text", text: value });
      } catch {
        // never break opencode
      }
    });
    const abort = new AbortController();
    (async () => {
      for await (const ev of ctx.event.subscribe({ signal: abort.signal })) {
        const sessionID = ev?.data?.sessionID;
        if (!TURN_END.test(ev?.type ?? "") || typeof sessionID !== "string" || !sessionID) continue;
        instructions.delete(sessionID);
        roots.delete(sessionID);
        sessionEnd(sessionID, directory);
      }
    })().catch(() => {});
    return () => abort.abort();
  },
};
