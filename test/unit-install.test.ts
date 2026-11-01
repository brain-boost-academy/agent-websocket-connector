// protects=install-/uninstall-integrations as an idempotent, machine-readable step for ansible: "changed"/"unchanged" per integration, no writing `claude plugin` call and no touched file when unchanged, re-registration of a marketplace left on a stale path (node bump), --dry-run that changes nothing, the CLI contract (one JSON line on stdout, logs on stderr, exit 0/1/2), and the 0.2.0 guarantees (opencode 1.x / v1 mcp / invalid JSON / JSONC refused without writes, other servers and settings kept);
// fails_when=a re-run updates or rewrites anything, a stale or foreign marketplace is not re-registered, the plugin is left uninstalled after `marketplace remove`, a version mismatch after update passes, an unexpected `claude` output is treated as drift, a write call lacks --scope user, opencode.json loses its symlink or mode, a log line reaches stdout with --json, a mistyped flag runs for real;
// no_claim=the real `claude plugin` CLI beyond the 2.1.316 output shapes copied into test/helpers/fake-claude.ts (manual run in a throwaway HOME, README "Verified"), opencode loading the plugin (checked live, README "Verified")
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  installClaude,
  installOpencode,
  MARKETPLACE_NAME,
  OPENCODE_MCP_ENTRY,
  PLUGIN_ID,
  spawnRun,
  uninstallClaude,
  uninstallOpencode,
  versionMatches,
} from "../src/cli/install.ts";
import { PACKAGE_ROOT } from "../src/version.ts";
import { fakeClaude, newFakeState, writes, type FakeClaudeState } from "./helpers/fake-claude.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const MAIN = fileURLToPath(new URL("../src/cli/main.ts", import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL("./helpers/fake-claude.ts", import.meta.url));
const DIR = join(ROOT, "integrations", "claude-plugin");
const VERSION = (JSON.parse(readFileSync(join(DIR, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;

type T = { after: (fn: () => void) => void };
const tmp = (t: T, prefix = "acn-") => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(d, { recursive: true, force: true }));
  return d;
};

function claudeEnv(s: FakeClaudeState, root = ROOT) {
  const log: string[] = [];
  return { log, opts: { root, run: (_cmd: string, args: string[]) => fakeClaude(s, args), log: (l: string) => log.push(l) } };
}
const installed = (path = DIR, version = VERSION): Partial<FakeClaudeState> => ({
  marketplaces: { [MARKETPLACE_NAME]: { source: "directory", path } },
  plugins: { [PLUGIN_ID]: { version, scope: "user" } },
});

// ─── Claude ──────────────────────────────────────────────────────────────────

test("installClaude: fresh → add + install (--scope user --json), changed; re-run → unchanged with no writing call (no update every run)", () => {
  const s = newFakeState();
  const { opts } = claudeEnv(s);
  assert.equal(installClaude(opts), "changed");
  assert.deepEqual(writes(s), [
    ["plugin", "marketplace", "add", "--scope", "user", DIR, "--json"],
    ["plugin", "install", "--scope", "user", PLUGIN_ID, "--json"],
  ]);
  assert.deepEqual(s.plugins[PLUGIN_ID], { version: VERSION, scope: "user" });
  s.calls = [];
  assert.equal(installClaude(opts), "unchanged");
  assert.deepEqual(writes(s), [], "no marketplace update / plugin update on a converged host");
});

test("installClaude: 'already' from marketplace add is not an error (0.2.0 guarantee)", () => {
  const s = newFakeState({ addSaysAlready: true });
  assert.equal(installClaude(claudeEnv(s).opts), "changed");
  assert.ok(s.plugins[PLUGIN_ID]);
});

test("installClaude: marketplace on a dead path (node bump) → remove + add + reinstall (remove drops the plugin), changed, then unchanged", () => {
  const s = newFakeState(installed("/home/u/.nvm/versions/node/v24.1.0/lib/node_modules/agent-connector/integrations/claude-plugin"));
  const { opts, log } = claudeEnv(s);
  assert.equal(installClaude(opts), "changed");
  assert.deepEqual(writes(s), [
    ["plugin", "marketplace", "remove", "--scope", "user", MARKETPLACE_NAME, "--json"],
    ["plugin", "marketplace", "add", "--scope", "user", DIR, "--json"],
    ["plugin", "install", "--scope", "user", PLUGIN_ID, "--json"],
  ]);
  assert.equal(s.marketplaces[MARKETPLACE_NAME]!.path, DIR);
  assert.ok(s.plugins[PLUGIN_ID], "plugin installed again after remove dropped it");
  assert.ok(log.some((l) => /points at \/home\/u\/\.nvm.*re-register/.test(l)), log.join("\n"));
  s.calls = [];
  assert.equal(installClaude(opts), "unchanged");
  assert.deepEqual(writes(s), []);
});

test("installClaude: an existing other directory and a non-directory source both count as drift", (t) => {
  const other = tmp(t);
  for (const m of [{ source: "directory", path: other }, { source: "github", repo: "someone/agent-connector" }]) {
    const s = newFakeState({ marketplaces: { [MARKETPLACE_NAME]: m }, plugins: { [PLUGIN_ID]: { version: VERSION, scope: "user" } } });
    assert.equal(installClaude(claudeEnv(s).opts), "changed", JSON.stringify(m));
    assert.deepEqual(writes(s).map((a) => a.slice(1, 3)), [["marketplace", "remove"], ["marketplace", "add"], ["install", "--scope"]]);
    assert.deepEqual(s.marketplaces[MARKETPLACE_NAME], { source: "directory", path: DIR });
  }
});

test("installClaude: package root with a space, registered at the same path → unchanged, no remove/add", (t) => {
  const root = join(tmp(t), "with space", "pkg");
  cpSync(DIR, join(root, "integrations", "claude-plugin"), { recursive: true });
  const dir = join(root, "integrations", "claude-plugin");
  const s = newFakeState(installed(dir));
  assert.equal(installClaude(claudeEnv(s, root).opts), "unchanged");
  assert.deepEqual(writes(s), []);
  // PACKAGE_ROOT is a filesystem path (fileURLToPath), not a URL pathname with %-escapes
  assert.equal(PACKAGE_ROOT, ROOT);
});

test("installClaude: version check tolerates a -suffix; an older version → marketplace update + plugin update --scope user", () => {
  {
    const s = newFakeState(installed(DIR, `${VERSION}-b54a19c1e244`));
    assert.equal(installClaude(claudeEnv(s).opts), "unchanged");
    assert.deepEqual(writes(s), []);
  }
  {
    const s = newFakeState(installed(DIR, "0.0.1"));
    assert.equal(installClaude(claudeEnv(s).opts), "changed");
    assert.deepEqual(writes(s), [
      ["plugin", "marketplace", "update", MARKETPLACE_NAME, "--json"],
      ["plugin", "update", "--scope", "user", PLUGIN_ID, "--json"],
    ]);
    assert.equal(s.plugins[PLUGIN_ID]!.version, VERSION);
  }
  assert.equal(versionMatches("0.3.0", "0.3.0"), true);
  assert.equal(versionMatches("0.3.0-abc", "0.3.0"), true);
  assert.equal(versionMatches("0.3.01", "0.3.0"), false);
  assert.equal(versionMatches("0.3.0", "0.3.0-abc"), false);
});

test("installClaude: update that does not reach the version, or a failing plugin update, is an error", () => {
  assert.throws(() => installClaude(claudeEnv(newFakeState({ ...installed(DIR, "0.0.1"), updateNoop: true })).opts), /after install, agent-connector@agent-connector is 0\.0\.1 \(expected/);
  assert.throws(
    () => installClaude(claudeEnv(newFakeState({ ...installed(DIR, "0.0.1"), failOn: "plugin update" })).opts),
    /`claude plugin update --scope user agent-connector@agent-connector --json` failed \(exit 1\): injected failure.*\(injected\)/,
  );
  assert.throws(() => installClaude(claudeEnv(newFakeState({ failOn: "plugin install" })).opts), /plugin install .* failed/);
});

test("installClaude dryRun: same result, no writing call, nothing installed (fresh, drift, update)", () => {
  for (const init of [{}, installed("/gone/integrations/claude-plugin"), installed(DIR, "0.0.1")]) {
    const s = newFakeState(structuredClone(init));
    const before = JSON.stringify({ m: s.marketplaces, p: s.plugins });
    const { opts, log } = claudeEnv(s);
    assert.equal(installClaude({ ...opts, dryRun: true }), "changed");
    assert.deepEqual(writes(s), []);
    assert.equal(JSON.stringify({ m: s.marketplaces, p: s.plugins }), before);
    assert.ok(log.every((l) => /\(dry run\) would /.test(l)), log.join("\n"));
  }
  assert.equal(installClaude({ ...claudeEnv(newFakeState(installed())).opts, dryRun: true }), "unchanged");
});

test("installClaude: unexpected list output (no path, odd source, failing or non-JSON list) → error, no writing call", () => {
  const cases: Array<[Partial<FakeClaudeState>, RegExp]> = [
    [{ marketplaces: { [MARKETPLACE_NAME]: { source: "directory" } } }, /field "path" of directory marketplace agent-connector is not a string/],
    [{ marketplaces: { [MARKETPLACE_NAME]: { source: 7 as unknown as string } } }, /field "source"/],
    [{ ...installed(), plugins: { [PLUGIN_ID]: { version: 3 as unknown as string, scope: "user" } } }, /field "version"/],
    [{ failOn: "plugin marketplace list" }, /`claude plugin marketplace list --json` failed \(exit 1\).*Claude Code 2\.1\.316 or newer/s],
    [{ listGarbage: "Usage: claude plugin ..." }, /did not print JSON/],
    [{ ...installed(), listGarbage: "{}" }, /marketplace list is not an array/],
  ];
  for (const [init, re] of cases) {
    const s = newFakeState(init);
    assert.throws(() => installClaude(claudeEnv(s).opts), re);
    assert.deepEqual(writes(s), [], String(re));
  }
});

test("installClaude without claude on PATH: optional (no flags) → unchanged + warning; explicit → error", () => {
  const run = () => ({ status: null, stdout: "", stderr: "spawnSync claude ENOENT" });
  const log: string[] = [];
  assert.equal(installClaude({ root: ROOT, run, log: (l) => log.push(l), optional: true }), "unchanged");
  assert.ok(log.some((l) => /warning: Claude Code CLI `claude` not found/.test(l)), log.join("\n"));
  assert.throws(() => installClaude({ root: ROOT, run, log: () => {} }), /Claude Code CLI `claude` not found/);
});

test("uninstallClaude: plugin + marketplace → both removed, changed; again → unchanged, no writes; partial; dry run; no claude", () => {
  {
    const s = newFakeState(installed());
    assert.equal(uninstallClaude(claudeEnv(s).opts), "changed");
    assert.deepEqual(writes(s), [
      ["plugin", "uninstall", "--scope", "user", PLUGIN_ID, "--json"],
      ["plugin", "marketplace", "remove", "--scope", "user", MARKETPLACE_NAME, "--json"],
    ]);
    assert.deepEqual(s.marketplaces, {});
    s.calls = [];
    assert.equal(uninstallClaude(claudeEnv(s).opts), "unchanged");
    assert.deepEqual(writes(s), []);
  }
  {
    const s = newFakeState({ marketplaces: installed().marketplaces });
    assert.equal(uninstallClaude(claudeEnv(s).opts), "changed");
    assert.deepEqual(writes(s), [["plugin", "marketplace", "remove", "--scope", "user", MARKETPLACE_NAME, "--json"]]);
  }
  {
    const s = newFakeState(installed());
    assert.equal(uninstallClaude({ ...claudeEnv(s).opts, dryRun: true }), "changed");
    assert.deepEqual(writes(s), []);
    assert.ok(s.plugins[PLUGIN_ID]);
  }
  {
    const log: string[] = [];
    assert.equal(uninstallClaude({ run: () => ({ status: null, stdout: "", stderr: "spawnSync claude ENOENT" }), log: (l) => log.push(l) }), "unchanged");
    assert.ok(log.some((l) => /warning: .*nothing to remove/.test(l)), log.join("\n"));
  }
});

test("installClaude: marketplace add that fails after remove → error with no plugin left; the next run converges", () => {
  const s = newFakeState({ ...installed("/gone/integrations/claude-plugin"), failOn: "plugin marketplace add" });
  assert.throws(() => installClaude(claudeEnv(s).opts), /marketplace add .* failed \(exit 1\)/);
  assert.equal(s.plugins[PLUGIN_ID], undefined, "remove dropped the plugin");
  s.failOn = undefined;
  assert.equal(installClaude(claudeEnv(s).opts), "changed");
  assert.equal(s.marketplaces[MARKETPLACE_NAME]!.path, DIR);
  assert.ok(s.plugins[PLUGIN_ID]);
});

test("installClaude: 'already' from marketplace add that registers nothing → error, not a silent changed", () => {
  const s = newFakeState({ addNoop: true });
  assert.throws(() => installClaude(claudeEnv(s).opts), /after marketplace add, agent-connector is not registered from .*claude-plugin/);
  assert.deepEqual(
    writes(s).map((a) => a.slice(1, 3)),
    [["marketplace", "add"]],
    "no plugin install against a marketplace that is not there",
  );
});

test("installClaude: a suffixed version recorded by install passes the post-check and converges", () => {
  const s = newFakeState({ versionSuffix: "b54a19c1e244" });
  assert.equal(installClaude(claudeEnv(s).opts), "changed");
  assert.equal(s.plugins[PLUGIN_ID]!.version, `${VERSION}-b54a19c1e244`);
  s.calls = [];
  assert.equal(installClaude(claudeEnv(s).opts), "unchanged");
  assert.deepEqual(writes(s), []);
});

test("PACKAGE_ROOT is a filesystem path for a package dir with a space (no %20 from URL.pathname)", async (t) => {
  const root = join(tmp(t), "with space");
  mkdirSync(join(root, "src"), { recursive: true });
  cpSync(join(ROOT, "src", "version.ts"), join(root, "src", "version.ts"));
  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  const m = (await import(pathToFileURL(join(root, "src", "version.ts")).href)) as { PACKAGE_ROOT: string };
  assert.equal(m.PACKAGE_ROOT, `${root}/`);
});

test("spawnRun: a hung command is stopped at the timeout and reported (status null, ETIMEDOUT)", () => {
  const r = spawnRun(200)("sleep", ["5"]);
  assert.equal(r.status, null);
  assert.match(r.stderr, /ETIMEDOUT/);
});

// protects=version-based update decision after future bumps; fails_when=one of the four version fields is not bumped
test("versions in package.json, package-lock.json, marketplace.json and plugin.json are equal", () => {
  const read = (p: string) => JSON.parse(readFileSync(join(ROOT, p), "utf8"));
  const pkg = read("package.json").version;
  const lock = read("package-lock.json");
  const mkt = read("integrations/claude-plugin/.claude-plugin/marketplace.json").plugins.find((p: { name: string }) => p.name === "agent-connector").version;
  assert.deepEqual([lock.version, lock.packages[""].version, mkt, VERSION], [pkg, pkg, pkg, pkg]);
});

// ─── opencode ────────────────────────────────────────────────────────────────

const v2 = () => ({ status: 0, stdout: "opencode v2.0.24\n", stderr: "" });
const OC_PLUGIN = readFileSync(join(ROOT, "integrations", "opencode", "agent-connector.js"));

function ocHome(t: T, cfg?: unknown) {
  const home = tmp(t, "acn-home-");
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  if (cfg !== undefined) writeFileSync(join(dir, "opencode.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return { home, dir, cfgPath: join(dir, "opencode.json"), plugin: join(dir, "plugin", "agent-connector.js") };
}
const oc = (home: string, extra: { log?: string[]; dryRun?: boolean; path?: string } = {}) => ({
  home,
  root: ROOT,
  run: v2,
  path: extra.path ?? "",
  dryRun: extra.dryRun,
  log: (l: string) => extra.log?.push(l),
});
const mtimes = (...paths: string[]) => paths.map((p) => statSync(p).mtimeMs);

test("installOpencode v2: writes mcp.servers.connector, keeps other servers/settings, copies the plugin; re-run → unchanged, mtimes kept", (t) => {
  const { home, cfgPath, plugin } = ocHome(t, { model: "x/y", mcp: { timeout: { startup: 5000 }, servers: { other: { type: "local", command: ["o"] } } } });
  const log: string[] = [];
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), v2());
  assert.equal(installOpencode({ ...oc(home, { log }), run }), "changed");
  const first = readFileSync(cfgPath, "utf8");
  const before = mtimes(cfgPath, plugin);
  assert.equal(installOpencode({ ...oc(home, { log }), run }), "unchanged");
  assert.equal(readFileSync(cfgPath, "utf8"), first);
  assert.deepEqual(mtimes(cfgPath, plugin), before, "nothing rewritten");
  assert.deepEqual(calls[0], ["opencode", "--version"]);
  const cfg = JSON.parse(first);
  assert.equal(cfg.model, "x/y");
  assert.equal(cfg.$schema, undefined, "no $schema added to an existing config");
  assert.deepEqual(cfg.mcp.timeout, { startup: 5000 });
  assert.deepEqual(cfg.mcp.servers.other, { type: "local", command: ["o"] });
  assert.deepEqual(cfg.mcp.servers.connector, { type: "local", command: ["agent-connector", "mcp"], environment: { CLAUDE_CODE_SESSION_ID: "" } });
  assert.deepEqual(Object.keys(cfg.mcp).sort(), ["servers", "timeout"]);
  assert.deepEqual(readFileSync(plugin), OC_PLUGIN);
  assert.ok(log.some((l) => /warning: `agent-connector` is not on this shell.s PATH/.test(l)), log.join("\n"));
});

test("installOpencode: fresh config gets $schema + the entry; no PATH warning when agent-connector is found", (t) => {
  const { home, cfgPath } = ocHome(t);
  const bin = tmp(t, "acn-bin-");
  writeFileSync(join(bin, "agent-connector"), "");
  const log: string[] = [];
  assert.equal(installOpencode(oc(home, { log, path: bin })), "changed");
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(cfg.mcp, { servers: { connector: OPENCODE_MCP_ENTRY } });
  assert.ok(!log.some((l) => /warning/.test(l)), log.join("\n"));
});

test("installOpencode: config rewritten with sorted keys / other indent (ansible to_nice_json) and no $schema → unchanged, byte for byte", (t) => {
  const nice = JSON.stringify(
    { mcp: { servers: { connector: { command: ["agent-connector", "mcp"], environment: { CLAUDE_CODE_SESSION_ID: "" }, type: "local" }, other: { command: ["o"], type: "local" } } }, model: "x/y" },
    null,
    4,
  );
  const { home, cfgPath, plugin } = ocHome(t, nice);
  mkdirSync(dirname(plugin), { recursive: true });
  writeFileSync(plugin, OC_PLUGIN);
  const before = mtimes(cfgPath, plugin);
  assert.equal(installOpencode(oc(home)), "unchanged");
  assert.equal(readFileSync(cfgPath, "utf8"), nice);
  assert.deepEqual(mtimes(cfgPath, plugin), before);
});

test("installOpencode: a different connector entry or a modified plugin file → changed and fixed", (t) => {
  {
    const { home, cfgPath, plugin } = ocHome(t, { mcp: { servers: { connector: { type: "local", command: ["agent-connector", "mcp"] } } } });
    mkdirSync(dirname(plugin), { recursive: true });
    writeFileSync(plugin, OC_PLUGIN);
    assert.equal(installOpencode(oc(home)), "changed");
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).mcp.servers.connector, OPENCODE_MCP_ENTRY);
  }
  {
    const { home, plugin } = ocHome(t, { mcp: { servers: { connector: OPENCODE_MCP_ENTRY } } });
    mkdirSync(dirname(plugin), { recursive: true });
    writeFileSync(plugin, "// old plugin\n");
    assert.equal(installOpencode(oc(home)), "changed");
    assert.deepEqual(readFileSync(plugin), OC_PLUGIN);
  }
});

test("installOpencode dryRun: changed, nothing written", (t) => {
  const { home, dir, cfgPath } = ocHome(t, { model: "x/y" });
  const log: string[] = [];
  assert.equal(installOpencode(oc(home, { log, dryRun: true })), "changed");
  assert.equal(readFileSync(cfgPath, "utf8"), JSON.stringify({ model: "x/y" }));
  assert.equal(existsSync(join(dir, "plugin")), false);
  assert.ok(log.some((l) => /\(dry run\) would write MCP server/.test(l)), log.join("\n"));
});

test("installOpencode G1: opencode missing or unknown --version output → assumes v2 and says so", (t) => {
  for (const run of [() => ({ status: null, stdout: "", stderr: "spawn opencode ENOENT" }), () => ({ status: 0, stdout: "dev build", stderr: "" })]) {
    const { home, cfgPath } = ocHome(t);
    const log: string[] = [];
    installOpencode({ ...oc(home, { log }), run });
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).mcp.servers.connector, OPENCODE_MCP_ENTRY);
    assert.ok(log.some((l) => /assuming opencode v2/.test(l)), log.join("\n"));
  }
});

