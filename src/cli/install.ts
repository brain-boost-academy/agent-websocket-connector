import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { PACKAGE_ROOT } from "../version.ts";

export const MARKETPLACE_NAME = "agent-connector";
export const PLUGIN_ID = `agent-connector@${MARKETPLACE_NAME}`;
/** Claude Code version the `claude plugin … --json` parsing below was checked against. */
export const CLAUDE_TESTED = "2.1.316";

/** Result of one integration: did the installer change anything (or would it, with dryRun)? */
export type Change = "changed" | "unchanged";

export type Run = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };
type Log = (s: string) => void;

/** A hung `claude` / `opencode` (lock, auto-update) must not block an ansible task forever. */
const RUN_TIMEOUT_MS = 120_000;

/** spawnSync with a timeout; a spawn error (ENOENT, ETIMEDOUT) comes back as status null + its message. */
export const spawnRun =
  (timeoutMs = RUN_TIMEOUT_MS): Run =>
  (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
    if (r.error) return { status: null, stdout: "", stderr: r.error.message };
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };

const defaultRun = spawnRun();

const notFound = (r: ReturnType<Run>) => r.status === null && /ENOENT/.test(r.stderr);
const output = (r: ReturnType<Run>) => `${r.stdout}${r.stderr}`.trim();

// ─── Claude Code ─────────────────────────────────────────────────────────────

type ClaudeOpts = {
  claude?: string;
  root?: string;
  run?: Run;
  log?: Log;
  dryRun?: boolean;
  /** No `claude` on PATH → "unchanged" + warning instead of an error (install without --claude). */
  optional?: boolean;
};

class ClaudeNotFound extends Error {}

/** Thin wrapper over the public `claude plugin` CLI: JSON reads and `--json` writes. */
function claudeCli(opts: ClaudeOpts) {
  const claude = opts.claude ?? process.env.CLAUDE_CODE_EXECUTABLE ?? "claude";
  const run = opts.run ?? defaultRun;
  const show = (args: string[]) => `\`claude ${args.join(" ")}\``;
  const exec = (args: string[]) => {
    const r = run(claude, args);
    if (notFound(r)) throw new ClaudeNotFound(`Claude Code CLI \`${claude}\` not found (${r.stderr})`);
    return r;
  };
  return {
    read(args: string[]): unknown {
      const r = exec(args);
      if (r.status === null) throw new Error(`${show(args)} could not run: ${output(r)}`);
      if (r.status !== 0) throw new Error(`${show(args)} failed (exit ${r.status}): ${output(r)}; Claude Code ${CLAUDE_TESTED} or newer is required`);
      try {
        return JSON.parse(r.stdout);
      } catch {
        throw new Error(`${show(args)} did not print JSON (Claude Code ${CLAUDE_TESTED} or newer is required): ${output(r)}`);
      }
    },
    /** A writing command with `--json`; success = exit 0. `tolerate` lets a known non-error through. */
    write(args: string[], tolerate?: RegExp): void {
      const full = [...args, "--json"];
      const r = exec(full);
      if (r.status === 0) return;
      const line = r.stdout.trim().split("\n").pop() ?? "";
      let message = output(r);
      try {
        const res = JSON.parse(line) as { message?: unknown; failureCode?: unknown };
        if (typeof res.message === "string") message = `${res.message}${typeof res.failureCode === "string" ? ` (${res.failureCode})` : ""}`;
      } catch {
        // not a result line: keep the raw output
      }
      if (tolerate?.test(message)) return;
      throw new Error(`${show(full)} failed (exit ${r.status}): ${message}`);
    },
  };
}

const unexpected = (what: string, value: unknown) =>
  new Error(`unexpected \`claude plugin\` output (${what}): ${JSON.stringify(value)}; checked with Claude Code ${CLAUDE_TESTED}, upgrade agent-connector`);

