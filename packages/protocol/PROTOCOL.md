# agent-connector ⇄ gateway protocol v1

Vendor-neutral link between **agent-connector** (runs next to the agents, speaks ACP to them) and a **gateway** (a user channel: Telegram today, webui/max later). The connector does not know which channel it talks to; the gateway does not know which agent is behind the connector. Agent events travel as ACP v1 objects (agentclientprotocol.com, schema 1.26) inside our envelope.

Source of truth: `src/messages.ts` (zod). `protocol.schema.json` is generated from it (`npm run schema`).

## Transport

- The connector dials `wss://<gateway>/v1/connect` with `Authorization: Bearer <connector_token>`. One token per connector (issued by the gateway admin, stored as sha256).
- Text frames only, one JSON envelope per frame, ≤ 1 MiB (`MAX_FRAME_BYTES`). Senders keep frames under it: the connector shortens oversized embedded ACP fields (tool `rawInput`/`rawOutput`/`content`, diff texts) before sending.
- WS ping every 30 s from both sides; 2 missed pongs → drop and reconnect.
- Reconnect backoff: 1 s → 60 s, ×2, ±20 % jitter. After close `4401` retry no more often than every 5 min.
- One live connection per connector: a new authenticated connection closes the old one with `4409 replaced` (last wins). The connector reconnects with normal backoff and logs loudly.

| Close code | Meaning |
|---|---|
| 4401 | unauthorized (bad or revoked token) |
| 4400 | unsupported protocol version |
| 4409 | replaced by a newer connection with the same token |

## Envelope

```ts
{ v: 1, id: string /* uuidv7 */, type: string, ts: string /* ISO 8601 */, re?: string, payload: {...} }
```

- A message with `re` is a response to the request with that `id`. Request → response types are listed in `ResponseOf`. Any request may be answered with `error {code, message, details?}` instead. Request timeout: 30 s; `conversation.prompt`, `session.new` and `session.attach` may start an agent or load a long session, so gateways wait 120 s for them (blob transfers scale with size).
- Error codes: `unauthorized | unsupported_version | not_paired | unknown_session | agent_unavailable | session_busy | too_large | invalid_message | timeout | internal`.
- Validation (R10): envelope and our own payload fields are validated strictly by type. Embedded ACP objects (`update`, `params`, `outcome`) are checked only for their discriminator and passed through with unknown fields. A receiver that gets an invalid frame answers `error invalid_message` (with `re` = frame id when known) and keeps the connection. Renderers ignore unknown `session.update` kinds (log once per kind).

`SessionRef = { agent_id, session_id, cwd }`. `session_id` is the ACP sessionId (for Claude Code it equals the transcript id in `~/.claude/projects/<cwd-slug>/<id>.jsonl`). `cwd` is required because ACP `session/load` needs it.

`conversation_id` is an opaque string chosen by the gateway (Telegram: chat id).

## Handshake

1. connector → `hello {protocol:{min,max}, acp_protocol, connector_version, agents[]}`
2. gateway → `welcome {protocol, gateway:{kind,label,version}, connector_id, limits:{max_inbound_file_bytes, max_outbound_file_bytes}, pairing:{paired, user_display?, conversation_id?}}`. If no common version: close `4400`.
3. connector → `sync {conversations[], running_turns[], pending[]}` right after every `welcome`, then resends its outbox.

## Delivery (R2, R9, R14)

No log replay. Streaming `session.update` frames are never resent.

- **Snapshot.** `sync` carries every running turn (`turn_id`, accumulated `text_so_far`, `current_tool`, `steps`) and every pending permission / elicitation. The gateway reconciles: a turn it already renders keeps editing its existing messages with `text_so_far`; an unknown turn (after a gateway restart) is drawn as a new message. Pending requests it has already shown are not shown again (dedupe below); their old buttons keep working.
- **Durable messages** `notify`, `turn.ended`, `turn.error`, `permission.request`, `elicitation.request` have a stable dedupe key (`durableKey()`): `notify:<notify_id>`, `turn:<turn_id>` (a turn ends once, by `turn.ended` or `turn.error`), `req:<request_id>`. Gateway: if the key is in `delivered` → skip and ack; else show it to the user, and **only after the channel accepted it** insert the key and answer `delivered {id: key}`. A crash exactly between showing and recording may produce one duplicate (accepted).
- When the gateway cannot show a durable message it answers `error` with `re` = the message id:
  - `internal`: transient (channel rate limit, network, database). The connector retries.
  - `invalid_message`, `not_paired`, `too_large`: terminal. The connector drops the message (a `notify` is removed from the outbox and its `send_message` caller gets the error).
