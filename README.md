# agent-connector

Daemon that runs next to the user's coding agents (Claude Code via `claude-agent-acp`, `opencode acp`), speaks [ACP](https://agentclientprotocol.com) to them and dials out to one or more **channel gateways** (Telegram today) over WebSocket. The protocol between connector and gateway lives in [`packages/protocol`](packages/protocol/PROTOCOL.md).

```
claude-agent-acp ─┐ stdio ACP                      WSS (outbound only)
opencode acp ─────┤──► agent-connector daemon ───────────────────────► gateway(s)
                  │      ├ SQLite state (bindings, notify outbox, kv)
                  │      └ unix socket (control, 0600) ◄── agent-connector mcp / CLI / hooks
```

## Install

Requirements: Node ≥ 24, a logged-in `claude` CLI (default `~/.local/bin/claude`), optionally `opencode`.

```sh
npm i -g https://github.com/brain-boost-academy/agent-websocket-connector/releases/download/v0.1.0/agent-connector-0.1.0.tgz
agent-connector install-integrations            # Claude Code plugin + opencode plugin
mkdir -p ~/.config/agent-connector && chmod 700 ~/.config/agent-connector
# config.json and the gateway token (both 0600), see below
cp "$(npm root -g)/agent-connector/deploy/agent-connector.service" ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now agent-connector
```

The tgz bundles the protocol package and pins `@agentclientprotocol/claude-agent-acp` exactly; the default `claude` agent runs that pinned entrypoint with the daemon's Node (no global `claude-agent-acp` needed).

## Configuration

`~/.config/agent-connector/config.json` (mode 0600; `AGENT_CONNECTOR_CONFIG` overrides the path). Every key is optional; a missing file means defaults and no gateways.

```json
{
  "cwd": "~/work",
  "uploads_dir": "~/work/uploads",
  "default_agent": "claude",
  "agents": {
    "claude":   { "command": "claude-agent-acp", "env": { "CLAUDE_CODE_EXECUTABLE": "~/.local/bin/claude" } },
    "opencode": { "command": "opencode", "args": ["acp"] }
  },
  "gateways": [
    { "name": "telegram", "url": "wss://gateway.example/v1/connect", "token_file": "~/.config/agent-connector/telegram.token" }
  ],
  "default_channel": "telegram",
  "permission_timeout_s": 1800,
  "session_lifecycle": { "mode": "after_turn", "max_open_sessions": 3, "idle_close_minutes": 30, "busy_hold_minutes": 10 }
}
```

| Key | Default | Notes |
|---|---|---|
| `cwd` | `~/work` | Agents run here; new sessions and `/sessions` use it. Created if missing. |
| `uploads_dir` | `<cwd>/uploads` | Inbound files go to `<uploads_dir>/YYYY-MM-DD/<name>`, never overwritten (`name-1.ext`, `name-2.ext`). |
| `agents` | claude + opencode | If present, replaces the default set; the ids `claude`/`opencode` inherit default command/env/kind. `command: "claude-agent-acp"` = the bundled adapter. Optional `title`, `kind` (`claude` enables transcript checks). |
| `gateways[]` | none | `token_file` holds the connector token issued by the gateway admin (0600). Re-read on every connect. |
| `default_channel` | first gateway | Target of `send_message` without `channel`. |
| `permission_timeout_s` | 1800 | Unanswered permission → `reject_once`. Questions (elicitations) have no timeout. |
| `session_lifecycle.mode` | `after_turn` | `after_turn`: `session/close` after every turn (like cloudcli); `lru`: keep up to `max_open_sessions` per agent, close after `idle_close_minutes`. |

`~` is expanded in paths and agent env values. Other paths: state `~/.local/state/agent-connector/state.db` (`AGENT_CONNECTOR_STATE_DIR`), control socket `$XDG_RUNTIME_DIR/agent-connector.sock` or `<state dir>/agent-connector.sock` (`AGENT_CONNECTOR_SOCKET`), log level `AGENT_CONNECTOR_LOG=debug|info|warn|error`. `agent-connector check-config` prints the effective config.

## Pairing

Pair a channel account (e.g. your Telegram) with this connector:

- in a terminal: `agent-connector pair [--channel telegram]` prints a one-time link (10 min);
- or ask the agent in an interactive session ("подключи телеграм"): it calls the MCP tool `pair_channel`.

`agent-connector channels` shows connection/pairing state, `agent-connector unpair` removes it. The gateway pushes every pairing change (`pairing.changed`).

## Integrations

`agent-connector install-integrations [--claude] [--opencode]` (both when no flag; idempotent):