test("installOpencode: a timed-out `opencode --version` is an error, not \"assume v2\" (no v2 config written for a slow v1)", (t) => {
  const { home, cfgPath, plugin } = ocHome(t, { model: "x/y" });
  const run = () => ({ status: null, stdout: "", stderr: "spawnSync opencode ETIMEDOUT" });
  assert.throws(() => installOpencode({ ...oc(home), run }), /`opencode --version` did not finish.*ETIMEDOUT/);
  assert.equal(readFileSync(cfgPath, "utf8"), JSON.stringify({ model: "x/y" }));
  assert.equal(existsSync(plugin), false);
});

test("installClaude: a timed-out `claude plugin … list` names the timeout, not an upgrade", () => {
  const run = () => ({ status: null, stdout: "", stderr: "spawnSync claude ETIMEDOUT" });
  assert.throws(
    () => installClaude({ root: ROOT, run, log: () => {} }),
    (e: Error) => /could not run.*ETIMEDOUT/.test(e.message) && !/or newer is required/.test(e.message),
  );
});

test("installOpencode refuses opencode 1.x, a v1-shaped mcp block, invalid JSON, JSONC; files stay untouched", (t) => {
  {
    const original = JSON.stringify({ model: "x/y" });
    const { home, cfgPath, plugin } = ocHome(t, original);
    assert.throws(() => installOpencode({ ...oc(home), run: () => ({ status: 0, stdout: "1.19.3\n", stderr: "" }) }), /opencode 1\.x is not supported.*opencode upgrade --major.*migrate-v1/);
    assert.equal(readFileSync(cfgPath, "utf8"), original);
    assert.equal(existsSync(plugin), false);
  }
  {
    const original = JSON.stringify({ mcp: { other: { type: "local", command: ["o"] }, servers: {}, legacy: {} } });
    const { home, cfgPath, plugin } = ocHome(t, original);
    assert.throws(() => installOpencode(oc(home)), /opencode v1 entries \(other, legacy\); move them under mcp\.servers/);
    assert.equal(readFileSync(cfgPath, "utf8"), original);
    assert.equal(existsSync(plugin), false);
  }
  {
    const { home, cfgPath, plugin } = ocHome(t, "{ // comment\n}");
    assert.throws(() => installOpencode(oc(home)), /not plain JSON/);
    assert.equal(readFileSync(cfgPath, "utf8"), "{ // comment\n}");
    assert.equal(existsSync(plugin), false);
  }
  {
    const { home, dir, cfgPath } = ocHome(t);
    writeFileSync(join(dir, "opencode.jsonc"), "{ // comment\n}");
    assert.throws(() => installOpencode(oc(home)), /opencode\.jsonc is JSONC; add mcp\.servers\.connector by hand/);
    assert.equal(existsSync(cfgPath), false, "no .json is created next to the .jsonc");
  }
});

