#!/usr/bin/env node
import { parseArgs } from "node:util";
import { callControl } from "../control/client.ts";
import { configPath, loadConfig, socketPath, stateDir } from "../daemon/config.ts";
import { CONNECTOR_VERSION } from "../version.ts";

const HELP = `agent-connector ${CONNECTOR_VERSION}: connects local ACP agents (Claude Code, opencode) to channel gateways.

Usage: agent-connector <command> [options]

Commands:
  daemon                         run the daemon (systemd --user unit runs this)
  pair [--channel <name>]        print a one-time pairing link for a channel
  unpair [--channel <name>]      remove the pairing on a channel
  status                         daemon, gateway, agent and session status
  channels                       list channels (connected / paired)
  mcp                            stdio MCP server "connector" (started by Claude Code / opencode)
  hook pre-tool-use|session-end  Claude Code hook entry points (read hook JSON on stdin)
  install-integrations [--claude] [--opencode] [--json] [--dry-run]
                                 install the Claude Code plugin and/or the opencode plugin
                                 (both when no flag); writes only what differs
  uninstall-integrations [--claude] [--opencode] [--json] [--dry-run]
                                 remove them again
                                 --json: one line {"claude":"changed"|"unchanged",...} on
                                 stdout, messages on stderr; --dry-run: report, change nothing

Files:
  config   ${configPath()}
  state    ${stateDir()}
  socket   ${socketPath()}
`;

async function main(argv: string[]): Promise<void> {
  const [cmd, ...rest] = argv;
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    strict: false,
    options: { channel: { type: "string" }, json: { type: "boolean" } },
  });
  const channel = typeof values.channel === "string" ? values.channel : undefined;
  switch (cmd) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      process.stdout.write(HELP);
      return;
    case "--version":
    case "-v":
      console.log(CONNECTOR_VERSION);
      return;
    case "daemon": {
      const { runDaemon } = await import("./daemon-cmd.ts");
      await runDaemon();
      return;
    }
    case "mcp": {
      const { runMcpServer } = await import("../mcp/server.ts");
      await runMcpServer();
      return;
    }
    case "hook": {
      const { runHook } = await import("./hook.ts");
      await runHook(positionals[0]);
      return;
    }
    case "pair": {
      const r = await callControl<{ url: string; expires_at: string; channel: string }>("pair_channel", { channel });
      console.log(`Open this link to pair ${r.channel} (one-time, expires ${r.expires_at}):\n${r.url}`);
      return;
    }
    case "unpair": {
      const r = await callControl<{ ok: boolean; channel: string }>("unpair", { channel });
      console.log(r.ok ? `${r.channel}: unpaired` : `${r.channel}: nothing to unpair`);
      return;
    }
    case "status":
      console.log(JSON.stringify(await callControl("status"), null, 2));
      return;
    case "channels": {
      const list = await callControl<Array<{ name: string; label: string; connected: boolean; paired: boolean; user_display?: string }>>("list_channels");
      if (values.json) console.log(JSON.stringify(list, null, 2));
      else if (list.length === 0) console.log("no channels configured");
      else for (const c of list) console.log(`${c.name} (${c.label}): ${c.connected ? "connected" : "offline"}, ${c.paired ? `paired with ${c.user_display ?? "?"}` : "not paired"}`);
      return;
    }
    case "install-integrations":
    case "uninstall-integrations": {
      await integrations(cmd, rest);
      return;
    }
    case "check-config": {
      const { config, path, exists } = loadConfig();
      console.log(JSON.stringify({ path, exists, config }, null, 2));
      return;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

/** install-/uninstall-integrations: strict flags (a typo must not turn --dry-run into a real run). */
async function integrations(cmd: "install-integrations" | "uninstall-integrations", args: string[]): Promise<void> {
  let values: { claude?: boolean; opencode?: boolean; json?: boolean; "dry-run"?: boolean; help?: boolean };
  try {
    ({ values } = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { claude: { type: "boolean" }, opencode: { type: "boolean" }, json: { type: "boolean" }, "dry-run": { type: "boolean" }, help: { type: "boolean", short: "h" } },
    }));
  } catch (err) {
    process.stderr.write(`agent-connector ${cmd}: ${(err as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  const { installClaude, installOpencode, uninstallClaude, uninstallOpencode } = await import("./install.ts");
  const json = values.json ?? false;
  const dryRun = values["dry-run"] ?? false;
  const log = (s: string) => (json ? process.stderr : process.stdout).write(`${s}\n`);
  const both = !values.claude && !values.opencode;
  const install = cmd === "install-integrations";
  const result: Record<string, string> = {};
  if (values.claude || both) result.claude = install ? installClaude({ log, dryRun, optional: both }) : uninstallClaude({ log, dryRun });
  if (values.opencode || both) result.opencode = install ? installOpencode({ log, dryRun }) : uninstallOpencode({ log, dryRun });
  if (json) process.stdout.write(`${JSON.stringify(result)}\n`);
  else for (const [name, change] of Object.entries(result)) console.log(`${name}: ${change}${dryRun ? " (dry run)" : ""}`);
}

main(process.argv.slice(2)).catch((err: Error & { code?: string }) => {
  process.stderr.write(`agent-connector: ${err.code && err.name !== "DaemonNotRunning" ? `${err.code}: ` : ""}${err.message}\n`);
  process.exitCode = 1;
});