- **Claude Code**: `claude plugin marketplace add <pkg>/integrations/claude-plugin` + `claude plugin install agent-connector@agent-connector` (+ update). The plugin ships
  - MCP server `connector` → `agent-connector mcp` with tools `send_message`, `pair_channel`, `list_channels`;
  - `PreToolUse` hook, matcher `^mcp__plugin_agent-connector_connector__(send_message|list_channels)$` → `agent-connector hook pre-tool-use`: allows the call and adds `caller_session_id`, `caller_cwd`, `caller_agent` to the tool input. `pair_channel` is not auto-allowed (normal permission flow);
  - `SessionEnd` hook → `agent-connector hook session-end` (releases sessions marked as running elsewhere).
- **opencode**: merges `mcp.connector = {type: "local", command: ["agent-connector", "mcp"]}` into `~/.config/opencode/opencode.json` (plain JSON only) and copies `integrations/opencode/agent-connector.js` to `~/.config/opencode/plugin/` (`tool.execute.before` adds the caller fields, `session.idle` → session-end).

Rollback: `systemctl --user disable --now agent-connector`, `claude plugin uninstall agent-connector@agent-connector`, remove the opencode entry/plugin.

## CLI

```
agent-connector daemon | pair | unpair | status | channels [--json] | mcp | hook pre-tool-use|session-end
agent-connector install-integrations [--claude] [--opencode] | check-config | --help | --version
```

Control socket (newline-delimited JSON-RPC 2.0, used by CLI/MCP/hooks): `send_message {text?, files?, channel?, caller_session_id?, caller_cwd?, caller_agent?, env_session_id?, env_cwd?}`, `pair_channel {channel?}`, `list_channels`, `unpair {channel?}`, `status`, `session_end {session_id}`. Errors carry `error.data.code` (`not_paired`, `too_large`, `offline`, `file_not_found`, `unknown_channel`, ...).

## What the connector does (gateway-visible behaviour)

- **Handshake**: `hello` (agents with caps from their last `initialize`) → `welcome` → `sync` after every welcome, then resend of unacked durables (`turn.ended`, `permission.request`, `elicitation.request` from memory, except requests already in `sync.pending`; `notify` from the SQLite outbox with its files re-sent as fresh blobs first). Durables are kept until `delivered {id: durableKey}`; a `notify` answered with `error not_paired|too_large|invalid_message` is dropped and logged.
- **Bindings** `(gateway, conversation_id) → (agent_id, session)` persist. `conversation.prompt` without a binding creates a session (default or `agent.select`ed agent, config `cwd`); with `session` (reply) it rebinds the conversation to that session. `prompt.accepted.queued_position` is 0 when the turn starts now, else the queue length. Attachments must be blob ids stored on the same link earlier (each usable once).
- **Turns** are pinned to the conversations bound at start plus the senders of the merged prompts; every gateway with such a conversation gets `turn.started`, `session.update` (ACP as is, `turn_id` set), `turn.ended {text, cost_usd, tool_calls, duration_ms, stop_reason}` or `turn.error`. `steps` = tool calls. Updates outside a turn go to bound conversations without `turn_id` (`available_commands_update` outside a turn is not forwarded).
- **Queue**: prompts arriving during a turn (or while the session is `foreign`) queue FIFO and are merged into one prompt (`\n\n`-joined). `session.state` is sent on binding/busy/queue/mode/title changes.
- **Permissions** fan out to every bound conversation on every gateway; first `permission.respond` wins, all target gateways get `permission.resolved {by: user|timeout|cancelled, outcome}`. Timeout picks the `reject_once` option. Elicitations (form mode) likewise, no timeout, `elicitation.resolved {by: user|cancelled}`.
- **`session.cancel`** cancels the running turn (pending permission → `cancelled`, pending question → `cancel`) and drops queued prompts; `cancelled: true` if there was a turn or a queue.
- **History** (R4): a session not open in the agent process is opened with `session/load`; replayed updates are swallowed, the last agent message becomes `last_assistant_text`. `session.attach` of a closed session loads it for the preview (and closes it again in `after_turn`). `warning: "active_elsewhere"` when the Claude transcript changed < 60 s ago, not by this connector, and no turn runs here.
- **lru mode** (R13): before prompting an open Claude session the transcript mtime+size is compared; a change → close + load.
- **Proactive** (`send_message`): caller = hook fields → `CLAUDE_CODE_SESSION_ID` of the MCP process → none. If the connector runs the caller session, the notify goes to its bound conversations; otherwise to the owner conversation (`pairing.conversation_id`) of the channel, which is rebound to the caller session (`switched: true` when it changed) and the session is `foreign` (prompts queue) until its SessionEnd hook or 15 min without transcript changes. Files: absolute or relative to `caller_cwd`; any file over `limits.max_outbound_file_bytes` → `too_large` before anything is sent. Known-unpaired channel → `not_paired` immediately, nothing queued. Offline gateway → persisted, reported `queued`. Waits ≤ 15 s for `delivered`, then reports `queued`.
- **Agent crash** → `turn.error` for its running turns, pending interactions resolved `cancelled`, restart with backoff (1 s → 60 s); sessions reload on the next prompt; a session created by `session.new` but never prompted is unbound (`session.state` with `session: null`).
- **Link**: ping every 30 s, 2 missed pongs → reconnect; backoff 1 s → 60 s ×2 ±20 %, reset after 60 s connected; close 4401 / HTTP 401 → next attempt ≥ 5 min; 4409 → error log ("another agent-connector uses this token") and normal backoff; 4400 → ≥ 5 min. Invalid inbound frames → `error invalid_message` (with `re` when known), link stays up.