/** Our marketplace in `claude plugin marketplace list --json`, or undefined. */
function findMarketplace(list: unknown): { source: string; path?: string } | undefined {
  if (!Array.isArray(list)) throw unexpected("marketplace list is not an array", list);
  const e = list.find((x) => x && typeof x === "object" && (x as { name?: unknown }).name === MARKETPLACE_NAME) as Record<string, unknown> | undefined;
  if (!e) return undefined;
  if (typeof e.source !== "string") throw unexpected(`field "source" of marketplace ${MARKETPLACE_NAME} is not a string`, e);
  if (e.source !== "directory") return { source: e.source };
  if (typeof e.path !== "string") throw unexpected(`field "path" of directory marketplace ${MARKETPLACE_NAME} is not a string`, e);
  return { source: e.source, path: e.path };
}

/** Our plugin (user scope) in `claude plugin list --json`, or undefined. */
function findPlugin(list: unknown): { version: string } | undefined {
  if (!Array.isArray(list)) throw unexpected("plugin list is not an array", list);
  const e = list.find((x) => x && typeof x === "object" && (x as { id?: unknown }).id === PLUGIN_ID && (x as { scope?: unknown }).scope === "user") as
    | Record<string, unknown>
    | undefined;
  if (!e) return undefined;
  if (typeof e.version !== "string") throw unexpected(`field "version" of plugin ${PLUGIN_ID} is not a string`, e);
  return { version: e.version };
}

/** Claude records the plugin.json version; tolerate a `-<suffix>` (git-sourced plugins get one). */
export const versionMatches = (have: string, want: string) => have === want || have.startsWith(`${want}-`);

/** Same directory? A path that does not exist never matches (stale registration after a node bump). */
function sameDir(a: string, b: string): boolean {
  if (!existsSync(a) || !existsSync(b)) return false;
  return realpathSync(a) === realpathSync(b);
}

const MARKETPLACE_LIST = ["plugin", "marketplace", "list", "--json"];
const PLUGIN_LIST = ["plugin", "list", "--json"];

/**
 * Bring Claude Code to: marketplace `agent-connector` registered (user scope) from this package's
 * integrations/claude-plugin, plugin installed at this package's version. Writes only what differs.
 */
export function installClaude(opts: ClaudeOpts = {}): Change {
  const log = opts.log ?? ((s) => console.log(s));
  const dry = opts.dryRun ?? false;
  const would = dry ? "(dry run) would " : "";
  const dir = join(opts.root ?? PACKAGE_ROOT, "integrations", "claude-plugin");
  const manifest = join(dir, "plugin", ".claude-plugin", "plugin.json");
  if (!existsSync(join(dir, ".claude-plugin", "marketplace.json")) || !existsSync(manifest)) throw new Error(`marketplace not found in ${dir}`);
  const want = (JSON.parse(readFileSync(manifest, "utf8")) as { version: string }).version;
  const cli = claudeCli(opts);
  const add = () => {
    cli.write(["plugin", "marketplace", "add", "--scope", "user", dir], /already/i);
    // "already" is tolerated, so check that the marketplace really points at dir now
    const now = findMarketplace(cli.read(MARKETPLACE_LIST));
    if (now?.source !== "directory" || !sameDir(now.path!, dir)) {
      throw new Error(`claude: after marketplace add, ${MARKETPLACE_NAME} is not registered from ${dir} (${now ? (now.path ?? `a ${now.source} source`) : "missing"})`);
    }
  };

  let changed = false;
  try {
    let reset = false;
    const m = findMarketplace(cli.read(MARKETPLACE_LIST));
    if (!m) {
      log(`claude: ${would}add marketplace ${MARKETPLACE_NAME} from ${dir}`);
      changed = true;
      if (!dry) add();
    } else if (m.source !== "directory" || !sameDir(m.path!, dir)) {
      log(`claude: marketplace ${MARKETPLACE_NAME} points at ${m.path ?? `a ${m.source} source`}; ${would}re-register it from ${dir}`);
      changed = reset = true;
      if (!dry) {
        cli.write(["plugin", "marketplace", "remove", "--scope", "user", MARKETPLACE_NAME]);
        add();
      }
    }

    // Re-read: `marketplace remove` uninstalls the marketplace's plugins (Claude Code 2.1.316).
    const p = dry && reset ? undefined : findPlugin(cli.read(PLUGIN_LIST));
    if (!p) {
      log(`claude: ${would}install plugin ${PLUGIN_ID} ${want}`);
      changed = true;
      if (!dry) cli.write(["plugin", "install", "--scope", "user", PLUGIN_ID]);
    } else if (!versionMatches(p.version, want)) {
      log(`claude: ${would}update plugin ${PLUGIN_ID} ${p.version} → ${want}`);
      changed = true;
      if (!dry) {
        cli.write(["plugin", "marketplace", "update", MARKETPLACE_NAME]);
        cli.write(["plugin", "update", "--scope", "user", PLUGIN_ID]);
      }
    }

    if (changed && !dry) {
      const after = findPlugin(cli.read(PLUGIN_LIST));
      if (!after || !versionMatches(after.version, want)) {
        throw new Error(`claude: after install, ${PLUGIN_ID} is ${after ? after.version : "not installed"} (expected ${want})`);
      }
    }
    if (!changed) log(`claude: plugin ${PLUGIN_ID} ${want} is installed from ${dir}`);
    return changed ? "changed" : "unchanged";
  } catch (err) {
    // Only before any write: `claude` vanishing mid-run (e.g. an auto-update) must not read as "unchanged".
    if (err instanceof ClaudeNotFound && opts.optional && !changed) {
      log(`warning: ${err.message}; skipping the Claude Code plugin`);
      return "unchanged";
    }
    throw err;
  }
}

