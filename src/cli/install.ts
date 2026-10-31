import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { PACKAGE_ROOT } from "../version.ts";

export const MARKETPLACE_NAME = "agent-connector";
export const PLUGIN_ID = `agent-connector@${MARKETPLACE_NAME}`;

type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRun: Run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8" });
  if (r.error) return { status: null, stdout: "", stderr: r.error.message };
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/**
 * Idempotent: (re)register the bundled marketplace, refresh it, install the plugin (or update it
 * when already installed).
 */
export function installClaude(opts: { claude?: string; root?: string; run?: Run; log?: (s: string) => void } = {}): void {
  const claude = opts.claude ?? process.env.CLAUDE_CODE_EXECUTABLE ?? "claude";
  const run = opts.run ?? defaultRun;
  const log = opts.log ?? ((s) => console.log(s));
  const dir = join(opts.root ?? PACKAGE_ROOT, "integrations", "claude-plugin");
  if (!existsSync(join(dir, ".claude-plugin", "marketplace.json"))) throw new Error(`marketplace not found in ${dir}`);
  const out = (r: ReturnType<Run>) => `${r.stdout}${r.stderr}`.trim();

  const add = run(claude, ["plugin", "marketplace", "add", dir]);
  if (add.status !== 0 && !/already/i.test(out(add))) throw new Error(`claude plugin marketplace add failed: ${out(add)}`);
  const upd = run(claude, ["plugin", "marketplace", "update", MARKETPLACE_NAME]);
  if (upd.status !== 0) log(`warning: marketplace update: ${out(upd)}`);
  const inst = run(claude, ["plugin", "install", PLUGIN_ID]);
  if (inst.status !== 0 && !/already/i.test(out(inst))) throw new Error(`claude plugin install failed: ${out(inst)}`);
  const up = run(claude, ["plugin", "update", PLUGIN_ID]);
  if (up.status !== 0 && !/up to date|already|latest/i.test(out(up))) log(`warning: plugin update: ${out(up)}`);
  log(`claude: plugin ${PLUGIN_ID} installed from ${dir}`);
}

/**
 * The MCP entry written to `mcp.servers.connector` (opencode v2 config). The empty
 * CLAUDE_CODE_SESSION_ID keeps a background service started from a Claude Code shell from leaking
 * that session id into our MCP server (it would be taken for the caller when the plugin is missing).
 */
export const OPENCODE_MCP_ENTRY = { type: "local", command: ["agent-connector", "mcp"], environment: { CLAUDE_CODE_SESSION_ID: "" } };

const MIGRATE_URL = "https://opencode.ai/v2/docs/migrate-v1/";

/** Major version from `opencode --version`; undefined when opencode is missing or the output is unknown. */
function opencodeMajor(run: Run, opencode: string): number | undefined {
  const r = run(opencode, ["--version"]);
  if (r.status !== 0) return undefined;
  const m = /(?:^|\s)v?(\d+)\.\d+/.exec(`${r.stdout} ${r.stderr}`.trim());
  return m ? Number(m[1]) : undefined;
}

/** Is `cmd` resolvable through PATH (or an existing path)? */
function onPath(cmd: string, pathEnv = process.env.PATH ?? ""): boolean {
  if (cmd.includes("/")) return existsSync(cmd);
  return pathEnv.split(delimiter).some((d) => d && existsSync(join(d, cmd)));
}

/** Merge our MCP server into opencode.json (opencode v2 format) and copy the plugin file. */
export function installOpencode(opts: { home?: string; root?: string; run?: Run; opencode?: string; path?: string; log?: (s: string) => void } = {}): void {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((s) => console.log(s));
  const run = opts.run ?? defaultRun;
  const major = opencodeMajor(run, opts.opencode ?? "opencode");
  if (major === undefined) log("opencode: version not detected (opencode not on PATH or unknown output), assuming opencode v2");
  else if (major < 2) throw new Error(`opencode ${major}.x is not supported, upgrade to v2: on the latest 1.x run \`opencode upgrade --major\`, see ${MIGRATE_URL}`);

  const cfgDir = join(process.env.XDG_CONFIG_HOME && !opts.home ? process.env.XDG_CONFIG_HOME : join(home, ".config"), "opencode");
  const cfgPath = join(cfgDir, "opencode.json");
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${cfgPath} is not plain JSON (${(err as Error).message}); add mcp.servers.connector by hand: ${JSON.stringify(OPENCODE_MCP_ENTRY)}`);
    }
  } else if (existsSync(join(cfgDir, "opencode.jsonc"))) {
    throw new Error(`${join(cfgDir, "opencode.jsonc")} is JSONC; add mcp.servers.connector by hand: ${JSON.stringify(OPENCODE_MCP_ENTRY)}`);
  }
  const mcp = (cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {}) as Record<string, unknown>;
  const v1Keys = Object.keys(mcp).filter((k) => k !== "servers" && k !== "timeout");
  if (v1Keys.length) throw new Error(`${cfgPath}: mcp has opencode v1 entries (${v1Keys.join(", ")}); move them under mcp.servers (${MIGRATE_URL}) and re-run`);
  if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
  const servers = (mcp.servers && typeof mcp.servers === "object" ? mcp.servers : {}) as Record<string, unknown>;
  servers.connector = OPENCODE_MCP_ENTRY;
  mcp.servers = servers;
  cfg.mcp = mcp;

  mkdirSync(join(cfgDir, "plugin"), { recursive: true });
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const src = join(opts.root ?? PACKAGE_ROOT, "integrations", "opencode", "agent-connector.js");
  cpSync(src, join(cfgDir, "plugin", "agent-connector.js"));
  log(`opencode: MCP server "connector" in ${cfgPath} (mcp.servers), plugin in ${join(cfgDir, "plugin")}`);
  if (!onPath("agent-connector", opts.path)) {
    log("warning: `agent-connector` is not on this shell's PATH; the opencode background service must find it on its own PATH (see README → opencode)");
  }
}