test("opencode.json as a symlink (dotfiles) stays a symlink with its 0600 mode through install and uninstall; a dangling link gets its target", (t) => {
  {
    const { home, cfgPath } = ocHome(t);
    const dotfiles = tmp(t, "acn-dot-");
    const real = join(dotfiles, "opencode.json");
    writeFileSync(real, JSON.stringify({ model: "x/y", mcp: { servers: { other: { type: "local", command: ["o"] } } } }));
    chmodSync(real, 0o600);
    symlinkSync(real, cfgPath);
    assert.equal(installOpencode(oc(home)), "changed");
    assert.ok(lstatSync(cfgPath).isSymbolicLink());
    assert.equal(readlinkSync(cfgPath), real);
    assert.deepEqual(JSON.parse(readFileSync(real, "utf8")).mcp.servers.connector, OPENCODE_MCP_ENTRY);
    assert.equal(statSync(real).mode & 0o777, 0o600);
    assert.equal(uninstallOpencode({ home }), "changed");
    assert.ok(lstatSync(cfgPath).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(real, "utf8")), { model: "x/y", mcp: { servers: { other: { type: "local", command: ["o"] } } } });
    assert.equal(statSync(real).mode & 0o777, 0o600);
  }
  {
    const { home, cfgPath } = ocHome(t);
    const target = join(tmp(t, "acn-dot-"), "sub", "opencode.json");
    symlinkSync(target, cfgPath);
    assert.equal(installOpencode(oc(home)), "changed");
    assert.ok(lstatSync(cfgPath).isSymbolicLink());
    assert.deepEqual(JSON.parse(readFileSync(target, "utf8")).mcp.servers.connector, OPENCODE_MCP_ENTRY);
  }
});

