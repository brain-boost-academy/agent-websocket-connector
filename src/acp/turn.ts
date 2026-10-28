import type { SessionUpdate } from "@agentclientprotocol/sdk";
import type { SessionRef } from "../store/store.ts";
import type { Target } from "./prompt.ts";

type Update = SessionUpdate | { sessionUpdate: string; [k: string]: unknown };

function chunkText(u: Update): string | undefined {
  const content = (u as { content?: { type?: string; text?: unknown } }).content;
  return content?.type === "text" && typeof content.text === "string" ? content.text : undefined;
}

/** Updates that do not end an agent message (thoughts, usage, housekeeping). */
const NEUTRAL_KINDS = new Set(["agent_thought_chunk", "usage_update", "available_commands_update", "session_info_update", "current_mode_update", "config_option_update"]);

/** Splits agent_message_chunk runs into messages: other updates or a new messageId start a new one. */
class MessageRuns {
  #inMessage = false;
  #messageId: string | undefined;

  /** For an agent chunk: true when it starts a new message. */
  chunkStarts(u: Update): boolean {
    const id = (u as { messageId?: unknown }).messageId;
    const messageId = typeof id === "string" && id ? id : undefined;
    const starts = !this.#inMessage || (messageId !== undefined && this.#messageId !== undefined && messageId !== this.#messageId);
    this.#inMessage = true;
    if (messageId !== undefined) this.#messageId = messageId;
    else if (starts) this.#messageId = undefined;
    return starts;
  }

  other(u: Update): void {
    if (!NEUTRAL_KINDS.has(u.sessionUpdate)) this.#inMessage = false;
  }

  boundary(): void {
    this.#inMessage = false;
  }
}

/**
 * Tracks the last agent message (a run of agent_message_chunk not interrupted by other
 * updates). Used for `last_assistant_text` previews (R4), including during load replay.
 */
export class LastMessage {
  text: string | undefined;
  #current: string | undefined;
  #runs = new MessageRuns();

  /** A new turn starts a new agent message. */
  boundary(): void {
    this.#runs.boundary();
  }

  apply(u: Update): void {
    if (u.sessionUpdate === "agent_message_chunk") {
      const current = (this.#runs.chunkStarts(u) ? "" : (this.#current ?? "")) + (chunkText(u) ?? "");
      this.#current = current;
      if (current.length > 0) this.text = current;
      return;
    }
    this.#runs.other(u);
  }
}

/** Bookkeeping for one running turn: sync.running_turns and turn.ended. */
export class Turn {
  readonly turn_id: string;
  readonly session: SessionRef;
  /** Pinned at start: conversations bound to the session plus the prompt senders. */
  readonly targets: Target[];
  readonly origin: "text" | "voice" | "agent";
  readonly startedAt: number;
  text = "";
  currentTool: string | undefined;
  toolCalls = 0;
  costUsd: number | undefined;
  stopReason: string | undefined;
  /** turn.error already emitted (e.g. agent crash). */
  failed = false;
  /** /stop arrived before the prompt was sent (session still loading). */
  cancelRequested = false;
  #toolTitles = new Map<string, string>();
  #runs = new MessageRuns();
  #newMessage = false;

  constructor(turn_id: string, session: SessionRef, targets: Target[], origin: Turn["origin"], now = Date.now()) {
    this.turn_id = turn_id;
    this.session = session;
    this.targets = targets;
    this.origin = origin;
    this.startedAt = now;
  }

  get steps(): number {
    return this.toolCalls;
  }

  apply(u: Update): void {
    if (u.sessionUpdate !== "agent_message_chunk") this.#runs.other(u);
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const t = chunkText(u) ?? "";
        if (this.#runs.chunkStarts(u)) this.#newMessage = true;
        if (!t) break;
        // agent messages of one turn are separate paragraphs ("Let me check." + tool + "Done")
        if (this.#newMessage && this.text.length > 0) this.text += "\n\n";
        this.#newMessage = false;
        this.text += t;
        break;
      }
      case "tool_call": {
        const id = String((u as { toolCallId?: unknown }).toolCallId ?? "");
        const title = String((u as { title?: unknown }).title ?? "tool");
        if (!this.#toolTitles.has(id)) this.toolCalls++;
        this.#toolTitles.set(id, title);
        this.currentTool = title;
        break;
      }
      case "tool_call_update": {
        const id = String((u as { toolCallId?: unknown }).toolCallId ?? "");
        const title = (u as { title?: unknown }).title;
        if (typeof title === "string" && title) this.#toolTitles.set(id, title);
        const status = (u as { status?: unknown }).status;
        if (status === "in_progress" || status === "pending") this.currentTool = this.#toolTitles.get(id) ?? this.currentTool;
        break;
      }
      case "usage_update": {
        const cost = (u as { cost?: { amount?: unknown; currency?: unknown } | null }).cost;
        if (cost && typeof cost.amount === "number" && (cost.currency ?? "USD") === "USD") this.costUsd = cost.amount;
        break;
      }
    }
  }
}