/** Remove the plugin and the marketplace (user scope). No `claude` on PATH → nothing to remove. */
export function uninstallClaude(opts: Omit<ClaudeOpts, "optional" | "root"> = {}): Change {
  const log = opts.log ?? ((s) => console.log(s));
  const dry = opts.dryRun ?? false;
  const would = dry ? "(dry run) would " : "";
  const cli = claudeCli(opts);
  try {
    const p = findPlugin(cli.read(PLUGIN_LIST));
    const m = findMarketplace(cli.read(MARKETPLACE_LIST));
    if (p) {
      log(`claude: ${would}uninstall plugin ${PLUGIN_ID}`);
      if (!dry) cli.write(["plugin", "uninstall", "--scope", "user", PLUGIN_ID]);
    }
    if (m) {
      log(`claude: ${would}remove marketplace ${MARKETPLACE_NAME}`);
      if (!dry) cli.write(["plugin", "marketplace", "remove", "--scope", "user", MARKETPLACE_NAME]);
    }
    if (!p && !m) log(`claude: ${PLUGIN_ID} is not installed`);
    return p || m ? "changed" : "unchanged";
  } catch (err) {
    if (err instanceof ClaudeNotFound) {
      log(`warning: ${err.message}; nothing to remove from Claude Code`);
      return "unchanged";
    }
    throw err;
  }
}

// ─── opencode ────────────────────────────────────────────────────────────────

/**
 * The MCP entry written to `mcp.servers.connector` (opencode v2 config). The empty
 * CLAUDE_CODE_SESSION_ID keeps a background service started from a Claude Code shell from leaking
 * that session id into our MCP server (it would be taken for the caller when the plugin is missing).
 */
export const OPENCODE_MCP_ENTRY = { type: "local", command: ["agent-connector", "mcp"], environment: { CLAUDE_CODE_SESSION_ID: "" } };

const MIGRATE_URL = "https://opencode.ai/v2/docs/migrate-v1/";
const SCHEMA_URL = "https://opencode.ai/config.json";

type OpencodeOpts = { home?: string; root?: string; run?: Run; opencode?: string; path?: string; log?: Log; dryRun?: boolean };

/** Major version from `opencode --version`; undefined when opencode is missing or the output is unknown. */
function opencodeMajor(run: Run, opencode: string): number | undefined {
  const r = run(opencode, ["--version"]);
  // only "not installed" may fall back to v2; a hang (timeout) could be a slow v1 that a v2 config would break
  if (r.status === null && !notFound(r)) throw new Error(`\`${opencode} --version\` did not finish: ${output(r)}`);
  if (r.status !== 0) return undefined;
  const m = /(?:^|\s)v?(\d+)\.\d+/.exec(`${r.stdout} ${r.stderr}`.trim());
  return m ? Number(m[1]) : undefined;
}

