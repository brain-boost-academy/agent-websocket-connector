// agent-connector plugin for opencode (installed by `agent-connector install-integrations --opencode`).
// Adds the calling session to our MCP tool arguments (like the Claude PreToolUse hook) and reports
// idle sessions so the connector releases sessions it marked as running elsewhere (Flow 9).
// UNVERIFIED against a real opencode: tool naming "<server>_<tool>" and event shapes follow the
// opencode plugin docs.
import { spawn } from "node:child_process";

const OUR_TOOLS = new Set(["connector_send_message", "connector_list_channels"]);

export const AgentConnector = async ({ directory }) => ({
  "tool.execute.before": async (input, output) => {
    if (!OUR_TOOLS.has(input.tool)) return;
    // mutate in place: opencode keeps its own reference to output.args
    output.args ??= {};
    Object.assign(output.args, { caller_session_id: input.sessionID, caller_cwd: directory, caller_agent: "opencode" });
  },
  event: async ({ event }) => {
    if (event?.type !== "session.idle") return;
    const sessionID = event.properties?.sessionID;
    if (!sessionID) return;
    try {
      const child = spawn("agent-connector", ["hook", "session-end"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
      child.on("error", () => {});
      child.stdin.end(JSON.stringify({ session_id: sessionID, cwd: directory, agent: "opencode" }));
      child.unref();
    } catch {
      // never break opencode
    }
  },
});
