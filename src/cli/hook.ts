import { callControl } from "../control/client.ts";

/** Read all of stdin, giving up after `ms` (hooks must never hang the agent). */
export function readStdin(ms = 2000): Promise<string> {
  return new Promise((resolve) => {
    let data = "";
    const done = () => {
      clearTimeout(t);
      process.stdin.removeAllListeners();
      process.stdin.destroy(); // an open pipe would keep the process alive
      resolve(data);
    };
    const t = setTimeout(done, ms);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (c) => (data += c));
    process.stdin.on("end", done);
    process.stdin.on("error", done);
  });
}

type HookInput = { session_id?: unknown; cwd?: unknown; tool_name?: unknown; tool_input?: unknown; agent?: unknown };

/** The only tools this hook may allow (pair_channel keeps the normal permission prompt). */
const HOOKED_TOOLS = new Set(["mcp__plugin_agent-connector_connector__send_message", "mcp__plugin_agent-connector_connector__list_channels"]);

/**
 * PreToolUse output for our MCP tools: allow, and pass the calling session to the MCP server via
 * updatedInput. Returns undefined for any other tool or unusable input (then the hook prints nothing).
 */
export function preToolUseOutput(input: HookInput): object | undefined {
  if (typeof input.tool_name !== "string" || !HOOKED_TOOLS.has(input.tool_name)) return undefined;
  if (typeof input.session_id !== "string" || !input.session_id) return undefined;
  const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
  const updatedInput: Record<string, unknown> = { ...toolInput, caller_session_id: input.session_id, caller_agent: "claude" };
  if (typeof input.cwd === "string" && input.cwd) updatedInput.caller_cwd = input.cwd;
  return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow", updatedInput } };
}

/** `agent-connector hook <event>`: never blocks, always exits 0. */
export async function runHook(event: string | undefined): Promise<void> {
  let out = "";
  try {
    const raw = await readStdin();
    const input = (raw.trim() ? JSON.parse(raw) : {}) as HookInput;
    if (event === "pre-tool-use") {
      const decision = preToolUseOutput(input);
      if (decision) out = JSON.stringify(decision) + "\n";
    } else if (event === "session-end") {
      if (typeof input.session_id === "string" && input.session_id) {
        await callControl("session_end", { session_id: input.session_id, cwd: input.cwd, agent: input.agent ?? "claude" }, { timeoutMs: 2000 }).catch(() => {});
      }
    }
  } catch {
    // a broken hook must not break the agent
  }
  process.stdout.write(out, () => process.exit(0));
}