/** Is `cmd` resolvable through PATH (or an existing path)? */
function onPath(cmd: string, pathEnv = process.env.PATH ?? ""): boolean {
  if (cmd.includes("/")) return existsSync(cmd);
  return pathEnv.split(delimiter).some((d) => d && existsSync(join(d, cmd)));
}

function opencodePaths(home?: string) {
  const cfgDir = join(process.env.XDG_CONFIG_HOME && !home ? process.env.XDG_CONFIG_HOME : join(home ?? homedir(), ".config"), "opencode");
  return {
    cfgDir,
    cfgPath: join(cfgDir, "opencode.json"),
    jsoncPath: join(cfgDir, "opencode.jsonc"),
    pluginPath: join(cfgDir, "plugin", "agent-connector.js"),
  };
}

type Cfg = Record<string, unknown>;
type CfgState = { kind: "json"; cfg: Cfg } | { kind: "jsonc" } | { kind: "none" };

/** opencode.json parsed (plain JSON object only), or which other state the config dir is in. */
function readOpencodeConfig(paths: ReturnType<typeof opencodePaths>): CfgState {
  if (existsSync(paths.cfgPath)) {
    let cfg: unknown;
    try {
      cfg = JSON.parse(readFileSync(paths.cfgPath, "utf8"));
    } catch (err) {
      throw new Error(`${paths.cfgPath} is not plain JSON (${(err as Error).message}); edit mcp.servers.connector by hand: ${JSON.stringify(OPENCODE_MCP_ENTRY)}`);
    }
    if (!cfg || typeof cfg !== "object" || Array.isArray(cfg)) throw new Error(`${paths.cfgPath} is not a JSON object; edit it by hand`);
    return { kind: "json", cfg: cfg as Cfg };
  }
  return existsSync(paths.jsoncPath) ? { kind: "jsonc" } : { kind: "none" };
}

const asObject = (v: unknown): Cfg | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Cfg) : undefined);

/**
 * Atomic write that keeps a symlinked file a symlink and keeps its mode: the temp file goes next
 * to the real target and is renamed onto it. A missing file is created at `path`; a dangling
 * symlink gets its target created.
 */