test("uninstallOpencode: removes connector (and servers/mcp left empty) + the plugin, keeps the rest; again → unchanged, untouched", (t) => {
  {
    const { home, cfgPath, plugin } = ocHome(t, { model: "x/y", mcp: { timeout: { startup: 5000 }, servers: { other: { type: "local", command: ["o"] } } } });
    installOpencode(oc(home));
    assert.equal(uninstallOpencode({ home }), "changed");
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")), { model: "x/y", mcp: { timeout: { startup: 5000 }, servers: { other: { type: "local", command: ["o"] } } } });
    assert.equal(existsSync(plugin), false);
    assert.equal(existsSync(dirname(plugin)), true, "the shared plugin/ dir stays");
    const before = mtimes(cfgPath);
    assert.equal(uninstallOpencode({ home }), "unchanged");
    assert.deepEqual(mtimes(cfgPath), before);
  }
  {
    const { home, cfgPath } = ocHome(t);
    installOpencode(oc(home));
    assert.equal(uninstallOpencode({ home }), "changed");
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")), { $schema: "https://opencode.ai/config.json" }, "empty servers and mcp are dropped, the file stays");
  }
  {
    const { home, cfgPath } = ocHome(t, { mcp: { servers: {} } });
    assert.equal(uninstallOpencode({ home }), "unchanged", "an empty servers block we did not empty is left alone");
    assert.equal(readFileSync(cfgPath, "utf8"), JSON.stringify({ mcp: { servers: {} } }));
  }
});

