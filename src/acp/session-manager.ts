import { readFile } from "node:fs/promises";
import type * as acp from "@agentclientprotocol/sdk";
import { ProtocolError, uuidv7 } from "@brain-boost-academy/agent-protocol";
import type { Config } from "../daemon/config.ts";
import type { Logger } from "../log.ts";
import type { SessionRef } from "../store/store.ts";
import { AgentUnavailable, type AgentPool } from "./agent-pool.ts";
import { pickEvictions, shouldClose, type LifecycleEvent, type SessionView } from "./lifecycle.ts";
import { buildPromptBlocks, mergePrompts, type QueuedPrompt, type Target } from "./prompt.ts";
import { claudeTranscriptPath, statTranscript, transcriptChanged, type TranscriptStat } from "./transcript.ts";
import { LastMessage, Turn } from "./turn.ts";

export type ModeInfo = { current: string; available: Array<{ id: string; name: string }> };

export type PendingInteraction =
  | { kind: "permission"; request_id: string; session: SessionRef; targets: Target[]; params: acp.RequestPermissionRequest; resolve: (r: acp.RequestPermissionResponse) => void; timer: NodeJS.Timeout }
  | { kind: "elicitation"; request_id: string; session: SessionRef; targets: Target[]; params: acp.CreateElicitationRequest; resolve: (r: acp.CreateElicitationResponse) => void };

export type ResolvedBy = "user" | "timeout" | "cancelled";

/** Router side: where to send what the sessions produce. */
export interface SessionEvents {
  /** Conversations currently bound to the session (all gateways). */
  boundTargets(ref: SessionRef): Target[];
  turnStarted(turn: Turn): void;
  update(ref: SessionRef, turn: Turn | undefined, update: acp.SessionUpdate): void;
  turnEnded(turn: Turn, durationMs: number): void;
  turnError(turn: Turn, message: string): void;
  interactionRequested(p: PendingInteraction): void;
  interactionResolved(p: PendingInteraction, by: ResolvedBy, outcome?: acp.RequestPermissionOutcome): void;
  stateChanged(ref: SessionRef): void;
  /** A session that never ran died with its agent process and cannot be loaded: unbind it. */
  sessionLost(ref: SessionRef): void;
}

type SessionRec = {
  key: string;
  ref: SessionRef;
  open: boolean;
  openedGen: number;
  opening: Promise<void> | undefined;
  /** session/close in flight: a load of the same id waits for it. */
  closing: Promise<void> | undefined;
  suppress: boolean;
  last: LastMessage;
  lastAssistantText: string | undefined;
  title: string | null | undefined;
  modes: ModeInfo | undefined;
  desiredMode: string | undefined;
  lastUsedAt: number;
  lastActivityAt: number;
  transcriptSeen: TranscriptStat | undefined;
  turn: Turn | undefined;
  draining: boolean;
  queue: QueuedPrompt[];
  foreign: { since: number } | undefined;
  bgTasks: Set<string>;
  neverRan: boolean;
};

export const FOREIGN_IDLE_MS = 15 * 60_000;
export const ACTIVE_ELSEWHERE_MS = 60_000;

export type SessionInfoView = {
  ref: SessionRef;
  title: string | null | undefined;
  modes: ModeInfo | undefined;
  busy: boolean;
  queue_length: number;
  foreign: boolean;
  open: boolean;
};

const key = (agent_id: string, session_id: string) => `${agent_id}\u0000${session_id}`;
const TERMINAL_TASK_STATES = new Set(["completed", "failed", "stopped", "killed", "cancelled"]);

/**
 * ACP sessions across agent processes: open/load with replay suppression (R4), per-session FIFO
 * queue with merging, turns pinned to their conversations, permission/elicitation fan-out, the
 * R12 lifecycle policy, R13 transcript checks and Flow 9 foreign-busy sessions.
 */
export class SessionManager {
  #recs = new Map<string, SessionRec>();
  #pending = new Map<string, PendingInteraction>();
  #cfg: Config;
  #pool: AgentPool;
  #events: SessionEvents;
  #log: Logger;
  #now: () => number;

  constructor(cfg: Config, pool: AgentPool, events: SessionEvents, log: Logger, now = Date.now) {
    this.#cfg = cfg;
    this.#pool = pool;
    this.#events = events;
    this.#log = log.child("sessions");
    this.#now = now;
  }

  // ---- queries ----