export function writeFileAtomic(path: string, data: string | Uint8Array): void {
  let target = path;
  try {
    target = realpathSync(path);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    let link: string | undefined;
    try {
      if (lstatSync(path).isSymbolicLink()) link = readlinkSync(path);
    } catch {
      // path does not exist at all
    }
    if (link !== undefined) target = resolve(dirname(path), link);
  }
  const mode = existsSync(target) ? statSync(target).mode & 0o777 : undefined;
  mkdirSync(dirname(target), { recursive: true });
  const tmp = join(dirname(target), `.${basename(target)}.${process.pid}.tmp`);
  rmSync(tmp, { force: true }); // a leftover from a crashed run with the same pid
  try {
    // created with the final mode and exclusively: a 0600 config is never readable by others, not even briefly
    writeFileSync(tmp, data, { mode: mode ?? 0o666, flag: "wx" });
    if (mode !== undefined) chmodSync(tmp, mode);
    renameSync(tmp, target);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

const serialize = (cfg: Cfg) => JSON.stringify(cfg, null, 2) + "\n";

/**
 * Bring opencode to: `mcp.servers.connector` equal (by value) to OPENCODE_MCP_ENTRY in
 * opencode.json (v2 format) and the plugin file equal (by bytes) to ours. Writes only what differs.
 */
export function installOpencode(opts: OpencodeOpts = {}): Change {
  const log = opts.log ?? ((s) => console.log(s));
  const run = opts.run ?? defaultRun;
  const dry = opts.dryRun ?? false;
  const would = dry ? "(dry run) would " : "";
  const major = opencodeMajor(run, opts.opencode ?? "opencode");
  if (major === undefined) log("opencode: version not detected (opencode not on PATH or unknown output), assuming opencode v2");
  else if (major < 2) throw new Error(`opencode ${major}.x is not supported, upgrade to v2: on the latest 1.x run \`opencode upgrade --major\`, see ${MIGRATE_URL}`);

  const paths = opencodePaths(opts.home);
  const state = readOpencodeConfig(paths);
  if (state.kind === "jsonc") throw new Error(`${paths.jsoncPath} is JSONC; add mcp.servers.connector by hand: ${JSON.stringify(OPENCODE_MCP_ENTRY)}`);
  // $schema only for a file we create: adding it to an existing config would be a change on every run
  // for a tool that writes the file without it.
  const cfg: Cfg = state.kind === "json" ? state.cfg : { $schema: SCHEMA_URL };
  const mcp = asObject(cfg.mcp) ?? {};
  const v1Keys = Object.keys(mcp).filter((k) => k !== "servers" && k !== "timeout");
  if (v1Keys.length) throw new Error(`${paths.cfgPath}: mcp has opencode v1 entries (${v1Keys.join(", ")}); move them under mcp.servers (${MIGRATE_URL}) and re-run`);
  const servers = asObject(mcp.servers) ?? {};

  const cfgChanged = !isDeepStrictEqual(servers.connector, OPENCODE_MCP_ENTRY);
  const src = readFileSync(join(opts.root ?? PACKAGE_ROOT, "integrations", "opencode", "agent-connector.js"));
  const pluginChanged = !existsSync(paths.pluginPath) || !readFileSync(paths.pluginPath).equals(src);

  if (cfgChanged) {
    log(`opencode: ${would}write MCP server "connector" to ${paths.cfgPath} (mcp.servers)`);
    if (!dry) {
      servers.connector = OPENCODE_MCP_ENTRY;
      mcp.servers = servers;
      cfg.mcp = mcp;
      writeFileAtomic(paths.cfgPath, serialize(cfg));
    }
  }
  if (pluginChanged) {
    log(`opencode: ${would}copy the plugin to ${paths.pluginPath}`);
    if (!dry) {
      writeFileAtomic(paths.pluginPath, src);
    }
  }
  if (!cfgChanged && !pluginChanged) log(`opencode: MCP server "connector" in ${paths.cfgPath} and the plugin in ${dirname(paths.pluginPath)} are up to date`);
  if (!onPath("agent-connector", opts.path)) {
    log("warning: `agent-connector` is not on this shell's PATH; the opencode background service must find it on its own PATH (see README → opencode)");
  }
  return cfgChanged || pluginChanged ? "changed" : "unchanged";
}

/**
 * Remove `mcp.servers.connector` (and `servers` / `mcp` left empty by that) from opencode.json and
 * our plugin file. Never touches opencode.jsonc; an invalid opencode.json is an error.
 */
export function uninstallOpencode(opts: Omit<OpencodeOpts, "run" | "opencode" | "path" | "root"> = {}): Change {
  const log = opts.log ?? ((s) => console.log(s));
  const dry = opts.dryRun ?? false;
  const would = dry ? "(dry run) would " : "";
  const paths = opencodePaths(opts.home);
  const state = readOpencodeConfig(paths);

  let cfgChanged = false;
  if (state.kind === "json") {
    const { cfg } = state;
    const mcp = asObject(cfg.mcp);
    const servers = asObject(mcp?.servers);
    if (mcp && servers && Object.hasOwn(servers, "connector")) {
      cfgChanged = true;
      log(`opencode: ${would}remove MCP server "connector" from ${paths.cfgPath}`);
      if (!dry) {
        delete servers.connector;
        if (Object.keys(servers).length === 0) delete mcp.servers;
        if (Object.keys(mcp).length === 0) delete cfg.mcp;
        writeFileAtomic(paths.cfgPath, serialize(cfg));
      }
    }
  } else if (state.kind === "jsonc" && readFileSync(paths.jsoncPath, "utf8").includes("agent-connector")) {
    log(`warning: ${paths.jsoncPath} is JSONC and mentions agent-connector; remove mcp.servers.connector there by hand`);
  }

  const pluginChanged = lstatSync(paths.pluginPath, { throwIfNoEntry: false }) !== undefined;
  if (pluginChanged) {
    log(`opencode: ${would}delete ${paths.pluginPath}`);
    if (!dry) rmSync(paths.pluginPath, { force: true });
  }
  if (!cfgChanged && !pluginChanged) log("opencode: agent-connector is not installed");
  return cfgChanged || pluginChanged ? "changed" : "unchanged";
}
