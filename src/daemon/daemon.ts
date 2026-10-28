import { mkdirSync } from "node:fs";
import { stat } from "node:fs/promises";
import { basename, extname, isAbsolute, join, resolve } from "node:path";
import { PROTOCOL_VERSION, ProtocolError, uuidv7, type PayloadOf } from "@brain-boost-academy/agent-protocol";
import { AgentPool } from "../acp/agent-pool.ts";
import { SessionManager } from "../acp/session-manager.ts";
import { resolveCaller } from "../control/caller.ts";
import { ControlError, ControlServer } from "../control/server.ts";
import { createLogger, type Logger } from "../log.ts";
import { Store, type OutboxFile, type SessionRef } from "../store/store.ts";
import { CONNECTOR_VERSION } from "../version.ts";
import type { BackoffOptions } from "./backoff.ts";
import type { Config } from "./config.ts";
import { GatewayLink, type LinkTimings } from "./gateway-link.ts";
import { Router, sameRef } from "./router.ts";
import { storeUpload } from "./uploads.ts";

export type DaemonOptions = {
  config: Config;
  stateDir: string;
  socketPath: string;
  configPath?: string;
  linkTimings?: Partial<LinkTimings>;
  agentBackoff?: BackoffOptions;
  /** Lifecycle/foreign tick (default 30 s). */
  tickMs?: number;
  /** How long send_message waits for `delivered` before answering "queued" (default 15 s). */
  deliveryWaitMs?: number;
  log?: Logger;
  /** Clock for session lifecycle/foreign expiry (tests). */
  now?: () => number;
};

/** What the agent tells the user with a pairing link; the lifetime comes from the gateway's expires_at. */
export function pairChannelInstructions(expires_at: string, now = Date.now()): string {
  const min = Math.max(1, Math.round((Date.parse(expires_at) - now) / 60_000));
  const lifetime = Number.isFinite(min) ? `${min} minute${min === 1 ? "" : "s"}` : "a few minutes";
  return `Show this link to the user who asked for it. It is one-time and expires in ${lifetime}. The user opens it and confirms in the channel.`;
}

/** send_message text cap (bytes): far above any chat message, far below the frame limit. */
export const MAX_NOTIFY_TEXT_BYTES = 64 * 1024;
/** Files per send_message: each is a blob the gateway holds until the notify arrives (it caps open blobs). */
export const MAX_NOTIFY_FILES = 10;

const MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
  ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown", ".csv": "text/csv", ".json": "application/json",
  ".html": "text/html", ".zip": "application/zip", ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".mp4": "video/mp4",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

