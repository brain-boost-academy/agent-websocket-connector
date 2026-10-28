// protects=install-integrations idempotency (claude plugin marketplace/install commands, opencode config merge + plugin copy) without touching the real ~/.claude or ~/.config;
// fails_when=a second run fails on "already installed", existing opencode settings are lost, the opencode plugin file is not copied, a JSONC config is overwritten;
// no_claim=the real `claude plugin` CLI (checked manually in a temp HOME, see README), opencode loading the plugin
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { installClaude, installOpencode, PLUGIN_ID } from "../src/cli/install.ts";

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

test("installOpencode merges the MCP entry, keeps other settings, copies the plugin; refuses JSONC", (t) => {
  const home = mkdtempSync(join(tmpdir(), "acn-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const dir = join(home, ".config", "opencode");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: "x/y", mcp: { other: { type: "local", command: ["o"] } } }));
  installOpencode({ home, root: ROOT, log: () => {} });
  installOpencode({ home, root: ROOT, log: () => {} });
  const cfg = JSON.parse(readFileSync(join(dir, "opencode.json"), "utf8"));
  assert.equal(cfg.model, "x/y");
  assert.deepEqual(cfg.mcp.other, { type: "local", command: ["o"] });
  assert.deepEqual(cfg.mcp.connector, { type: "local", command: ["agent-connector", "mcp"], enabled: true });
  assert.ok(existsSync(join(dir, "plugin", "agent-connector.js")));
  writeFileSync(join(dir, "opencode.json"), "{ // comment\n}");
  assert.throws(() => installOpencode({ home, root: ROOT, log: () => {} }), /not plain JSON/);
});
