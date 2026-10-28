import { ProtocolError, durableKey, type AnyEnvelope, type PayloadOf } from "@brain-boost-academy/agent-protocol";
import type * as acp from "@agentclientprotocol/sdk";
import type { AgentPool } from "../acp/agent-pool.ts";
import type { Target, Upload } from "../acp/prompt.ts";
import type { PendingInteraction, ResolvedBy, SessionEvents, SessionManager } from "../acp/session-manager.ts";
import type { Turn } from "../acp/turn.ts";
import type { Logger } from "../log.ts";
import type { Binding, SessionRef, Store } from "../store/store.ts";
import type { Config } from "./config.ts";
import type { GatewayLink } from "./gateway-link.ts";

/**
 * Bindings and fan-out: maps gateway messages to sessions and session events to the conversations
 * a turn is pinned to, on every gateway.
 */
export class Router implements SessionEvents {
  #cfg: Config;
  #store: Store;
  #pool: AgentPool;
  #log: Logger;
  sessions!: SessionManager;
  readonly links = new Map<string, GatewayLink>();

  constructor(cfg: Config, store: Store, pool: AgentPool, log: Logger) {
    this.#cfg = cfg;
    this.#store = store;
    this.#pool = pool;
    this.#log = log.child("router");
  }

  // ---- bindings ----

  binding(t: Target): Binding {
    return this.#store.getBinding(t.gateway, t.conversation_id) ?? { ...t, agent_id: this.#cfg.default_agent, session: null };
  }

  bind(t: Target, session: SessionRef): void {
    this.#store.setBinding({ ...t, agent_id: session.agent_id, session });
  }

  boundTargets(ref: SessionRef): Target[] {
    return this.#store.bindingsForSession(ref.agent_id, ref.session_id).map((b) => ({ gateway: b.gateway, conversation_id: b.conversation_id }));
  }

  stateOf(t: Target): PayloadOf<"session.state"> {
    const b = this.binding(t);
    const st: PayloadOf<"session.state"> = { conversation_id: t.conversation_id, session: b.session, agent_id: b.agent_id, busy: false, queue_length: 0 };
    if (b.session) {
      const info = this.sessions.info(b.session);
      st.busy = info.busy || info.foreign;
      if (st.busy) st.busy_reason = info.foreign ? "foreign" : "turn";
      st.queue_length = info.queue_length;
      if (info.title !== undefined) st.title = info.title;
      if (info.modes) st.modes = info.modes;
    }
    return st;
  }

  sendState(t: Target): void {
    this.links.get(t.gateway)?.send("session.state", this.stateOf(t));
  }

  // ---- gateway → connector ----

  /** R2 snapshot for one gateway. */
  sync(link: GatewayLink): PayloadOf<"sync"> {
    const mine = (targets: Target[]) => targets.filter((t) => t.gateway === link.name).map((t) => t.conversation_id);
    const conversations = this.#store.bindingsForGateway(link.name).map((b) => this.stateOf(b));
    const running_turns = this.sessions
      .runningTurns()
      .filter((t) => mine(t.targets).length > 0)
      .map((t) => {
        const rt: PayloadOf<"sync">["running_turns"][number] = {
          turn_id: t.turn_id, session: t.session, conversation_ids: mine(t.targets), text_so_far: t.text, steps: t.steps, started_at: new Date(t.startedAt).toISOString(),
        };
        if (t.currentTool) rt.current_tool = t.currentTool;
        return rt;
      });
    const pending = this.sessions
      .pendingInteractions()
      .filter((p) => mine(p.targets).length > 0)
      .map((p) => {
        const base = { request_id: p.request_id, conversation_ids: mine(p.targets), session: p.session };
        return p.kind === "permission"
          ? { kind: "permission" as const, ...base, params: p.params as PayloadOf<"permission.request">["params"] }
          : { kind: "elicitation" as const, ...base, params: p.params as unknown as PayloadOf<"elicitation.request">["params"] };
      });
    return { conversations, running_turns, pending };
  }

  /** Conversation-scoped requests are handled one at a time per conversation. */
  #chains = new Map<string, Promise<void>>();