export function mimeOf(path: string): string {
  return MIME[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type SendResult = { channel: string; ok: boolean; status: "delivered" | "queued" | "failed"; error?: string };

/** The connector daemon: wires store, agents, sessions, gateway links and the control socket. */
export class Daemon {
  readonly cfg: Config;
  readonly store: Store;
  readonly pool: AgentPool;
  readonly sessions: SessionManager;
  readonly router: Router;
  readonly control: ControlServer;
  #log: Logger;
  #opts: DaemonOptions;
  #tick: NodeJS.Timeout | undefined;
  #startedAt = Date.now();

  constructor(opts: DaemonOptions) {
    this.#opts = opts;
    this.cfg = opts.config;
    this.#log = opts.log ?? createLogger();
    mkdirSync(opts.stateDir, { recursive: true, mode: 0o700 });
    mkdirSync(this.cfg.cwd, { recursive: true }); // agents are spawned in it
    this.store = new Store(join(opts.stateDir, "state.db"));
    let sessions!: SessionManager;
    this.pool = new AgentPool(
      this.cfg.agents,
      this.cfg.cwd,
      {
        sessionUpdate: (a, n) => sessions.onSessionUpdate(a, n),
        requestPermission: (a, p) => sessions.onRequestPermission(a, p),
        createElicitation: (a, p) => sessions.onCreateElicitation(a, p),
        agentExited: (a, _g, reason) => sessions.onAgentExited(a, reason),
      },
      this.#log,
      opts.agentBackoff,
    );
    this.router = new Router(this.cfg, this.store, this.pool, this.#log);
    sessions = new SessionManager(this.cfg, this.pool, this.router, this.#log, opts.now);
    this.sessions = sessions;
    this.router.sessions = sessions;
    for (const g of this.cfg.gateways) {
      const link = new GatewayLink(
        g,
        this.store,
        {
          hello: () => this.hello(),
          sync: (l) => this.router.sync(l),
          message: (l, env) => void this.router.handle(l, env),
          durableRejected: (l, k) => this.router.durableRejected(l, k),
          storeUpload: (b) => storeUpload(b.path, this.cfg.uploads_dir, b.name),
        },
        this.#log,
        join(opts.stateDir, "blobs"),
        opts.linkTimings,
      );
      this.router.links.set(g.name, link);
    }
    this.control = new ControlServer(
      opts.socketPath,
      {
        send_message: (p) => this.sendMessage(p),
        pair_channel: (p) => this.pairChannel(p),
        list_channels: async () => this.listChannels(),
        unpair: (p) => this.unpair(p),
        status: async () => this.status(),
        session_end: async (p) => ({ released: typeof p.session_id === "string" && this.sessions.sessionEnded(p.session_id) }),
      },
      this.#log,
    );
  }

  hello(): PayloadOf<"hello"> {
    return {
      protocol: { min: PROTOCOL_VERSION, max: PROTOCOL_VERSION },
      acp_protocol: 1,
      connector_version: CONNECTOR_VERSION,
      agents: [...this.pool.agents.values()].map((a) => ({
        agent_id: a.id,
        title: a.cfg.title,
        default: a.id === this.cfg.default_agent,
        caps: { load_session: a.lastCaps.loadSession, list_sessions: a.lastCaps.listSessions, images: a.lastCaps.images },
      })),
    };
  }

  async start(): Promise<void> {
    await this.control.listen();
    await this.pool.startAll(this.#log);
    for (const l of this.router.links.values()) l.start();
    this.#tick = setInterval(() => void this.sessions.tick().catch((e) => this.#log.warn("tick failed", e)), this.#opts.tickMs ?? 30_000);
    this.#tick.unref();
    this.#log.info("daemon started", { version: CONNECTOR_VERSION, gateways: this.cfg.gateways.map((g) => g.name), agents: [...this.pool.agents.keys()] });
  }

  async stop(): Promise<void> {
    clearInterval(this.#tick);
    await this.control.close();
    await this.sessions.shutdown();
    await Promise.all([...this.router.links.values()].map((l) => l.stop()));
    await this.pool.stop();
    this.store.close();
  }

  #link(channel: unknown): GatewayLink {
    const name = typeof channel === "string" && channel ? channel : this.cfg.default_channel;
    if (!name) throw new ControlError("no_channel", "no gateways configured (add one to config.json)");
    const link = this.router.links.get(name);
    if (!link) throw new ControlError("unknown_channel", `unknown channel ${name}; configured: ${[...this.router.links.keys()].join(", ") || "none"}`);
    return link;
  }

  /** Hooks name the agent kind ("claude", "opencode"); map it to a configured agent id. */
  #agentIdFor(name: string): string {
    if (this.pool.has(name)) return name;
    for (const a of this.pool.agents.values()) if (a.cfg.kind === name) return a.id;
    return name;
  }

  // ---- control API ----

  async sendMessage(p: Record<string, unknown>): Promise<{ delivered: SendResult[] }> {
    const text = typeof p.text === "string" && p.text.trim() ? p.text : undefined;
    const fileArgs = Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === "string" && f.length > 0) : [];
    if (!text && fileArgs.length === 0) throw new ControlError("invalid_params", "send_message needs text or files");
    if (fileArgs.length > MAX_NOTIFY_FILES) {
      throw new ControlError("too_large", `${fileArgs.length} files: at most ${MAX_NOTIFY_FILES} files per message; send the rest in another message or as an archive`);
    }
    if (text && Buffer.byteLength(text, "utf8") > MAX_NOTIFY_TEXT_BYTES) {
      throw new ControlError("too_large", `text is ${Buffer.byteLength(text, "utf8")} bytes, at most ${MAX_NOTIFY_TEXT_BYTES} are sent; shorten it or attach it as a file`);
    }
    const caller = resolveCaller(p, { env_session_id: str(p.env_session_id), env_cwd: str(p.env_cwd) });
    const baseCwd = caller.cwd ?? this.cfg.cwd;

    const files: Array<OutboxFile & { size: number }> = [];
    for (const f of fileArgs) {
      const path = isAbsolute(f) ? f : resolve(baseCwd, f);
      let size: number;
      try {
        const st = await stat(path);
        if (!st.isFile()) throw new Error("not a regular file");
        size = st.size;
      } catch (err) {
        throw new ControlError("file_not_found", `${path}: ${(err as Error).message}`);
      }
      files.push({ path, name: basename(path), mime: mimeOf(path), size });
    }

    // Only a session of a configured agent can be continued from the channel (D8 switch, reply target).
    let callerRef: SessionRef | undefined;
    if (caller.source !== "none") {
      const agent_id = this.#agentIdFor(caller.agent_id);
      if (this.pool.has(agent_id)) callerRef = { agent_id, session_id: caller.session_id, cwd: caller.cwd ?? this.cfg.cwd };
      else this.#log.info("send_message caller runs an agent that is not configured; sending without switching", { agent: caller.agent_id });
    }
    const runningHere = callerRef ? this.sessions.isRunning(callerRef.agent_id, callerRef.session_id) : false;

    // Destinations: the caller's own conversations if the connector runs it, else the owner chat.
    let dests: Array<{ gateway: string; conversation_id: string | undefined }> = [];
    if (runningHere && callerRef) {
      dests = this.router.boundTargets(callerRef).filter((t) => !p.channel || t.gateway === p.channel);
    }
    if (dests.length === 0) {
      const link = this.#link(p.channel);
      dests = [{ gateway: link.name, conversation_id: link.pairing?.conversation_id }];
    }

    for (const d of dests) {
      const limit = this.router.links.get(d.gateway)!.limits.max_outbound_file_bytes;
      for (const f of files) {
        if (f.size > limit) throw new ControlError("too_large", `${f.path} is ${f.size} bytes, ${d.gateway} accepts at most ${limit} bytes`, { path: f.path, size: f.size, limit });
      }
    }

    const results: SendResult[] = [];
    const waits: Array<Promise<void>> = [];
    for (const d of dests) {
      const link = this.router.links.get(d.gateway)!;
      if (link.pairing && !link.pairing.paired) {
        results.push({ channel: d.gateway, ok: false, status: "failed", error: "not_paired: no user is paired with this channel yet; call pair_channel when the user asks to connect it" });
        continue;
      }
      let switched = false;
      if (callerRef && !runningHere && d.conversation_id) {
        // D8: the owner chat continues the calling session; it runs elsewhere until it ends (Flow 9).
        const t = { gateway: d.gateway, conversation_id: d.conversation_id };
        switched = !sameRef(this.router.binding(t).session, callerRef);
        this.sessions.markForeign(callerRef);
        if (switched) this.router.bind(t, callerRef);
        this.router.sendState(t);
      }
      const notify_id = uuidv7();
      const res: SendResult = { channel: d.gateway, ok: true, status: "queued" };
      results.push(res);
      const wait = link.waitDelivered(`notify:${notify_id}`, this.#opts.deliveryWaitMs ?? 15_000);
      link.enqueueNotify({
        notify_id,
        gateway: d.gateway,
        ...(d.conversation_id ? { conversation_id: d.conversation_id } : {}),
        ...(callerRef ? { session: callerRef } : {}),
        ...(text ? { text } : {}),
        switched,
        files: files.map(({ path, name, mime }) => ({ path, name, mime })),
        created_at: Date.now(),
      });
      waits.push(
        wait.then((r) => {
          if (!r) return;
          if (r.ok) res.status = "delivered";
          else Object.assign(res, { ok: false, status: "failed", error: `${r.error.code}: ${r.error.message}` });
        }),
      );
    }
    await Promise.all(waits);
    if (results.every((r) => r.error?.startsWith("not_paired"))) {
      throw new ControlError("not_paired", "No user is paired with this channel, so the message was not sent. Ask the user whether to connect it; if they ask, call pair_channel.");
    }
    return { delivered: results };
  }

  async pairChannel(p: Record<string, unknown>): Promise<{ channel: string; url: string; expires_at: string; instructions: string }> {
    const link = this.#link(p.channel);
    if (!link.online) throw new ControlError("offline", `gateway ${link.name} is not connected${link.lastError ? ` (${link.lastError})` : ""}`);
    try {
      const code = await link.request("pairing.request", {});
      return { channel: link.name, url: code.url, expires_at: code.expires_at, instructions: pairChannelInstructions(code.expires_at) };
    } catch (err) {
      throw asControlError(err);
    }
  }

  async unpair(p: Record<string, unknown>): Promise<{ channel: string; ok: boolean }> {
    const link = this.#link(p.channel);
    if (!link.online) throw new ControlError("offline", `gateway ${link.name} is not connected`);
    try {
      const r = await link.request("pairing.revoke", {});
      return { channel: link.name, ok: r.ok };
    } catch (err) {
      throw asControlError(err);
    }
  }

  listChannels(): Array<{ name: string; label: string; connected: boolean; paired: boolean; user_display?: string }> {
    return [...this.router.links.values()].map((l) => {
      const out: { name: string; label: string; connected: boolean; paired: boolean; user_display?: string } = {
        name: l.name, label: l.label, connected: l.online, paired: l.pairing?.paired ?? false,
      };
      if (l.pairing?.user_display) out.user_display = l.pairing.user_display;
      return out;
    });
  }

  status(): object {
    return {
      version: CONNECTOR_VERSION,
      pid: process.pid,
      uptime_s: Math.round((Date.now() - this.#startedAt) / 1000),
      config: this.#opts.configPath,
      cwd: this.cfg.cwd,
      uploads_dir: this.cfg.uploads_dir,
      session_lifecycle: this.cfg.session_lifecycle,
      gateways: [...this.router.links.values()].map((l) => ({
        name: l.name, url: l.url, connected: l.online, paired: l.pairing?.paired ?? null, user_display: l.pairing?.user_display,
        last_error: l.lastError, next_retry_at: l.nextRetryAt ? new Date(l.nextRetryAt).toISOString() : undefined,
        outbox: this.store.listOutbox(l.name).length,
      })),
      agents: [...this.pool.agents.values()].map((a) => ({ agent_id: a.id, running: a.running, pid: a.pid, caps: a.lastCaps, last_error: a.lastError })),
      sessions: this.sessions.summary(),
    };
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v ? v : undefined;
}

function asControlError(err: unknown): ControlError {
  if (err instanceof ProtocolError) return new ControlError(err.code, err.message, err.details);
  return new ControlError("internal", err instanceof Error ? err.message : String(err));
}