- The connector keeps every durable message until `delivered` or a terminal error: `notify` in its SQLite outbox (survives restarts), the others in memory. It resends unacked ones after each `welcome`+`sync`, and while the link stays up it resends any message that got `internal` or no answer within 60 s, with backoff (5 s → 5 min). A `notify` resend always re-sends its blobs first.
- A turn the gateway still renders but that is missing from `sync.running_turns` is over (the connector restarted or the turn ended while offline); the gateway closes its status as interrupted unless a durable `turn.ended`/`turn.error` for it follows.
- `permission.respond` / `elicitation.respond` are fire-and-forget. If a request the gateway already answered is still in `sync.pending`, the gateway sends its answer again.
- `turn.ended.text` carries the full agent text of the turn, so a gateway that missed chunks can complete the answer.
- The gateway does not buffer user input while the connector is offline; it tells the user the agent is offline.

## Message catalog

Gateway → connector

| type | payload | response |
|---|---|---|
| `conversation.prompt` | `{conversation_id, text, origin: text\|voice, attachments?: blob_id[], session?: SessionRef}` (`session` = target of a reply to an agent message) | `prompt.accepted {session, queued_position, waiting_foreign?}` (0 = started now; `waiting_foreign` = queued behind a run outside the connector) |
| `sessions.list` | `{conversation_id, agent_id?, cursor?, limit≤20}` | `sessions.list.result {items:[{session, title?, updated_at?, busy: idle\|running\|foreign}], next_cursor?}` |
| `session.new` | `{conversation_id, agent_id?}` | `session.new.result {session}` |
| `session.attach` | `{conversation_id, session}` | `session.attach.result {session, title?, last_assistant_text?, warning?: "active_elsewhere"}` |
| `session.cancel` | `{conversation_id}` | `session.cancel.result {cancelled}` |
| `session.set_mode` | `{conversation_id, mode_id}` | `session.set_mode.result {mode_id}` |
| `agent.select` | `{conversation_id, agent_id}` | `agent.select.result {agent_id}` |
| `permission.respond` | `{request_id, outcome: ACP RequestPermissionOutcome}` | — |
| `elicitation.respond` | `{request_id, action: accept\|decline\|cancel, content?}` | — |
| `pairing.changed` | `{paired, user_display?, conversation_id?, reason: paired\|unpaired\|replaced\|admin_unpair}` on every change | — |
| `delivered` | `{id: durable key}` | — |

Connector → gateway

| type | payload |
|---|---|
| `session.state` | `{conversation_id, session \| null, agent_id, title?, modes?: {current, available:[{id,name}]}, busy, busy_reason?: turn\|foreign, queue_length}` after any binding/mode/busy change |
| `turn.started` | `{turn_id, conversation_ids, session, origin?: text\|voice\|agent}` |
| `session.update` | `{conversation_ids, session, turn_id?, update: ACP SessionUpdate}` |
| `turn.ended` | `{turn_id, conversation_ids, session, stop_reason, duration_ms, tool_calls, cost_usd?, text}` |
| `turn.error` | `{turn_id, conversation_ids, session, message}` |
| `permission.request` | `{request_id, conversation_ids, session, params: ACP RequestPermissionRequest}` |
| `permission.resolved` | `{request_id, by: user\|timeout\|cancelled, outcome?}` |
| `elicitation.request` | `{request_id, conversation_ids, session, params: ACP CreateElicitationRequest (form)}` |
| `elicitation.resolved` | `{request_id, by: user\|cancelled}` |
| `notify` | `{notify_id, conversation_id?, session?, text?, files?: blob_id[], switched}` (text or files required; at most 10 files) |
| `pairing.request` | → `pairing.code {code, url, expires_at}` |
| `pairing.status` | → `pairing.status.result {paired, user_display?, conversation_id?}` |
| `pairing.revoke` | → `pairing.revoke.result {ok}` |