test("uninstallOpencode dryRun: changed, nothing removed", (t) => {
  const { home, cfgPath, plugin } = ocHome(t);
  installOpencode(oc(home));
  const cfg = readFileSync(cfgPath, "utf8");
  assert.equal(uninstallOpencode({ home, dryRun: true, log: () => {} }), "changed");
  assert.equal(readFileSync(cfgPath, "utf8"), cfg);
  assert.equal(existsSync(plugin), true);
});

test("uninstallOpencode: JSONC-only config → unchanged and untouched (warning if it mentions us); invalid opencode.json → error, untouched", (t) => {
  {
    const { home, dir } = ocHome(t);
    const jsonc = '{ // mine\n "mcp": { "servers": { "connector": { "command": ["agent-connector", "mcp"] } } } }';
    writeFileSync(join(dir, "opencode.jsonc"), jsonc);
    const log: string[] = [];
    assert.equal(uninstallOpencode({ home, log: (l) => log.push(l) }), "unchanged");
    assert.equal(readFileSync(join(dir, "opencode.jsonc"), "utf8"), jsonc);
    assert.ok(log.some((l) => /warning: .*opencode\.jsonc is JSONC/.test(l)), log.join("\n"));
  }
  {
    const { home, cfgPath, plugin } = ocHome(t, "{ broken");
    mkdirSync(dirname(plugin), { recursive: true });
    writeFileSync(plugin, OC_PLUGIN);
    assert.throws(() => uninstallOpencode({ home, log: () => {} }), /not plain JSON/);
    assert.equal(readFileSync(cfgPath, "utf8"), "{ broken");
    assert.equal(existsSync(plugin), true);
  }
});

