import { z } from "zod";

// Our own fields are validated strictly by type. Embedded ACP objects are checked
// only for their discriminator and passed through with unknown fields (R10).

const Id = z.string().min(1).max(256);
const IsoTime = z.string().min(1);
const NonNegInt = z.number().int().nonnegative();
/** Blob ids become file names on the receiver, so only a uuid is accepted. */
export const BLOB_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const BlobId = z.string().regex(BLOB_ID_RE);

export const ConversationId = z.string().min(1).max(128);

export const SessionRef = z.object({
  agent_id: Id,
  session_id: Id,
  cwd: z.string().min(1),
});

export const ErrorCode = z.enum([
  "unauthorized",
  "unsupported_version",
  "not_paired",
  "unknown_session",
  "agent_unavailable",
  "session_busy",
  "too_large",
  "invalid_message",
  "timeout",
  "internal",
]);

// ---- ACP passthrough (agentclientprotocol.com v1) ----

export const AcpSessionUpdate = z.looseObject({ sessionUpdate: z.string() });

export const AcpPermissionOption = z.looseObject({
  optionId: z.string(),
  name: z.string(),
  kind: z.string(),
});

export const AcpRequestPermission = z.looseObject({
  toolCall: z.looseObject({ toolCallId: z.string() }),
  options: z.array(AcpPermissionOption),
});

export const AcpPermissionOutcome = z.union([
  z.looseObject({ outcome: z.literal("cancelled") }),
  z.looseObject({ outcome: z.literal("selected"), optionId: z.string() }),
]);

export const AcpElicitation = z.looseObject({ mode: z.string(), message: z.string() });

// ---- shared payload parts ----

export const PairingInfo = z.object({
  paired: z.boolean(),
  user_display: z.string().optional(),
  /** Conversation the owner talks in (TG: chat id). Target for agent-initiated notify. */
  conversation_id: ConversationId.optional(),
});

export const AgentInfo = z.object({
  agent_id: Id,
  title: z.string(),
  default: z.boolean(),
  caps: z.object({ load_session: z.boolean(), list_sessions: z.boolean(), images: z.boolean() }),
});

export const ModeInfo = z.object({
  current: z.string(),
  available: z.array(z.object({ id: z.string(), name: z.string() })),
});

export const PermissionRequestPayload = z.object({
  request_id: Id,
  conversation_ids: z.array(ConversationId),
  session: SessionRef,
  params: AcpRequestPermission,
});

export const ElicitationRequestPayload = z.object({
  request_id: Id,
  conversation_ids: z.array(ConversationId),
  session: SessionRef,
  params: AcpElicitation,
});

export const ConversationState = z.object({
  conversation_id: ConversationId,
  session: SessionRef.nullable(),
  agent_id: Id,
  title: z.string().nullable().optional(),
  modes: ModeInfo.nullable().optional(),
  busy: z.boolean(),
  /** Why the session is busy: a turn run by the connector, or a run outside it (cron, cloudcli, terminal). */
  busy_reason: z.enum(["turn", "foreign"]).optional(),
  queue_length: NonNegInt,
});

export const RunningTurn = z.object({
  turn_id: Id,
  session: SessionRef,
  conversation_ids: z.array(ConversationId),
  text_so_far: z.string(),
  current_tool: z.string().optional(),
  steps: NonNegInt,
  started_at: IsoTime,
});

export const SessionListItem = z.object({
  session: SessionRef,
  title: z.string().nullable().optional(),
  updated_at: z.string().nullable().optional(),
  busy: z.enum(["idle", "running", "foreign"]),
});

// ---- message catalog: type -> payload schema ----