  handle(link: GatewayLink, env: AnyEnvelope): Promise<void> {
    const conv = SERIAL_TYPES.has(env.type) ? (env.payload as { conversation_id?: string }).conversation_id : undefined;
    if (conv === undefined) return this.#handleNow(link, env);
    const k = `${link.name}\u0000${conv}`;
    const run = (this.#chains.get(k) ?? Promise.resolve()).then(() => this.#handleNow(link, env));
    this.#chains.set(k, run);
    void run.then(() => {
      if (this.#chains.get(k) === run) this.#chains.delete(k);
    });
    return run;
  }

  async #handleNow(link: GatewayLink, env: AnyEnvelope): Promise<void> {
    try {
      await this.#dispatch(link, env);
    } catch (err) {
      const pe = err instanceof ProtocolError ? err : new ProtocolError(err instanceof Error && err.name === "AgentUnavailable" ? "agent_unavailable" : "internal", err instanceof Error ? err.message : String(err));
      this.#log.warn(`${env.type} failed`, { code: pe.code, message: pe.message });
      link.replyError(env, pe);
    }
  }

  async #dispatch(link: GatewayLink, env: AnyEnvelope): Promise<void> {
    const gw = link.name;
    switch (env.type) {
      case "conversation.prompt": {
        const p = env.payload;
        const t = { gateway: gw, conversation_id: p.conversation_id };
        // all or nothing: an unknown id must not consume the other uploads of this prompt
        for (const id of p.attachments ?? []) if (!link.hasUpload(id)) throw new ProtocolError("invalid_message", `unknown attachment ${id}`);
        const uploads: Upload[] = (p.attachments ?? []).map((id) => link.takeUpload(id)!);
        const bound = this.binding(t);
        const before = bound.session;
        let ref = p.session ?? before;
        if (p.session) this.#requireAgent(p.session.agent_id);
        if (!ref) ref = await this.sessions.newSession(bound.agent_id, this.#cfg.cwd);
        if (!sameRef(before, ref)) this.bind(t, ref);
        const queued_position = this.sessions.enqueue(ref, { text: p.text, origin: p.origin, uploads, from: t });
        const waiting_foreign = queued_position > 0 && this.sessions.info(ref).foreign;
        link.reply(env, "prompt.accepted", { session: ref, queued_position, ...(waiting_foreign ? { waiting_foreign } : {}) });
        if (!sameRef(before, ref) || queued_position > 0) this.sendState(t);
        return;
      }
      case "sessions.list": {
        const p = env.payload;
        const agent = p.agent_id ?? this.binding({ gateway: gw, conversation_id: p.conversation_id }).agent_id;
        this.#requireAgent(agent);
        link.reply(env, "sessions.list.result", await this.sessions.list(agent, this.#cfg.cwd, p.cursor, p.limit ?? 10));
        return;
      }
      case "session.new": {
        const t = { gateway: gw, conversation_id: env.payload.conversation_id };
        const agent = env.payload.agent_id ?? this.binding(t).agent_id;
        this.#requireAgent(agent);
        const ref = await this.sessions.newSession(agent, this.#cfg.cwd);
        this.bind(t, ref);
        link.reply(env, "session.new.result", { session: ref });
        this.sendState(t);
        return;
      }
      case "session.attach": {
        const p = env.payload;
        const t = { gateway: gw, conversation_id: p.conversation_id };
        this.#requireAgent(p.session.agent_id);
        const preview = await this.sessions.attach(p.session);
        this.bind(t, p.session);
        link.reply(env, "session.attach.result", { session: p.session, ...preview });
        this.sendState(t);
        return;
      }
      case "session.cancel": {
        const ref = this.binding({ gateway: gw, conversation_id: env.payload.conversation_id }).session;
        const cancelled = ref ? await this.sessions.cancel(ref) : false;
        link.reply(env, "session.cancel.result", { cancelled });
        return;
      }
      case "session.set_mode": {
        const t = { gateway: gw, conversation_id: env.payload.conversation_id };
        const ref = this.binding(t).session;
        if (!ref) throw new ProtocolError("unknown_session", "no session bound to this conversation");
        const mode_id = await this.sessions.setMode(ref, env.payload.mode_id);
        link.reply(env, "session.set_mode.result", { mode_id });
        return;
      }
      case "agent.select": {
        const t = { gateway: gw, conversation_id: env.payload.conversation_id };
        this.#requireAgent(env.payload.agent_id);
        // The next prompt starts a new session with this agent.
        this.#store.setBinding({ ...t, agent_id: env.payload.agent_id, session: null });
        link.reply(env, "agent.select.result", { agent_id: env.payload.agent_id });
        this.sendState(t);
        return;
      }
      case "permission.respond":
        if (!this.sessions.respondPermission(env.payload.request_id, env.payload.outcome as acp.RequestPermissionOutcome)) {
          this.#log.info("permission answer for an unknown or resolved request", { request_id: env.payload.request_id });
        }
        return;
      case "elicitation.respond":
        if (!this.sessions.respondElicitation(env.payload.request_id, env.payload.action, env.payload.content)) {
          this.#log.info("elicitation answer for an unknown or resolved request", { request_id: env.payload.request_id });
        }
        return;
      default:
        if (env.re) return; // stray response
        throw new ProtocolError("invalid_message", `unexpected ${env.type} from gateway`);
    }
  }

  #requireAgent(agent_id: string): void {
    if (!this.#pool.has(agent_id)) throw new ProtocolError("agent_unavailable", `unknown agent ${agent_id}`);
  }

  // ---- session events → gateways ----

  #fanout(targets: Target[], fn: (link: GatewayLink, conversation_ids: string[]) => void): void {
    const byGw = new Map<string, string[]>();
    for (const t of targets) byGw.set(t.gateway, [...(byGw.get(t.gateway) ?? []), t.conversation_id]);
    for (const [gw, ids] of byGw) {
      const link = this.links.get(gw);
      if (link) fn(link, ids);
    }
  }

  turnStarted(turn: Turn): void {
    this.#fanout(turn.targets, (l, ids) => l.send("turn.started", { turn_id: turn.turn_id, conversation_ids: ids, session: turn.session, origin: turn.origin }));
  }

  update(ref: SessionRef, turn: Turn | undefined, update: acp.SessionUpdate): void {
    const targets = turn?.targets ?? this.boundTargets(ref);
    this.#fanout(targets, (l, ids) => {
      const p: PayloadOf<"session.update"> = { conversation_ids: ids, session: ref, update: update as PayloadOf<"session.update">["update"] };
      if (turn) p.turn_id = turn.turn_id;
      l.send("session.update", p);
    });
  }

  turnEnded(turn: Turn, durationMs: number): void {
    this.#fanout(turn.targets, (l, ids) => {
      const p: PayloadOf<"turn.ended"> = {
        turn_id: turn.turn_id, conversation_ids: ids, session: turn.session, stop_reason: turn.stopReason ?? "end_turn",
        duration_ms: Math.max(0, Math.round(durationMs)), tool_calls: turn.toolCalls, text: turn.text,
      };
      if (turn.costUsd !== undefined) p.cost_usd = turn.costUsd;
      l.sendDurable("turn.ended", p);
    });
  }

  turnError(turn: Turn, message: string): void {
    // durable like turn.ended (same key turn:<id>): the user learns the turn failed even after an outage
    this.#fanout(turn.targets, (l, ids) => l.sendDurable("turn.error", { turn_id: turn.turn_id, conversation_ids: ids, session: turn.session, message }));
  }

  interactionRequested(p: PendingInteraction): void {
    this.#fanout(p.targets, (l, ids) => {
      const base = { request_id: p.request_id, conversation_ids: ids, session: p.session };
      if (p.kind === "permission") l.sendDurable("permission.request", { ...base, params: p.params as PayloadOf<"permission.request">["params"] });
      else l.sendDurable("elicitation.request", { ...base, params: p.params as unknown as PayloadOf<"elicitation.request">["params"] });
    });
  }

  /** request_id → gateways that rejected the request for good (not_paired, invalid_message, too_large). */
  #rejected = new Map<string, Set<string>>();

  /** A durable dropped by a gateway: once every gateway of a pending request dropped it, nobody can answer it. */
  durableRejected(link: GatewayLink, key: string): void {
    if (!key.startsWith("req:")) return;
    const request_id = key.slice("req:".length);
    const p = this.sessions.pendingInteractions().find((x) => x.request_id === request_id);
    if (!p) return;
    const rejected = this.#rejected.get(request_id) ?? new Set<string>();
    rejected.add(link.name);
    this.#rejected.set(request_id, rejected);
    const gateways = new Set(p.targets.map((t) => t.gateway).filter((g) => this.links.has(g)));
    if ([...gateways].every((g) => rejected.has(g))) this.sessions.cancelInteraction(request_id);
  }

  interactionResolved(p: PendingInteraction, by: ResolvedBy, outcome?: acp.RequestPermissionOutcome): void {
    this.#rejected.delete(p.request_id);
    const k = durableKey("permission.request", { request_id: p.request_id } as PayloadOf<"permission.request">);
    // First answer wins; every gateway that saw the request learns the outcome.
    this.#fanout(p.targets, (l) => {
      l.dropDurable(k);
      if (p.kind === "permission") {
        const r: PayloadOf<"permission.resolved"> = { request_id: p.request_id, by };
        if (outcome) r.outcome = outcome as PayloadOf<"permission.resolved">["outcome"];
        l.send("permission.resolved", r);
      } else {
        l.send("elicitation.resolved", { request_id: p.request_id, by: by === "timeout" ? "cancelled" : by });
      }
    });
  }

  sessionLost(ref: SessionRef): void {
    for (const b of this.#store.bindingsForSession(ref.agent_id, ref.session_id)) {
      this.#store.setBinding({ ...b, session: null });
      this.sendState(b);
    }
  }

  stateChanged(ref: SessionRef): void {
    for (const t of this.boundTargets(ref)) this.sendState(t);
  }
}

const SERIAL_TYPES = new Set(["conversation.prompt", "session.new", "session.attach", "session.set_mode", "agent.select"]);

export function sameRef(a: SessionRef | null | undefined, b: SessionRef | null | undefined): boolean {
  return !!a && !!b && a.agent_id === b.agent_id && a.session_id === b.session_id;
}