## Troubleshooting

- `agent-connector status` — gateways (`connected`, `last_error`, `next_retry_at`, outbox size), agents (`running`, caps, `last_error`), sessions.
- Logs: `journalctl --user -u agent-connector -f`; `AGENT_CONNECTOR_LOG=debug` includes agent stderr.
- `unauthorized` in status: wrong/revoked token in `token_file`; the daemon retries at most every 5 min (restart the unit after fixing the token to retry now).
- Repeated `CONNECTION REPLACED (4409)`: two connectors use the same token.
- MCP tool says "daemon is not running": the unit is down or `AGENT_CONNECTOR_SOCKET`/`XDG_RUNTIME_DIR` differ between the daemon and the agent.
- Unix socket paths are limited to ~107 bytes; keep `AGENT_CONNECTOR_SOCKET` short.

## Development

```sh
npm ci
npm run typecheck        # protocol + connector (src and tests)
npm test                 # protocol tests + connector unit/integration tests (fake ACP agent, fake gateways)
npm run test:adapters    # opt-in, real claude-agent-acp (and opencode if on PATH); costs a few cents
npm run build            # dist/ (prepack runs it)
```

`test:adapters` is required before bumping the pinned `@agentclientprotocol/claude-agent-acp`. Releases: tag `vX.Y.Z` → `agent-connector-X.Y.Z.tgz`; tag `protocol-vX.Y.Z` → `brain-boost-academy-agent-protocol-X.Y.Z.tgz` (gateway pins `https://github.com/brain-boost-academy/agent-websocket-connector/releases/download/protocol-vX.Y.Z/brain-boost-academy-agent-protocol-X.Y.Z.tgz`).

## Verified (2026-10-19)

**Spike (b), Claude Code 2.1.303 plugin hook** — `claude -p --model haiku --plugin-dir integrations/claude-plugin/plugin` against a stub control socket, asked to call `list_channels`, `send_message` and `Bash echo hi`:
- exact tool names: `mcp__plugin_agent-connector_connector__list_channels`, `mcp__plugin_agent-connector_connector__send_message` (matcher unchanged);
- `PreToolUse` fired exactly twice (our two tools), not for `Bash` or `ToolSearch`; `SessionEnd` fired once with the session id;
- `updatedInput` reached the MCP server: the daemon received `send_message {text, caller_session_id, caller_agent: "claude", caller_cwd}` (low-level MCP `Server`, no schema stripping); our tools ran in `-p` without `--allowedTools` thanks to the hook's `allow`;
- the MCP process also had `CLAUDE_CODE_SESSION_ID` equal to the session id.
- Found and fixed during the spike: socket paths over 108 bytes fail (`EINVAL`); readline re-emitted socket errors crashed the MCP server.

**Spike (c), opencode 1.19.3** (scratch install, isolated XDG dirs, free default model): MCP tool names `connector_send_message` / `connector_list_channels`; with the plugin mutating `output.args` in place, the daemon received `caller_session_id: "ses_…"`, `caller_cwd`, `caller_agent: "opencode"`; `session.idle` triggered `hook session-end`. (Reassigning `output.args` does not work.) An opencode process started from inside a Claude Code shell inherits `CLAUDE_CODE_SESSION_ID`; the daemon strips it from agent environments and hook fields take precedence.

**`npm run test:adapters`** (claude-agent-acp 0.93.0 through the full connector stack, haiku): caps `load_session/list_sessions/images`; turn with `cost_usd`; ACP sessionId = jsonl name; after_turn reload keeps context with no replayed update reaching the gateway; preview from load; `session/list` sees a `claude -p` session and attach previews it; Bash permission offers `allow_once`/`reject_once`, reject reaches the agent; AskUserQuestion → form with `question_0` + `question_0_custom`, custom answer reaches the agent; `/stop` → `stop_reason: cancelled` < 3 s. opencode 1.19.3: caps, turn, reload with context, list.

Not verified: opencode permission/elicitation shapes (default config allows tools), exact Claude background-task lifecycle (the adapter reports `async_task_*` only to clients declaring a vendor capability). Instead a tool call with `rawInput.run_in_background: true` holds the session open after the turn until `busy_hold_minutes` without activity; observed in e2e that without this hold a background `sleep 60` was killed by the after-turn close.