Blobs, both directions: `blob_id` is a lowercase uuid (it becomes a file name on the receiver). A receiver rejects a duplicate id and caps open blobs (16 by default, `internal`: retry later); a stored blob that no message references within 30 min is deleted. A message that references a blob the receiver already expired is answered `internal`; the sender re-sends fresh blobs. `blob.begin {blob_id, name, mime, size, sha256}` → `blob.chunk {blob_id, index, data: base64 ≤ 512 KiB raw}`… → `blob.end {blob_id}` (request) → `blob.stored {blob_id, path?}` or `error too_large|invalid_message|internal`. Blob frames go on the bulk queue; the message that references a blob is sent only after `blob.stored`. Senders use two priorities (R21): control frames always go before queued bulk frames, with at most one chunk in between (`Peer`).

## Routing semantics (connector)

- Binding `(gateway, conversation_id) → (agent_id, session_id, cwd)`, persisted by the connector.
- A turn is pinned to the conversations bound when it started; switching sessions does not interrupt it, its output keeps flowing to the same conversations.
- A session bound to several conversations (several gateways) fans out every update and every `permission.request`; the first answer wins, the others get `permission.resolved`.
- Prompts during a turn queue FIFO per session; consecutive queued prompts are merged into one.
- Permission timeout: 30 min (config) → `reject_once` + `permission.resolved {by: timeout}`. Elicitations have no timeout (R20); `/stop` cancels them.
- A session opened from history uses ACP `session/load`; the replayed history is suppressed until `load` returns, and the last agent text is kept as `last_assistant_text` (R4).
- `notify` from an agent session (MCP `send_message`) rebinds the owner conversation to the caller session and sets `switched: true` (D8). A session running outside the connector is `foreign` until its SessionEnd hook or 15 min without transcript changes; prompts to it are queued.

## Pairing

The connector asks `pairing.request`; the gateway mints a one-time code (128 bit, TTL 10 min) and returns a channel URL (Telegram deeplink `t.me/<bot>?start=<code>`). Strictly 1:1 per gateway: one channel account ↔ one connector. If the connector already has an owner, the current owner must approve the new account (10 min, silence = reject). Every change is pushed as `pairing.changed`. `send_message` while unpaired fails with `not_paired` immediately; queued notifies rejected with `not_paired` are dropped.

## Verified adapter facts (M0, claude-agent-acp 0.93.0, 2026-10-19)

- `initialize` with `clientCapabilities.elicitation.form` → `loadSession: true`, `sessionCapabilities: {list, resume, close, delete, fork, …}`, `promptCapabilities.image: true`.
- ACP sessionId equals the jsonl file name under `~/.claude/projects/<cwd with non-alnum → "-">/`.
- `session/list {cwd}` returns `{sessionId, cwd, title, updatedAt}`.
- Modes: `default` (Manual), `acceptEdits`, `plan`, `auto`, `bypassPermissions`.
- Permission for Bash: options `allow-once/allow_once "Yes"`, `reject/reject_once "No"`.
- AskUserQuestion → `elicitation/create` form: `question_<n>` (`type: string` + `oneOf` of `{const,title,description}`, or `type: array` + `items.anyOf` for multi-select) and `question_<n>_custom` (`title: "Other"`, free text). Accept with `{question_0: "<label>"}` or `{question_0_custom: "<text>"}`.
- `session/close` then `session/load` replays the history as `session/update` (user_message_chunk, tool_call, tool_call_update, agent_message_chunk) before the response (~1 s). `available_commands_update` arrives after the response.
- Cost: the last `usage_update` of a turn has `cost: {amount, currency: "USD"}`.
- `CLAUDE_CODE_EXECUTABLE` must point to the user's `claude` binary.