// ─── CLI contract (what ansible sees) ────────────────────────────────────────

function cliEnv(t: T, state: Partial<FakeClaudeState> = {}) {
  const home = tmp(t, "acn-cli-");
  const bin = join(home, "bin");
  mkdirSync(bin);
  const stateFile = join(home, "claude-state.json");
  writeFileSync(stateFile, JSON.stringify(newFakeState(state)));
  const claude = join(bin, "claude");
  writeFileSync(claude, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLAUDE}" "$@"\n`);
  chmodSync(claude, 0o755);
  writeFileSync(join(bin, "opencode"), "#!/bin/sh\necho 'opencode v2.0.24'\n");
  chmodSync(join(bin, "opencode"), 0o755);
  const env = {
    HOME: home,
    XDG_CONFIG_HOME: join(home, ".config"),
    CLAUDE_CODE_EXECUTABLE: claude,
    FAKE_CLAUDE_STATE: stateFile,
    // only the fakes: a globally installed agent-connector (node bin dir, /usr/bin) must not hide the PATH warning
    PATH: bin,
  };
  const cli = (...args: string[]) => spawnSync(process.execPath, [MAIN, ...args], { env, encoding: "utf8", timeout: 30_000 });
  const ocDir = join(home, ".config", "opencode");
  return { cli, home, ocDir, state: () => JSON.parse(readFileSync(stateFile, "utf8")) as FakeClaudeState };
}

