import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Readable, Writable } from "node:stream";
import { createInterface } from "node:readline";
import * as acp from "@agentclientprotocol/sdk";
import { BUNDLED_CLAUDE_ACP, type AgentConfig } from "../daemon/config.ts";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "../daemon/backoff.ts";
import type { Logger } from "../log.ts";
import { CONNECTOR_VERSION } from "../version.ts";

export type AgentCaps = { loadSession: boolean; listSessions: boolean; closeSession: boolean; images: boolean };

/** Callbacks from agent processes (ACP client side). */
export interface AgentClientHandlers {
  sessionUpdate(agent_id: string, n: acp.SessionNotification): void;
  requestPermission(agent_id: string, p: acp.RequestPermissionRequest): Promise<acp.RequestPermissionResponse>;
  createElicitation(agent_id: string, p: acp.CreateElicitationRequest): Promise<acp.CreateElicitationResponse>;
  agentExited(agent_id: string, generation: number, reason: string): void;
}

export class AgentUnavailable extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentUnavailable";
  }
}

export function resolveCommand(cfg: AgentConfig): { command: string; args: string[] } {
  if (cfg.command === BUNDLED_CLAUDE_ACP) {
    // A global tgz install does not put the adapter's bin on PATH: run the pinned dependency directly.
    const entry = fileURLToPath(import.meta.resolve("@agentclientprotocol/claude-agent-acp/dist/index.js"));
    return { command: process.execPath, args: [entry, ...cfg.args] };
  }
  return { command: cfg.command, args: cfg.args };
}

type Live = { conn: acp.ClientSideConnection; child: ChildProcess; caps: AgentCaps; generation: number };

const START_TIMEOUT_MS = 60_000;
const STABLE_MS = 60_000;

/** One ACP agent process (claude-agent-acp, `opencode acp`, ...) serving many sessions. */
export class AgentProcess {
  readonly id: string;
  readonly cfg: AgentConfig;
  #cwd: string;
  #handlers: AgentClientHandlers;
  #log: Logger;
  #backoff: BackoffOptions;
  #live: Live | undefined;
  #starting: Promise<Live> | undefined;
  #generation = 0;
  #attempt = 0;
  #nextStartAt = 0;
  #restartTimer: NodeJS.Timeout | undefined;
  #stableTimer: NodeJS.Timeout | undefined;
  #stopped = false;
  #missing = false;
  lastCaps: AgentCaps = { loadSession: false, listSessions: false, closeSession: false, images: false };
  lastError: string | undefined;
  #stderrTail: string[] = [];

  constructor(id: string, cfg: AgentConfig, cwd: string, handlers: AgentClientHandlers, log: Logger, backoff = DEFAULT_BACKOFF) {
    this.id = id;
    this.cfg = cfg;
    this.#cwd = cwd;
    this.#handlers = handlers;
    this.#log = log.child(id);
    this.#backoff = backoff;
  }

  get running(): boolean {
    return this.#live !== undefined;
  }

  get pid(): number | undefined {
    return this.#live?.child.pid;
  }

  get generation(): number {
    return this.#live?.generation ?? -1;
  }

  /** Running connection; starts (or waits for the restart backoff) when needed. */
  async get(): Promise<Live> {
    if (this.#live) return this.#live;
    if (this.#stopped) throw new AgentUnavailable(`agent ${this.id} is stopped`);
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => {
        this.#starting = undefined;
      });
    }
    return this.#starting;
  }

