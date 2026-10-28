/** Fields the PreToolUse hook (or opencode plugin) injects into our MCP tool arguments. */
export type CallerFields = { caller_session_id?: unknown; caller_cwd?: unknown; caller_agent?: unknown };

/** What the MCP server process knows about itself (it runs inside the agent session). */
export type McpEnv = { env_session_id?: string; env_cwd?: string };

export type Caller =
  | { source: "hook" | "env"; session_id: string; cwd: string | undefined; agent_id: string }
  | { source: "none"; cwd: string | undefined };

const str = (v: unknown) => (typeof v === "string" && v.length > 0 ? v : undefined);

/**
 * Resolve the calling agent session: (1) hook fields, (2) CLAUDE_CODE_SESSION_ID of the MCP
 * process (right for `claude -p`, stale after /clear), (3) none → notify without session.
 */
export function resolveCaller(args: CallerFields, env: McpEnv): Caller {
  const hookId = str(args.caller_session_id);
  if (hookId) return { source: "hook", session_id: hookId, cwd: str(args.caller_cwd) ?? env.env_cwd, agent_id: str(args.caller_agent) ?? "claude" };
  const envId = str(env.env_session_id);
  if (envId) return { source: "env", session_id: envId, cwd: env.env_cwd, agent_id: "claude" };
  return { source: "none", cwd: str(args.caller_cwd) ?? env.env_cwd };
}