test("CLI install-integrations --json: one JSON line on stdout, logs on stderr, exit 0; re-run unchanged; uninstall; dry run writes nothing", (t) => {
  const { cli, ocDir, state } = cliEnv(t);
  const dry = cli("install-integrations", "--json", "--dry-run");
  assert.equal(dry.status, 0, dry.stderr);
  assert.equal(dry.stdout, '{"claude":"changed","opencode":"changed"}\n');
  assert.equal(existsSync(ocDir), false);
  assert.deepEqual(writes(state()), []);

  const first = cli("install-integrations", "--json");
  assert.equal(first.status, 0, first.stderr);
  assert.equal(first.stdout, '{"claude":"changed","opencode":"changed"}\n');
  assert.match(first.stderr, /claude: add marketplace/);
  assert.match(first.stderr, /warning: `agent-connector` is not on this shell.s PATH/);
  assert.ok(state().plugins[PLUGIN_ID]);

  const again = cli("install-integrations", "--json");
  assert.equal(again.stdout, '{"claude":"unchanged","opencode":"unchanged"}\n');

  const only = cli("install-integrations", "--opencode", "--json");
  assert.equal(only.stdout, '{"opencode":"unchanged"}\n');

  const human = cli("install-integrations");
  assert.equal(human.status, 0, human.stderr);
  assert.match(human.stdout, /^claude: unchanged$/m);
  assert.match(human.stdout, /^opencode: unchanged$/m);

  const un = cli("uninstall-integrations", "--json");
  assert.equal(un.status, 0, un.stderr);
  assert.equal(un.stdout, '{"claude":"changed","opencode":"changed"}\n');
  assert.equal(cli("uninstall-integrations", "--json").stdout, '{"claude":"unchanged","opencode":"unchanged"}\n');
});