  async #start(): Promise<Live> {
    const wait = this.#nextStartAt - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const generation = ++this.#generation;
    const { command, args } = resolveCommand(this.cfg);
    this.#log.info("starting agent", { command, args });
    const env = { ...process.env, ...this.cfg.env };
    // A daemon started from inside a Claude Code shell must not leak that session's id to agents
    // (their MCP servers would report the wrong caller).
    delete env.CLAUDE_CODE_SESSION_ID;
    const child = spawn(command, args, { cwd: this.#cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    const spawned = new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    try {
      await spawned;
    } catch (err) {
      this.#missing = (err as NodeJS.ErrnoException).code === "ENOENT";
      this.lastError = (err as Error).message;
      this.#nextStartAt = Date.now() + backoffDelay(this.#attempt++, this.#backoff);
      throw new AgentUnavailable(`cannot start agent ${this.id}: ${(err as Error).message}`);
    }
    this.#missing = false;
    child.stdin!.on("error", (err) => this.#log.debug("agent stdin error", err.message)); // EPIPE after a crash
    const rl = createInterface({ input: child.stderr! });
    rl.on("error", () => {});
    rl.on("line", (line) => {
      this.#stderrTail.push(line);
      if (this.#stderrTail.length > 20) this.#stderrTail.shift();
      this.#log.debug("stderr", line);
    });
    const stream = acp.ndJsonStream(Writable.toWeb(child.stdin!) as WritableStream<Uint8Array>, Readable.toWeb(child.stdout!) as ReadableStream<Uint8Array>);
    const h = this.#handlers;
    const id = this.id;
    const conn = new acp.ClientSideConnection(
      () => ({
        sessionUpdate: async (n) => h.sessionUpdate(id, n),
        requestPermission: (p) => h.requestPermission(id, p),
        createElicitation: (p) => h.createElicitation(id, p),
      }),
      stream,
    );
    child.once("exit", (code, signal) => this.#onExit(generation, `exited (code ${code}, signal ${signal})`));
    try {
      const init = await withTimeout(
        conn.initialize({
          protocolVersion: acp.PROTOCOL_VERSION,
          // fs/terminal are not declared: the agent works with the disk itself.
          clientCapabilities: { elicitation: { form: {} } },
          clientInfo: { name: "agent-connector", version: CONNECTOR_VERSION },
        }),
        START_TIMEOUT_MS,
        "initialize timed out",
      );
      const ac = init.agentCapabilities ?? {};
      const sc = (ac.sessionCapabilities ?? {}) as Record<string, unknown>;
      const caps: AgentCaps = {
        loadSession: ac.loadSession === true,
        listSessions: sc.list != null,
        closeSession: sc.close != null,
        images: ac.promptCapabilities?.image === true,
      };
      this.lastCaps = caps;
      this.lastError = undefined;
      const live: Live = { conn, child, caps, generation };
      this.#live = live;
      this.#stableTimer = setTimeout(() => (this.#attempt = 0), STABLE_MS);
      this.#stableTimer.unref();
      this.#log.info("agent ready", { pid: child.pid, caps });
      return live;
    } catch (err) {
      this.lastError = (err as Error).message;
      child.kill("SIGKILL");
      this.#nextStartAt = Date.now() + backoffDelay(this.#attempt++, this.#backoff);
      throw new AgentUnavailable(`agent ${this.id} failed to initialize: ${(err as Error).message}`);
    }
  }

  #onExit(generation: number, reason: string): void {
    if (generation !== this.#generation) return;
    const wasLive = this.#live?.generation === generation;
    this.#live = undefined;
    clearTimeout(this.#stableTimer);
    if (this.#stopped) return;
    this.lastError = reason;
    this.#log.error(`agent ${reason}`, { stderr: this.#stderrTail.slice(-5) });
    this.#nextStartAt = Date.now() + backoffDelay(this.#attempt++, this.#backoff);
    if (wasLive) this.#handlers.agentExited(this.id, generation, reason);
    // Restart eagerly (fresh caps for hello, sessions can reload), unless the binary is missing.
    if (!this.#missing) {
      clearTimeout(this.#restartTimer);
      this.#restartTimer = setTimeout(() => this.get().catch((e) => this.#log.warn("restart failed", e)), Math.max(0, this.#nextStartAt - Date.now()));
      this.#restartTimer.unref();
    }
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#restartTimer);
    clearTimeout(this.#stableTimer);
    const live = this.#live;
    this.#live = undefined;
    if (!live) return;
    const exited = new Promise<void>((r) => live.child.once("exit", () => r()));
    live.child.kill("SIGTERM");
    const t = setTimeout(() => live.child.kill("SIGKILL"), 3000);
    await exited;
    clearTimeout(t);
  }
}

/** One process per agent_id. */
export class AgentPool {
  readonly agents = new Map<string, AgentProcess>();

  constructor(agents: Record<string, AgentConfig>, cwd: string, handlers: AgentClientHandlers, log: Logger, backoff?: BackoffOptions) {
    for (const [id, cfg] of Object.entries(agents)) this.agents.set(id, new AgentProcess(id, cfg, cwd, handlers, log.child("agent"), backoff));
  }

  has(agent_id: string): boolean {
    return this.agents.has(agent_id);
  }

  agent(agent_id: string): AgentProcess {
    const a = this.agents.get(agent_id);
    if (!a) throw new AgentUnavailable(`unknown agent ${agent_id}`);
    return a;
  }

  /** Start every agent once (for hello caps); failures are logged, not fatal. */
  async startAll(log: Logger): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.get().catch((e) => log.warn(`agent ${a.id} unavailable`, e))));
  }

  async stop(): Promise<void> {
    await Promise.all([...this.agents.values()].map((a) => a.stop()));
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(msg)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