export const Payloads = {
  // handshake
  hello: z.object({
    protocol: z.object({ min: NonNegInt, max: NonNegInt }),
    acp_protocol: NonNegInt,
    connector_version: z.string(),
    agents: z.array(AgentInfo),
  }),
  welcome: z.object({
    protocol: NonNegInt,
    gateway: z.object({ kind: z.string(), label: z.string(), version: z.string() }),
    connector_id: Id,
    limits: z.object({ max_inbound_file_bytes: NonNegInt, max_outbound_file_bytes: NonNegInt }),
    pairing: PairingInfo,
  }),
  sync: z.object({
    conversations: z.array(ConversationState),
    running_turns: z.array(RunningTurn),
    pending: z.array(
      z.discriminatedUnion("kind", [
        PermissionRequestPayload.extend({ kind: z.literal("permission") }),
        ElicitationRequestPayload.extend({ kind: z.literal("elicitation") }),
      ]),
    ),
  }),
  error: z.object({ code: ErrorCode, message: z.string(), details: z.unknown().optional() }),

  // gateway -> connector
  "conversation.prompt": z.object({
    conversation_id: ConversationId,
    text: z.string(),
    origin: z.enum(["text", "voice"]),
    attachments: z.array(Id).optional(),
    session: SessionRef.optional(),
  }),
  "sessions.list": z.object({
    conversation_id: ConversationId,
    agent_id: Id.optional(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(20).optional(),
  }),
  "session.new": z.object({ conversation_id: ConversationId, agent_id: Id.optional() }),
  "session.attach": z.object({ conversation_id: ConversationId, session: SessionRef }),
  "session.cancel": z.object({ conversation_id: ConversationId }),
  "session.set_mode": z.object({ conversation_id: ConversationId, mode_id: z.string().min(1) }),
  "agent.select": z.object({ conversation_id: ConversationId, agent_id: Id }),
  "permission.respond": z.object({ request_id: Id, outcome: AcpPermissionOutcome }),
  "elicitation.respond": z.object({
    request_id: Id,
    action: z.enum(["accept", "decline", "cancel"]),
    content: z.record(z.string(), z.unknown()).optional(),
  }),
  "pairing.changed": PairingInfo.extend({
    reason: z.enum(["paired", "unpaired", "replaced", "admin_unpair"]),
  }),
  delivered: z.object({ id: Id }),

  // gateway -> connector responses
  "pairing.code": z.object({ code: z.string(), url: z.string(), expires_at: IsoTime }),
  "pairing.status.result": PairingInfo,
  "pairing.revoke.result": z.object({ ok: z.boolean() }),

  // connector -> gateway
  "session.state": ConversationState,
  "turn.started": z.object({
    turn_id: Id,
    conversation_ids: z.array(ConversationId),
    session: SessionRef,
    origin: z.enum(["text", "voice", "agent"]).optional(),
  }),
  "session.update": z.object({
    conversation_ids: z.array(ConversationId),
    session: SessionRef,
    turn_id: Id.optional(),
    update: AcpSessionUpdate,
  }),
  "turn.ended": z.object({
    turn_id: Id,
    conversation_ids: z.array(ConversationId),
    session: SessionRef,
    stop_reason: z.string(),
    duration_ms: NonNegInt,
    tool_calls: NonNegInt,
    cost_usd: z.number().nonnegative().optional(),
    /** Full agent text of the turn, so a gateway that missed chunks can finish the answer. */
    text: z.string(),
  }),
  "turn.error": z.object({
    turn_id: Id,
    conversation_ids: z.array(ConversationId),
    session: SessionRef,
    message: z.string(),
  }),
  "permission.request": PermissionRequestPayload,
  "permission.resolved": z.object({
    request_id: Id,
    by: z.enum(["user", "timeout", "cancelled"]),
    outcome: AcpPermissionOutcome.optional(),
  }),
  "elicitation.request": ElicitationRequestPayload,
  "elicitation.resolved": z.object({ request_id: Id, by: z.enum(["user", "cancelled"]) }),
  notify: z
    .object({
      notify_id: Id,
      conversation_id: ConversationId.optional(),
      session: SessionRef.optional(),
      text: z.string().optional(),
      files: z.array(Id).optional(),
      switched: z.boolean(),
    })
    .refine((p) => (p.text?.length ?? 0) > 0 || (p.files?.length ?? 0) > 0, {
      message: "notify needs text or files",
    }),
  "pairing.request": z.object({}),
  "pairing.status": z.object({}),
  "pairing.revoke": z.object({}),

  // connector -> gateway responses
  "prompt.accepted": z.object({
    session: SessionRef,
    queued_position: NonNegInt,
    /** The prompt waits for a run outside the connector to finish (Flow 9). */
    waiting_foreign: z.boolean().optional(),
  }),
  "sessions.list.result": z.object({ items: z.array(SessionListItem), next_cursor: z.string().optional() }),
  "session.new.result": z.object({ session: SessionRef }),
  "session.attach.result": z.object({
    session: SessionRef,
    title: z.string().nullable().optional(),
    last_assistant_text: z.string().optional(),
    warning: z.literal("active_elsewhere").optional(),
  }),
  "session.cancel.result": z.object({ cancelled: z.boolean() }),
  "session.set_mode.result": z.object({ mode_id: z.string() }),
  "agent.select.result": z.object({ agent_id: Id }),

  // blobs (both directions)
  "blob.begin": z.object({
    blob_id: BlobId,
    name: z.string().min(1).max(255),
    mime: z.string(),
    size: NonNegInt,
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }),
  "blob.chunk": z.object({ blob_id: BlobId, index: NonNegInt, data: z.string() }),
  "blob.end": z.object({ blob_id: BlobId }),
  "blob.stored": z.object({ blob_id: BlobId, path: z.string().optional() }),
} as const;

export type MessageType = keyof typeof Payloads;
export type PayloadOf<T extends MessageType> = z.infer<(typeof Payloads)[T]>;

/** Request type -> response type. Any request may instead get `error` with `re`. */
export const ResponseOf = {
  "conversation.prompt": "prompt.accepted",
  "sessions.list": "sessions.list.result",
  "session.new": "session.new.result",
  "session.attach": "session.attach.result",
  "session.cancel": "session.cancel.result",
  "session.set_mode": "session.set_mode.result",
  "agent.select": "agent.select.result",
  "pairing.request": "pairing.code",
  "pairing.status": "pairing.status.result",
  "pairing.revoke": "pairing.revoke.result",
  "blob.end": "blob.stored",
} as const satisfies Partial<Record<MessageType, MessageType>>;

export type RequestType = keyof typeof ResponseOf;
export type ResponseTypeOf<T extends RequestType> = (typeof ResponseOf)[T];

export const GATEWAY_TO_CONNECTOR = [
  "welcome",
  "conversation.prompt",
  "sessions.list",
  "session.new",
  "session.attach",
  "session.cancel",
  "session.set_mode",
  "agent.select",
  "permission.respond",
  "elicitation.respond",
  "pairing.changed",
  "delivered",
  "pairing.code",
  "pairing.status.result",
  "pairing.revoke.result",
] as const satisfies readonly MessageType[];

export const CONNECTOR_TO_GATEWAY = [
  "hello",
  "sync",
  "session.state",
  "turn.started",
  "session.update",
  "turn.ended",
  "turn.error",
  "permission.request",
  "permission.resolved",
  "elicitation.request",
  "elicitation.resolved",
  "notify",
  "pairing.request",
  "pairing.status",
  "pairing.revoke",
  "prompt.accepted",
  "sessions.list.result",
  "session.new.result",
  "session.attach.result",
  "session.cancel.result",
  "session.set_mode.result",
  "agent.select.result",
] as const satisfies readonly MessageType[];

export const BOTH_DIRECTIONS = ["error", "blob.begin", "blob.chunk", "blob.end", "blob.stored"] as const satisfies readonly MessageType[];

/**
 * Durable messages carry a stable dedupe key. The gateway records the key in
 * `delivered` after showing the message and acks with `delivered {id: key}` (R2, R9).
 */
export const DURABLE_TYPES = ["notify", "turn.ended", "turn.error", "permission.request", "elicitation.request"] as const;
export type DurableType = (typeof DURABLE_TYPES)[number];

export function durableKey(type: DurableType, payload: PayloadOf<DurableType>): string {
  switch (type) {
    case "notify":
      return `notify:${(payload as PayloadOf<"notify">).notify_id}`;
    case "turn.ended":
    case "turn.error":
      // A turn ends exactly once, either way.
      return `turn:${(payload as PayloadOf<"turn.ended">).turn_id}`;
    case "permission.request":
    case "elicitation.request":
      return `req:${(payload as PayloadOf<"permission.request">).request_id}`;
  }
}

/** WebSocket close codes used by the gateway. Revoked tokens also close with `unauthorized`. */
export const CloseCode = {
  unauthorized: 4401,
  unsupportedVersion: 4400,
  replaced: 4409,
} as const;