test("CLI: an error → exit 1 and empty stdout; claude missing without flags → unchanged + opencode done, with --claude → exit 1", (t) => {
  {
    const { cli } = cliEnv(t, { failOn: "plugin install" });
    const r = cli("install-integrations", "--json");
    assert.equal(r.status, 1);
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /plugin install .* failed/);
  }
  {
    const { cli, ocDir, home } = cliEnv(t);
    rmSync(join(home, "bin", "claude"));
    const r = cli("install-integrations", "--json");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(r.stdout, '{"claude":"unchanged","opencode":"changed"}\n');
    assert.match(r.stderr, /warning: Claude Code CLI .* not found/);
    assert.ok(existsSync(join(ocDir, "opencode.json")));
    const strict = cli("install-integrations", "--claude", "--json");
    assert.equal(strict.status, 1);
    assert.equal(strict.stdout, "");
  }
});

test("CLI: unknown flag or positional (e.g. --dryrun) → exit 2, nothing done; --help → exit 0", (t) => {
  const { cli, ocDir, state } = cliEnv(t);
  for (const args of [["install-integrations", "--dryrun"], ["uninstall-integrations", "--channel", "x"], ["install-integrations", "extra"]]) {
    const r = cli(...args);
    assert.equal(r.status, 2, args.join(" "));
    assert.equal(r.stdout, "");
    assert.match(r.stderr, /agent-connector (un)?install-integrations: /);
  }
  assert.equal(existsSync(ocDir), false);
  assert.deepEqual(state().calls, []);
  const help = cli("install-integrations", "--help");
  assert.equal(help.status, 0);
  assert.match(help.stdout, /uninstall-integrations/);
});
