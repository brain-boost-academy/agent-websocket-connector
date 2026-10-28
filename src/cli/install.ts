import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
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

/** Merge our MCP server into opencode.json and copy the plugin file. */
export function installOpencode(opts: { home?: string; root?: string; log?: (s: string) => void } = {}): void {
  const home = opts.home ?? homedir();
  const log = opts.log ?? ((s) => console.log(s));
  const cfgDir = join(process.env.XDG_CONFIG_HOME && !opts.home ? process.env.XDG_CONFIG_HOME : join(home, ".config"), "opencode");
  mkdirSync(join(cfgDir, "plugin"), { recursive: true });
  const cfgPath = join(cfgDir, "opencode.json");
  let cfg: Record<string, unknown> = {};
  if (existsSync(cfgPath)) {
    try {
      cfg = JSON.parse(readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    } catch (err) {
      throw new Error(`${cfgPath} is not plain JSON (${(err as Error).message}); add the "connector" MCP entry by hand`);
    }
  }
  if (!cfg.$schema) cfg.$schema = "https://opencode.ai/config.json";
  const mcp = (cfg.mcp && typeof cfg.mcp === "object" ? cfg.mcp : {}) as Record<string, unknown>;
  mcp.connector = { type: "local", command: ["agent-connector", "mcp"], enabled: true };
  cfg.mcp = mcp;
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");
  const src = join(opts.root ?? PACKAGE_ROOT, "integrations", "opencode", "agent-connector.js");
  cpSync(src, join(cfgDir, "plugin", "agent-connector.js"));
  log(`opencode: MCP server "connector" in ${cfgPath}, plugin in ${join(cfgDir, "plugin")}`);
}