  info(ref: SessionRef): SessionInfoView {
    const rec = this.#recs.get(key(ref.agent_id, ref.session_id));
    return {
      ref,
      title: rec?.title,
      modes: rec?.modes,
      busy: rec ? this.#busy(rec) : false,
      queue_length: rec?.queue.length ?? 0,
      foreign: rec?.foreign !== undefined,
      open: rec ? this.#isOpen(rec) : false,
    };
  }

  /** The session has a turn running in this connector. */
  isRunning(agent_id: string, session_id: string): boolean {
    return this.#recs.get(key(agent_id, session_id))?.turn !== undefined;
  }

  runningTurns(): Turn[] {
    return [...this.#recs.values()].flatMap((r) => (r.turn ? [r.turn] : []));
  }

  pendingInteractions(): PendingInteraction[] {
    return [...this.#pending.values()];
  }

  summary(): Array<{ session: SessionRef; open: boolean; running: boolean; queue_length: number; foreign: boolean }> {
    return [...this.#recs.values()].map((r) => ({ session: r.ref, open: this.#isOpen(r), running: r.turn !== undefined, queue_length: r.queue.length, foreign: r.foreign !== undefined }));
  }

  // ---- commands ----

  async newSession(agent_id: string, cwd: string): Promise<SessionRef> {
    const agent = this.#pool.agent(agent_id);
    const live = await agent.get();
    await this.#evictFor(agent_id);
    const res = await live.conn.newSession({ cwd, mcpServers: [] });
    const ref = { agent_id, session_id: res.sessionId, cwd };
    const rec = this.#rec(ref);
    rec.open = true;
    rec.openedGen = live.generation;
    rec.neverRan = true;
    rec.modes = toModes(res.modes);
    this.#log.info("session created", ref);
    return ref;
  }

  /** Queue a prompt; returns its queue position (0 = starts now). */
  enqueue(ref: SessionRef, item: QueuedPrompt): number {
    if (!this.#pool.has(ref.agent_id)) throw new ProtocolError("agent_unavailable", `unknown agent ${ref.agent_id}`);
    const rec = this.#rec(ref);
    rec.queue.push(item);
    rec.lastUsedAt = this.#now();
    const startsNow = !rec.turn && !rec.draining && !rec.foreign && rec.queue.length === 1;
    setImmediate(() => void this.#drain(rec));
    return startsNow ? 0 : rec.queue.length;
  }

  /** session.attach: preview of the last agent message (R4) and the active_elsewhere warning. */
  async attach(ref: SessionRef): Promise<{ title?: string | null; last_assistant_text?: string; warning?: "active_elsewhere" }> {
    if (!this.#pool.has(ref.agent_id)) throw new ProtocolError("agent_unavailable", `unknown agent ${ref.agent_id}`);
    const rec = this.#rec(ref);
    rec.lastUsedAt = this.#now();
    let warning: "active_elsewhere" | undefined;
    if (!rec.turn) {
      const st = await statTranscript(this.#transcriptPath(rec.ref));
      if (st && this.#now() - st.mtimeMs < ACTIVE_ELSEWHERE_MS && (!rec.transcriptSeen || transcriptChanged(rec.transcriptSeen, st))) warning = "active_elsewhere";
    }
    // R4: a session not open in the agent process is loaded (replay suppressed) for a fresh preview;
    // an open one is not reopened and the preview comes from what we observed.
    if (!this.#isOpen(rec) && !rec.turn) {
      await this.#open(rec);
      this.#applyLifecycle(rec, { kind: "attached" });
    }
    const out: { title?: string | null; last_assistant_text?: string; warning?: "active_elsewhere" } = {};
    if (rec.title !== undefined) out.title = rec.title;
    if (rec.lastAssistantText !== undefined) out.last_assistant_text = rec.lastAssistantText;
    if (warning) out.warning = warning;
    return out;
  }

  async list(agent_id: string, cwd: string, cursor: string | undefined, limit: number): Promise<{ items: Array<{ session: SessionRef; title?: string | null; updated_at?: string | null; busy: "idle" | "running" | "foreign" }>; next_cursor?: string }> {
    const agent = this.#pool.agent(agent_id);
    const live = await agent.get();
    if (!live.caps.listSessions) return { items: [] };
    const c = decodeCursor(cursor);
    const res = await live.conn.listSessions({ cwd, ...(c.acp ? { cursor: c.acp } : {}) });
    const all = res.sessions;
    const page = all.slice(c.offset, c.offset + limit);
    const items = page.map((s) => {
      const ref = { agent_id, session_id: s.sessionId, cwd: s.cwd };
      const rec = this.#recs.get(key(agent_id, s.sessionId));
      if (rec && s.title) rec.title = s.title;
      const busy: "idle" | "running" | "foreign" = rec?.foreign ? "foreign" : rec && (rec.turn || rec.queue.length) ? "running" : "idle";
      return { session: ref, title: s.title ?? null, updated_at: s.updatedAt ?? null, busy };
    });
    let next: string | undefined;
    if (c.offset + limit < all.length) next = encodeCursor({ acp: c.acp, offset: c.offset + limit });
    else if (res.nextCursor) next = encodeCursor({ acp: res.nextCursor, offset: 0 });
    return next ? { items, next_cursor: next } : { items };
  }

  /** /stop: cancel the running turn, answer pending interactions with cancelled, drop the queue. */
  async cancel(ref: SessionRef): Promise<boolean> {
    const rec = this.#recs.get(key(ref.agent_id, ref.session_id));
    if (!rec) return false;
    const hadQueue = rec.queue.length > 0;
    rec.queue = [];
    if (!rec.turn) {
      if (hadQueue) this.#events.stateChanged(rec.ref);
      return hadQueue;
    }
    for (const p of [...this.#pending.values()]) {
      if (p.session.agent_id === ref.agent_id && p.session.session_id === ref.session_id) this.#resolveCancelled(p);
    }
    rec.turn.cancelRequested = true;
    const agent = this.#pool.agent(ref.agent_id);
    if (agent.running && this.#isOpen(rec)) {
      const live = await agent.get();
      await live.conn.cancel({ sessionId: ref.session_id });
    }
    this.#events.stateChanged(rec.ref);
    return true;
  }

  async setMode(ref: SessionRef, modeId: string): Promise<string> {
    const rec = this.#rec(ref);
    if (rec.modes && !rec.modes.available.some((m) => m.id === modeId)) throw new ProtocolError("invalid_message", `unknown mode ${modeId}`);
    rec.desiredMode = modeId;
    // not open: modes may still be unknown; the mode is applied (or dropped) after the next load
    if (this.#isOpen(rec)) await this.#applyMode(rec);
    else if (rec.modes) rec.modes = { ...rec.modes, current: modeId };
    this.#events.stateChanged(rec.ref);
    return modeId;
  }

  /** No channel can show the request (every gateway rejected it for good): cancel it like /stop does. */
  cancelInteraction(request_id: string): boolean {
    const p = this.#pending.get(request_id);
    if (!p) return false;
    this.#log.warn("no channel can show this request, cancelling it", { request_id, kind: p.kind });
    this.#resolveCancelled(p);
    return true;
  }

  respondPermission(request_id: string, outcome: acp.RequestPermissionOutcome): boolean {
    const p = this.#pending.get(request_id);
    if (!p || p.kind !== "permission") return false;
    this.#settle(p, "user", { outcome });
    return true;
  }

  respondElicitation(request_id: string, action: "accept" | "decline" | "cancel", content?: Record<string, unknown>): boolean {
    const p = this.#pending.get(request_id);
    if (!p || p.kind !== "elicitation") return false;
    const res = (action === "accept" ? { action, content: (content ?? {}) as Record<string, string> } : { action }) as acp.CreateElicitationResponse;
    this.#settle(p, "user", res);
    return true;
  }

  /** Flow 9: the session runs outside the connector (claude -p, cloudcli); hold prompts until it ends. */
  markForeign(ref: SessionRef): void {
    const rec = this.#rec(ref);
    if (rec.turn) return;
    rec.foreign = { since: this.#now() };
    this.#log.info("session marked foreign", ref);
  }

  /** SessionEnd hook (or opencode session.idle) for a session id. */
  sessionEnded(session_id: string): boolean {
    let hit = false;
    for (const rec of this.#recs.values()) {
      if (rec.ref.session_id !== session_id || !rec.foreign) continue;
      rec.foreign = undefined;
      hit = true;
      this.#log.info("foreign session ended", rec.ref);
      this.#events.stateChanged(rec.ref);
      void this.#drain(rec);
    }
    return hit;
  }

  /** Periodic: lifecycle closes (R12) and foreign expiry (15 min without transcript changes). */
  async tick(): Promise<void> {
    const now = this.#now();
    for (const rec of this.#recs.values()) {
      if (rec.foreign) {
        const st = await statTranscript(this.#transcriptPath(rec.ref));
        const lastChange = Math.max(rec.foreign.since, st?.mtimeMs ?? 0);
        if (now - lastChange >= FOREIGN_IDLE_MS) {
          rec.foreign = undefined;
          this.#log.info("foreign session idle for 15 min, releasing", rec.ref);
          this.#events.stateChanged(rec.ref);
          void this.#drain(rec);
        }
      }
      this.#applyLifecycle(rec, { kind: "tick", now });
    }
    this.#prune(now);
  }

  /** Forget records of closed sessions nobody used for idle_close_minutes (they are re-created on demand). */
  #prune(now: number): void {
    const idleMs = this.#cfg.session_lifecycle.idle_close_minutes * 60_000;
    for (const [k, rec] of this.#recs) {
      if (this.#isOpen(rec) || this.#busy(rec) || rec.closing || rec.foreign || this.#view(rec).pending > 0) continue;
      if (now - Math.max(rec.lastUsedAt, rec.lastActivityAt) < idleMs) continue;
      this.#recs.delete(k);
    }
  }

  // ---- ACP client callbacks ----

  onSessionUpdate(agent_id: string, n: acp.SessionNotification): void {
    const rec = this.#recs.get(key(agent_id, n.sessionId));
    if (!rec) return;
    const u = n.update;
    rec.last.apply(u);
    if (rec.suppress) return; // R4: load replay never reaches gateways
    if (rec.last.text !== undefined) rec.lastAssistantText = rec.last.text;
    rec.lastActivityAt = this.#now();
    let stateChanged = false;
    switch (u.sessionUpdate) {
      case "current_mode_update":
        if (rec.modes) rec.modes = { ...rec.modes, current: u.currentModeId };
        stateChanged = true;
        break;
      case "session_info_update":
        if (typeof u.title === "string") {
          rec.title = u.title;
          stateChanged = true;
        }
        break;
      default: {
        const kind = (u as { sessionUpdate: string }).sessionUpdate;
        const taskId = (u as { asyncTaskId?: unknown }).asyncTaskId;
        if (kind === "async_task_spawned" && typeof taskId === "string") rec.bgTasks.add(taskId);
        if (kind === "async_task_state_update" && typeof taskId === "string" && TERMINAL_TASK_STATES.has(String((u as { state?: unknown }).state))) rec.bgTasks.delete(taskId);
        // claude-agent-acp reports task lifecycles only to AIR clients; a tool call started with
        // run_in_background (Claude Bash) still means work that session/close would kill. Its end is
        // unknown to us, so it holds the session until busy_hold_minutes of inactivity.
        const call = u as { toolCallId?: unknown; rawInput?: { run_in_background?: unknown } };
        if ((kind === "tool_call" || kind === "tool_call_update") && call.rawInput?.run_in_background === true && typeof call.toolCallId === "string") {
          rec.bgTasks.add(`detached:${call.toolCallId}`);
        }
      }
    }
    rec.turn?.apply(u);
    // Out of a turn the command list is noise (it follows every session/load).
    if (!rec.turn && u.sessionUpdate === "available_commands_update") return;
    this.#events.update(rec.ref, rec.turn, u);
    if (stateChanged) this.#events.stateChanged(rec.ref);
  }

  onRequestPermission(agent_id: string, params: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse> {
    const rec = this.#recs.get(key(agent_id, params.sessionId));
    if (!rec) return Promise.resolve({ outcome: { outcome: "cancelled" } });
    const targets = rec.turn?.targets ?? this.#events.boundTargets(rec.ref);
    return new Promise((resolve) => {
      const request_id = uuidv7();
      const timer = setTimeout(() => this.#timeoutPermission(request_id), this.#cfg.permission_timeout_s * 1000);
      timer.unref();
      const p: PendingInteraction = { kind: "permission", request_id, session: rec.ref, targets, params, resolve, timer };
      this.#pending.set(request_id, p);
      this.#events.interactionRequested(p);
    });
  }

  onCreateElicitation(agent_id: string, params: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse> {
    const sessionId = (params as { sessionId?: string }).sessionId;
    const rec = sessionId ? this.#recs.get(key(agent_id, sessionId)) : undefined;
    if (!rec || params.mode !== "form") return Promise.resolve({ action: "decline" } as acp.CreateElicitationResponse);
    const targets = rec.turn?.targets ?? this.#events.boundTargets(rec.ref);
    return new Promise((resolve) => {
      // R20: questions have no timeout; /stop cancels them.
      const p: PendingInteraction = { kind: "elicitation", request_id: uuidv7(), session: rec.ref, targets, params, resolve };
      this.#pending.set(p.request_id, p);
      this.#events.interactionRequested(p);
    });
  }

  onAgentExited(agent_id: string, reason: string): void {
    for (const p of [...this.#pending.values()]) if (p.session.agent_id === agent_id) this.#resolveCancelled(p);
    for (const rec of this.#recs.values()) {
      if (rec.ref.agent_id !== agent_id) continue;
      rec.open = false;
      rec.suppress = false;
      rec.bgTasks.clear();
      if (rec.neverRan && !rec.turn && rec.queue.length === 0) {
        // never prompted → no transcript → session/load would fail; the next prompt starts a new session
        rec.neverRan = false;
        this.#events.sessionLost(rec.ref);
      }
      if (rec.turn && !rec.turn.failed) {
        rec.turn.failed = true;
        this.#events.turnError(rec.turn, `agent ${agent_id} ${reason}`);
      }
    }
  }

  // ---- internals ----

  #rec(ref: SessionRef): SessionRec {
    const k = key(ref.agent_id, ref.session_id);
    let rec = this.#recs.get(k);
    if (!rec) {
      const now = this.#now();
      rec = {
        key: k, ref: { ...ref }, open: false, openedGen: -1, opening: undefined, closing: undefined, suppress: false, last: new LastMessage(),
        lastAssistantText: undefined, title: undefined, modes: undefined, desiredMode: undefined, lastUsedAt: now, lastActivityAt: now,
        transcriptSeen: undefined, turn: undefined, draining: false, queue: [], foreign: undefined, bgTasks: new Set(), neverRan: false,
      };
      this.#recs.set(k, rec);
    } else if (ref.cwd && rec.ref.cwd !== ref.cwd && !this.#isOpen(rec)) {
      rec.ref = { ...rec.ref, cwd: ref.cwd };
    }
    return rec;
  }

  #isOpen(rec: SessionRec): boolean {
    return rec.open && rec.openedGen === (this.#pool.agents.get(rec.ref.agent_id)?.generation ?? -2);
  }

  #busy(rec: SessionRec): boolean {
    return rec.turn !== undefined || rec.queue.length > 0 || rec.opening !== undefined || rec.draining;
  }

  #view(rec: SessionRec): SessionView {
    let pending = 0;
    for (const p of this.#pending.values()) if (p.session.agent_id === rec.ref.agent_id && p.session.session_id === rec.ref.session_id) pending++;
    return {
      open: this.#isOpen(rec), busy: this.#busy(rec), pending, backgroundTasks: rec.bgTasks.size,
      neverRan: rec.neverRan, lastUsedAt: rec.lastUsedAt, lastActivityAt: rec.lastActivityAt,
    };
  }

  #transcriptPath(ref: SessionRef): string | undefined {
    const a = this.#pool.agents.get(ref.agent_id);
    if (a?.cfg.kind !== "claude") return undefined;
    const dir = a.cfg.env.CLAUDE_CONFIG_DIR ?? process.env.CLAUDE_CONFIG_DIR;
    return claudeTranscriptPath(ref.session_id, ref.cwd, dir ?? undefined);
  }

  #applyLifecycle(rec: SessionRec, e: LifecycleEvent): void {
    if (shouldClose(this.#view(rec), e, this.#cfg.session_lifecycle)) void this.#close(rec);
  }

  /** session/close. `force` is for #open itself (reload after an external change): it runs while busy. */
  async #close(rec: SessionRec, force = false): Promise<void> {
    if (rec.closing) return rec.closing;
    if (!this.#isOpen(rec)) return;
    const agent = this.#pool.agent(rec.ref.agent_id);
    const live = await agent.get();
    if (!live.caps.closeSession) return;
    // the policy decided before the await: a prompt or attach may have started meanwhile
    if (rec.closing || !this.#isOpen(rec)) return rec.closing;
    if (!force && this.#busy(rec)) return;
    rec.open = false;
    rec.bgTasks.clear();
    const lost = rec.neverRan;
    const closing = (async () => {
      try {
        await live.conn.closeSession({ sessionId: rec.ref.session_id });
        this.#log.debug("session closed", rec.ref);
      } catch (err) {
        this.#log.warn("session/close failed", { ref: rec.ref, err });
      }
    })();
    rec.closing = closing;
    try {
      await closing;
    } finally {
      rec.closing = undefined;
    }
    if (lost && rec.neverRan) {
      // never prompted → no transcript → it cannot be loaded back; the next prompt starts a new session
      rec.neverRan = false;
      this.#events.sessionLost(rec.ref);
    }
  }

  async #evictFor(agent_id: string): Promise<void> {
    const sessions = [...this.#recs.values()].filter((r) => r.ref.agent_id === agent_id).map((r) => ({ key: r, view: this.#view(r) }));
    for (const r of pickEvictions(sessions, this.#cfg.session_lifecycle)) await this.#close(r);
  }

  /** Make sure the session is open in its agent process: session/load with replay suppression (R4). */
  async #open(rec: SessionRec): Promise<void> {
    // one opener at a time, and never while session/close of the same id is in flight
    while (rec.opening || rec.closing) await (rec.opening ?? rec.closing)!.catch(() => {});
    let done!: () => void;
    const opening = new Promise<void>((r) => (done = r));
    rec.opening = opening; // set before any await: a concurrent #open waits instead of loading again
    try {
      await this.#openNow(rec);
    } finally {
      rec.opening = undefined;
      done();
    }
  }

  async #openNow(rec: SessionRec): Promise<void> {
    const agent = this.#pool.agent(rec.ref.agent_id);
    const live = await agent.get();
    if (this.#isOpen(rec)) {
      if (this.#cfg.session_lifecycle.mode !== "lru") return;
      // R13: someone else (cloudcli, terminal) wrote to the session since we last saw it.
      const st = await statTranscript(this.#transcriptPath(rec.ref));
      if (!transcriptChanged(rec.transcriptSeen, st)) return;
      this.#log.info("transcript changed outside the connector, reloading", rec.ref);
      await this.#close(rec, true);
    }
    if (!live.caps.loadSession) throw new ProtocolError("agent_unavailable", `agent ${rec.ref.agent_id} cannot load sessions`);
    await this.#evictFor(rec.ref.agent_id);
    rec.suppress = true;
    rec.last = new LastMessage();
    try {
      const res = await live.conn.loadSession({ sessionId: rec.ref.session_id, cwd: rec.ref.cwd, mcpServers: [] });
      rec.open = true;
      rec.openedGen = live.generation;
      rec.modes = toModes(res?.modes) ?? rec.modes;
    } catch (err) {
      throw new ProtocolError("unknown_session", `cannot load session ${rec.ref.session_id}: ${(err as Error).message}`);
    } finally {
      rec.suppress = false;
    }
    if (rec.last.text !== undefined) rec.lastAssistantText = rec.last.text;
    rec.transcriptSeen = await statTranscript(this.#transcriptPath(rec.ref));
    if (rec.desiredMode && rec.modes?.current !== rec.desiredMode) {
      // a mode chosen before the modes were known must not fail the turn: keep the agent's mode
      try {
        if (rec.modes && !rec.modes.available.some((m) => m.id === rec.desiredMode)) throw new Error("not offered by the agent");
        await this.#applyMode(rec);
      } catch (err) {
        this.#log.warn("cannot apply the chosen mode, keeping the agent's", { ref: rec.ref, mode: rec.desiredMode, err: (err as Error).message });
        rec.desiredMode = undefined;
        this.#events.stateChanged(rec.ref);
      }
    }
  }

  async #applyMode(rec: SessionRec): Promise<void> {
    if (!rec.desiredMode) return;
    const live = await this.#pool.agent(rec.ref.agent_id).get();
    await live.conn.setSessionMode({ sessionId: rec.ref.session_id, modeId: rec.desiredMode });
    if (rec.modes) rec.modes = { ...rec.modes, current: rec.desiredMode };
  }

  async #drain(rec: SessionRec): Promise<void> {
    if (rec.turn || rec.draining || rec.foreign || rec.queue.length === 0) return;
    rec.draining = true;
    const items = rec.queue.splice(0);
    const merged = mergePrompts(items);
    const targets = unionTargets(this.#events.boundTargets(rec.ref), merged.from);
    const turn = new Turn(uuidv7(), rec.ref, targets, merged.origin, this.#now());
    rec.turn = turn;
    rec.last.boundary();
    rec.lastUsedAt = rec.lastActivityAt = this.#now();
    this.#events.turnStarted(turn);
    this.#events.stateChanged(rec.ref);
    let ended = false;
    let live: Awaited<ReturnType<ReturnType<AgentPool["agent"]>["get"]>> | undefined;
    try {
      await this.#open(rec);
      live = await this.#pool.agent(rec.ref.agent_id).get();
      const prompt = await buildPromptBlocks(merged, { images: live.caps.images, readFile: (p) => readFile(p) });
      if (turn.cancelRequested) {
        turn.stopReason = "cancelled";
      } else {
        rec.neverRan = false;
        const res = await live.conn.prompt({ sessionId: rec.ref.session_id, prompt });
        turn.stopReason = res.stopReason;
      }
      ended = true;
    } catch (err) {
      if (!turn.failed) {
        turn.failed = true;
        const crashed = live?.conn.signal.aborted === true;
        const msg =
          err instanceof AgentUnavailable || err instanceof ProtocolError
            ? err.message
            : crashed
              ? `agent ${rec.ref.agent_id} exited during the turn`
              : `prompt failed: ${(err as Error).message ?? String(err)}`;
        this.#log.warn("turn failed", { ref: rec.ref, err: msg });
        this.#events.turnError(turn, msg);
      }
    }
    rec.turn = undefined;
    rec.draining = false;
    rec.lastUsedAt = rec.lastActivityAt = this.#now();
    if (ended) {
      rec.transcriptSeen = await statTranscript(this.#transcriptPath(rec.ref));
      this.#events.turnEnded(turn, this.#now() - turn.startedAt);
    }
    this.#events.stateChanged(rec.ref);
    if (rec.queue.length > 0) {
      void this.#drain(rec);
      return;
    }
    if (ended) this.#applyLifecycle(rec, { kind: "turn_ended" });
  }

  #timeoutPermission(request_id: string): void {
    const p = this.#pending.get(request_id);
    if (!p || p.kind !== "permission") return;
    const reject = p.params.options.find((o) => o.kind === "reject_once");
    const outcome: acp.RequestPermissionOutcome = reject ? { outcome: "selected", optionId: reject.optionId } : { outcome: "cancelled" };
    this.#log.info("permission timed out", { request_id });
    this.#settle(p, "timeout", { outcome });
  }

  #resolveCancelled(p: PendingInteraction): void {
    if (p.kind === "permission") this.#settle(p, "cancelled", { outcome: { outcome: "cancelled" } });
    else this.#settle(p, "cancelled", { action: "cancel" } as acp.CreateElicitationResponse);
  }

  #settle(p: PendingInteraction, by: ResolvedBy, res: acp.RequestPermissionResponse | acp.CreateElicitationResponse): void {
    if (!this.#pending.delete(p.request_id)) return;
    if (p.kind === "permission") {
      clearTimeout(p.timer);
      const r = res as acp.RequestPermissionResponse;
      p.resolve(r);
      this.#events.interactionResolved(p, by, r.outcome);
    } else {
      p.resolve(res as acp.CreateElicitationResponse);
      this.#events.interactionResolved(p, by);
    }
  }

  async shutdown(): Promise<void> {
    for (const p of [...this.#pending.values()]) this.#resolveCancelled(p);
  }
}

function toModes(m: acp.SessionModeState | null | undefined): ModeInfo | undefined {
  if (!m) return undefined;
  return { current: m.currentModeId, available: m.availableModes.map((x) => ({ id: x.id, name: x.name })) };
}

export function unionTargets(...lists: Target[][]): Target[] {
  const out: Target[] = [];
  for (const t of lists.flat()) if (!out.some((o) => o.gateway === t.gateway && o.conversation_id === t.conversation_id)) out.push(t);
  return out;
}

type Cursor = { acp?: string | undefined; offset: number };

function encodeCursor(c: Cursor): string {
  return Buffer.from(JSON.stringify(c)).toString("base64url");
}

function decodeCursor(s: string | undefined): Cursor {
  if (!s) return { offset: 0 };
  try {
    const c = JSON.parse(Buffer.from(s, "base64url").toString("utf8")) as Cursor;
    return { acp: typeof c.acp === "string" ? c.acp : undefined, offset: Number.isInteger(c.offset) && c.offset >= 0 ? c.offset : 0 };
  } catch {
    throw new ProtocolError("invalid_message", "bad cursor");
  }
}
