// protects=install-integrations idempotency (claude plugin marketplace/install commands, opencode v2 config merge + plugin copy) without touching the real ~/.claude or ~/.config;
// fails_when=a second run fails on "already installed", existing opencode settings are lost, the opencode plugin file is not copied, a JSONC config is overwritten, opencode 1.x or a v1-shaped mcp block gets written to, the MCP entry lacks the empty CLAUDE_CODE_SESSION_ID;
// no_claim=the real `claude plugin` CLI (checked manually in a temp HOME, see README), opencode loading the plugin (checked live, README "Verified")
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installClaude, installOpencode, OPENCODE_MCP_ENTRY, PLUGIN_ID } from "../src/cli/install.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));

test("installClaude runs marketplace add/update + install/update and tolerates 'already' on re-runs", () => {
  const calls: string[][] = [];
  let installed = false;
  const run = (_cmd: string, args: string[]) => {
    calls.push(args);
    if (args[1] === "marketplace" && args[2] === "add") return installed ? { status: 1, stdout: "", stderr: "Marketplace 'agent-connector' is already installed" } : { status: 0, stdout: "ok", stderr: "" };
    if (args[1] === "install") {
      const r = installed ? { status: 1, stdout: "", stderr: "Plugin already installed" } : { status: 0, stdout: "ok", stderr: "" };
      installed = true;
      return r;
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  const log: string[] = [];
  installClaude({ claude: "claude", root: ROOT, run, log: (s) => log.push(s) });
  installClaude({ claude: "claude", root: ROOT, run, log: (s) => log.push(s) });
  assert.deepEqual(calls[0], ["plugin", "marketplace", "add", join(ROOT, "integrations", "claude-plugin")]);
  assert.deepEqual(calls[2], ["plugin", "install", PLUGIN_ID]);
  assert.equal(calls.length, 8);
  assert.throws(() => installClaude({ root: ROOT, run: () => ({ status: 1, stdout: "", stderr: "boom" }), log: () => {} }), /marketplace add failed: boom/);
});

const v2 = () => ({ status: 0, stdout: "opencode v2.0.24\n", stderr: "" });

function ocHome(t: { after: (fn: () => void) => void }, cfg?: unknown) {
  const home = mkdtempSync(join(tmpdir(), "acn-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  if (cfg !== undefined) writeFileSync(join(dir, "opencode.json"), typeof cfg === "string" ? cfg : JSON.stringify(cfg));
  return { home, dir, cfgPath: join(dir, "opencode.json"), plugin: join(dir, "plugin", "agent-connector.js") };
}

test("installOpencode v2: writes mcp.servers.connector, keeps other servers/settings, copies the v2 plugin, idempotent", (t) => {
  const { home, cfgPath, plugin } = ocHome(t, { model: "x/y", mcp: { timeout: { startup: 5000 }, servers: { other: { type: "local", command: ["o"] } } } });
  const log: string[] = [];
  const calls: string[][] = [];
  const run = (cmd: string, args: string[]) => (calls.push([cmd, ...args]), v2());
  installOpencode({ home, root: ROOT, run, path: "", log: (s) => log.push(s) });
  const first = readFileSync(cfgPath, "utf8");
  installOpencode({ home, root: ROOT, run, path: "", log: (s) => log.push(s) });
  assert.equal(readFileSync(cfgPath, "utf8"), first, "second run changes nothing");
  assert.deepEqual(calls[0], ["opencode", "--version"]);
  const cfg = JSON.parse(first);
  assert.equal(cfg.model, "x/y");
  assert.deepEqual(cfg.mcp.timeout, { startup: 5000 });
  assert.deepEqual(cfg.mcp.servers.other, { type: "local", command: ["o"] });
  assert.deepEqual(cfg.mcp.servers.connector, { type: "local", command: ["agent-connector", "mcp"], environment: { CLAUDE_CODE_SESSION_ID: "" } });
  assert.deepEqual(Object.keys(cfg.mcp).sort(), ["servers", "timeout"]);
  assert.match(readFileSync(plugin, "utf8"), /export default \{\s*id: "agent-connector"/);
  // D12: agent-connector not on PATH → warning
  assert.ok(log.some((l) => /warning: `agent-connector` is not on this shell.s PATH/.test(l)), log.join("\n"));
});

test("installOpencode: fresh config gets $schema + the entry; no PATH warning when agent-connector is found", (t) => {
  const { home, cfgPath } = ocHome(t);
  const bin = mkdtempSync(join(tmpdir(), "acn-bin-"));
  t.after(() => rmSync(bin, { recursive: true, force: true }));
  writeFileSync(join(bin, "agent-connector"), "");
  const log: string[] = [];
  installOpencode({ home, root: ROOT, run: v2, path: bin, log: (s) => log.push(s) });
  const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
  assert.equal(cfg.$schema, "https://opencode.ai/config.json");
  assert.deepEqual(cfg.mcp, { servers: { connector: OPENCODE_MCP_ENTRY } });
  assert.ok(!log.some((l) => /warning/.test(l)), log.join("\n"));
});

test("installOpencode G1: opencode missing or unknown --version output → assumes v2 and says so", (t) => {
  for (const run of [
    () => ({ status: null, stdout: "", stderr: "spawn opencode ENOENT" }),
    () => ({ status: 0, stdout: "dev build", stderr: "" }),
  ]) {
    const { home, cfgPath } = ocHome(t);
    const log: string[] = [];
    installOpencode({ home, root: ROOT, run, path: "", log: (s) => log.push(s) });
    assert.deepEqual(JSON.parse(readFileSync(cfgPath, "utf8")).mcp.servers.connector, OPENCODE_MCP_ENTRY);
    assert.ok(log.some((l) => /assuming opencode v2/.test(l)), log.join("\n"));
  }
});

test("installOpencode refuses opencode 1.x, a v1-shaped mcp block, JSONC; files stay untouched", (t) => {
  {
    const original = JSON.stringify({ model: "x/y" });
    const { home, cfgPath, plugin } = ocHome(t, original);
    assert.throws(() => installOpencode({ home, root: ROOT, run: () => ({ status: 0, stdout: "1.19.3\n", stderr: "" }), log: () => {} }), /opencode 1\.x is not supported.*opencode upgrade --major.*migrate-v1/);
    assert.equal(readFileSync(cfgPath, "utf8"), original);
    assert.equal(existsSync(plugin), false);
  }
  {
    const original = JSON.stringify({ mcp: { other: { type: "local", command: ["o"] }, servers: {}, legacy: {} } });
    const { home, cfgPath, plugin } = ocHome(t, original);
    assert.throws(() => installOpencode({ home, root: ROOT, run: v2, log: () => {} }), /opencode v1 entries \(other, legacy\); move them under mcp\.servers/);
    assert.equal(readFileSync(cfgPath, "utf8"), original);
    assert.equal(existsSync(plugin), false);
  }
  {
    const { home, cfgPath } = ocHome(t, "{ // comment\n}");
    assert.throws(() => installOpencode({ home, root: ROOT, run: v2, log: () => {} }), /not plain JSON/);
    assert.equal(readFileSync(cfgPath, "utf8"), "{ // comment\n}");
  }
  {
    const { home, dir, cfgPath } = ocHome(t);
    writeFileSync(join(dir, "opencode.jsonc"), "{ // comment\n}");
    assert.throws(() => installOpencode({ home, root: ROOT, run: v2, log: () => {} }), /opencode\.jsonc is JSONC; add mcp\.servers\.connector by hand/);
    assert.equal(existsSync(cfgPath), false, "no .json is created next to the .jsonc");
  }
});
