import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { z } from "zod";

export type AgentKind = "claude" | "opencode" | "generic";

export type AgentConfig = {
  command: string;
  args: string[];
  env: Record<string, string>;
  title: string;
  /** Decides how transcripts are located (R13/active_elsewhere). */
  kind: AgentKind;
};

export type GatewayConfig = { name: string; url: string; token_file: string };

export type LifecycleConfig = {
  mode: "after_turn" | "lru";
  max_open_sessions: number;
  idle_close_minutes: number;
  busy_hold_minutes: number;
};

export type Config = {
  cwd: string;
  uploads_dir: string;
  default_agent: string;
  agents: Record<string, AgentConfig>;
  gateways: GatewayConfig[];
  default_channel?: string;
  permission_timeout_s: number;
  session_lifecycle: LifecycleConfig;
};

/** Sentinel command: run the pinned @agentclientprotocol/claude-agent-acp entrypoint with this Node. */
export const BUNDLED_CLAUDE_ACP = "claude-agent-acp";

const RawAgent = z.looseObject({
  command: z.string().min(1).optional(),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  title: z.string().optional(),
  kind: z.enum(["claude", "opencode", "generic"]).optional(),
});

const RawConfig = z.looseObject({
  cwd: z.string().min(1).optional(),
  uploads_dir: z.string().min(1).optional(),
  default_agent: z.string().min(1).optional(),
  agents: z.record(z.string(), RawAgent).optional(),
  gateways: z
    .array(z.looseObject({ name: z.string().min(1), url: z.string().min(1), token_file: z.string().min(1) }))
    .optional(),
  default_channel: z.string().optional(),
  permission_timeout_s: z.number().int().positive().optional(),
  session_lifecycle: z
    .looseObject({
      mode: z.enum(["after_turn", "lru"]).optional(),
      max_open_sessions: z.number().int().positive().optional(),
      idle_close_minutes: z.number().positive().optional(),
      busy_hold_minutes: z.number().positive().optional(),
    })
    .optional(),
});

export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/")) return join(home, p.slice(2));
  return p;
}

const DEFAULT_AGENTS: Record<string, z.infer<typeof RawAgent>> = {
  claude: { command: BUNDLED_CLAUDE_ACP, env: { CLAUDE_CODE_EXECUTABLE: "~/.local/bin/claude" }, title: "Claude Code", kind: "claude" },
  opencode: { command: "opencode", args: ["acp"], title: "opencode", kind: "opencode" },
};

function agentKind(id: string, a: z.infer<typeof RawAgent>): AgentKind {
  if (a.kind) return a.kind;
  if (a.command === BUNDLED_CLAUDE_ACP || id === "claude") return "claude";
  if (a.command === "opencode" || id === "opencode") return "opencode";
  return "generic";
}

/** Build a full config from (possibly partial) raw JSON; fills spec defaults and expands `~`. */
export function normalizeConfig(raw: unknown, home = homedir()): Config {
  const r = RawConfig.parse(raw ?? {});
  const cwd = resolve(expandHome(r.cwd ?? "~/work", home));
  const agents: Record<string, AgentConfig> = {};
  // `agents` in the file replaces the default set; known ids inherit default fields (command, env, kind).
  const merged: Record<string, z.infer<typeof RawAgent>> = r.agents ? {} : { ...DEFAULT_AGENTS };
  for (const [id, a] of Object.entries(r.agents ?? {})) merged[id] = { ...(DEFAULT_AGENTS[id] ?? {}), ...a, env: { ...DEFAULT_AGENTS[id]?.env, ...a.env } };
  for (const [id, a] of Object.entries(merged)) {
    const command = a.command ?? id;
    agents[id] = {
      command: command === BUNDLED_CLAUDE_ACP ? command : expandHome(command, home),
      args: a.args ?? [],
      env: Object.fromEntries(Object.entries(a.env ?? {}).map(([k, v]) => [k, expandHome(v, home)])),
      title: a.title ?? id,
      kind: agentKind(id, a),
    };
  }
  const default_agent = r.default_agent ?? "claude";
  if (!agents[default_agent]) throw new Error(`default_agent "${default_agent}" is not in agents`);
  const gateways = (r.gateways ?? []).map((g) => ({ name: g.name, url: g.url, token_file: resolve(expandHome(g.token_file, home)) }));
  const names = new Set<string>();
  for (const g of gateways) {
    if (names.has(g.name)) throw new Error(`duplicate gateway name "${g.name}"`);
    names.add(g.name);
  }
  const lc = r.session_lifecycle ?? {};
  return {
    cwd,
    uploads_dir: resolve(expandHome(r.uploads_dir ?? join(cwd, "uploads"), home)),
    default_agent,
    agents,
    gateways,
    default_channel: r.default_channel ?? gateways[0]?.name,
    permission_timeout_s: r.permission_timeout_s ?? 1800,
    session_lifecycle: {
      mode: lc.mode ?? "after_turn",
      max_open_sessions: lc.max_open_sessions ?? 3,
      idle_close_minutes: lc.idle_close_minutes ?? 30,
      busy_hold_minutes: lc.busy_hold_minutes ?? 10,
    },
  };
}

export function configPath(): string {
  if (process.env.AGENT_CONNECTOR_CONFIG) return process.env.AGENT_CONNECTOR_CONFIG;
  const base = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "agent-connector", "config.json");
}

export function stateDir(): string {
  if (process.env.AGENT_CONNECTOR_STATE_DIR) return process.env.AGENT_CONNECTOR_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  return join(base, "agent-connector");
}

export function socketPath(): string {
  if (process.env.AGENT_CONNECTOR_SOCKET) return process.env.AGENT_CONNECTOR_SOCKET;
  if (process.env.XDG_RUNTIME_DIR) return join(process.env.XDG_RUNTIME_DIR, "agent-connector.sock");
  return join(stateDir(), "agent-connector.sock");
}

/** Load the config file; a missing file yields defaults (no gateways). */
export function loadConfig(path = configPath()): { config: Config; path: string; exists: boolean } {
  let raw: unknown = {};
  let exists = true;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`cannot read config ${path}: ${(err as Error).message}`);
    exists = false;
  }
  return { config: normalizeConfig(raw), path, exists };
}
