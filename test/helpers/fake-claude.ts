// Stateful fake of the `claude plugin` CLI subset the installer uses. Output shapes are copied from
// Claude Code 2.1.316 (spike in a throwaway HOME, 2026-11-01): `marketplace list --json` entries
// {name, source: "directory", path, installLocation}; `plugin list --json` entries {id, version
// (= plugin.json version), scope, enabled, installPath}; writing commands with --json print one
// result line {command, outcome: "ok"|"failed", message, failureCode?} and exit 1 on failure;
// `marketplace remove` also uninstalls the marketplace's plugins; `marketplace add` of a known
// name with another path re-points it.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export type FakeClaudeState = {
  marketplaces: Record<string, { source: string; path?: string; repo?: string }>;
  plugins: Record<string, { version: string; scope: string }>;
  /** every call, in order (args as passed) */
  calls: string[][];
  /** appended to the installed version, like git-sourced plugins get (`0.3.0-abc123`) */
  versionSuffix?: string;
  /** `plugin update` reports ok but keeps the old version */
  updateNoop?: boolean;
  /** old-Claude behaviour: `marketplace add` exits 1 with "already installed" (and still registers) */
  addSaysAlready?: boolean;
  /** `marketplace add` exits 1 with "already installed" and registers nothing */
  addNoop?: boolean;
  /** calls whose joined args start with this fail with exit 1 */
  failOn?: string;
  /** `plugin list --json` / `plugin marketplace list --json` print this instead of JSON */
  listGarbage?: string;
};

export const newFakeState = (s: Partial<FakeClaudeState> = {}): FakeClaudeState => ({ marketplaces: {}, plugins: {}, calls: [], ...s });

/** Writing calls only (everything except the two list commands). */
export const writes = (s: FakeClaudeState) => s.calls.filter((a) => a[1] !== "list" && a[2] !== "list");

type Res = { status: number | null; stdout: string; stderr: string };
const ok = (command: string, message: string, extra: object = {}): Res => ({ status: 0, stdout: JSON.stringify({ command, outcome: "ok", message, ...extra }) + "\n", stderr: "" });
const failed = (command: string, message: string, failureCode: string): Res => ({
  status: 1,
  stdout: JSON.stringify({ command, outcome: "failed", message, failureCode }) + "\n",
  stderr: `✘ ${message}\n`,
});

function folderVersion(s: FakeClaudeState, marketplace: string): string {
  const m = s.marketplaces[marketplace];
  const v = (JSON.parse(readFileSync(join(m!.path!, "plugin", ".claude-plugin", "plugin.json"), "utf8")) as { version: string }).version;
  return s.versionSuffix ? `${v}-${s.versionSuffix}` : v;
}

export function fakeClaude(s: FakeClaudeState, args: string[]): Res {
  s.calls.push(args);
  const joined = args.join(" ");
  if (s.failOn && joined.startsWith(s.failOn)) return failed(args.slice(1, 3).join("-"), `injected failure for ${joined}`, "injected");
  const pos = args.filter((a, i) => !a.startsWith("--") && args[i - 1] !== "--scope");
  const [, a1, a2, a3] = pos; // pos[0] = "plugin"

  if (a1 === "marketplace" && a2 === "list") {
    if (s.listGarbage !== undefined) return { status: 0, stdout: s.listGarbage, stderr: "" };
    return { status: 0, stdout: JSON.stringify(Object.entries(s.marketplaces).map(([name, m]) => ({ name, ...m, ...(m.path ? { installLocation: m.path } : {}) }))), stderr: "" };
  }
  if (a1 === "list") {
    if (s.listGarbage !== undefined) return { status: 0, stdout: s.listGarbage, stderr: "" };
    return { status: 0, stdout: JSON.stringify(Object.entries(s.plugins).map(([id, p]) => ({ id, ...p, enabled: true, installPath: `/fake/cache/${id}/${p.version}` }))), stderr: "" };
  }
  if (a1 === "marketplace" && a2 === "add") {
    const name = "agent-connector";
    if (s.addNoop) return failed("marketplace-add", `Marketplace '${name}' is already installed`, "already");
    const had = s.marketplaces[name];
    s.marketplaces[name] = { source: "directory", path: a3 };
    if (s.addSaysAlready) return failed("marketplace-add", `Marketplace '${name}' is already installed`, "already");
    return ok("marketplace-add", had?.path === a3 ? `Marketplace '${name}' already on disk — declared in user settings` : `Successfully added marketplace: ${name}`, { marketplace: name });
  }
  if (a1 === "marketplace" && a2 === "remove") {
    if (!s.marketplaces[a3!]) return failed("marketplace-remove", `Marketplace '${a3}' not found`, "not_configured");
    delete s.marketplaces[a3!];
    for (const id of Object.keys(s.plugins)) if (id.endsWith(`@${a3}`)) delete s.plugins[id];
    return ok("marketplace-remove", `Successfully removed marketplace: ${a3}`);
  }
  if (a1 === "marketplace" && a2 === "update") return ok("marketplace-update", `Successfully updated marketplace: ${a3}`);
  if (a1 === "install") {
    const mkt = a2!.split("@")[1]!;
    if (!s.marketplaces[mkt]) return failed("install", `Marketplace "${mkt}" not found`, "marketplace_not_found");
    if (s.plugins[a2!]) return ok("install", `Plugin "${a2}" is already installed (scope: user)`);
    s.plugins[a2!] = { version: folderVersion(s, mkt), scope: "user" };
    return ok("install", `Successfully installed plugin: ${a2} (scope: user)`);
  }
  if (a1 === "update") {
    const p = s.plugins[a2!];
    if (!p) return failed("update", `Plugin "${a2}" not found`, "not_installed");
    if (!s.updateNoop) p.version = folderVersion(s, a2!.split("@")[1]!);
    return ok("update", `Plugin updated to ${p.version}`);
  }
  if (a1 === "uninstall") {
    if (!s.plugins[a2!]) return failed("uninstall", `Plugin "${a2}" not found in installed plugins`, "not_installed");
    delete s.plugins[a2!];
    return ok("uninstall", `Successfully uninstalled plugin: ${a2}`);
  }
  return { status: 1, stdout: "", stderr: `fake claude: unsupported ${joined}` };
}

// CLI entry: `node fake-claude.ts <args>` with FAKE_CLAUDE_STATE=<json file> (used through
// CLAUDE_CODE_EXECUTABLE by the CLI-contract test).
if (import.meta.main) {
  const file = process.env.FAKE_CLAUDE_STATE!;
  const { writeFileSync } = await import("node:fs");
  const state = JSON.parse(readFileSync(file, "utf8")) as FakeClaudeState;
  const r = fakeClaude(state, process.argv.slice(2));
  writeFileSync(file, JSON.stringify(state));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.status ?? 1;
}
