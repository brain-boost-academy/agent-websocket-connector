import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import WebSocket from "ws";
import {
  BlobReceiver,
  CloseCode,
  decode,
  durableKey,
  errorEnvelope,
  makeEnvelope,
  Peer,
  PROTOCOL_VERSION,
  ProtocolError,
  sendFileBlob,
  type AnyEnvelope,
  type DurableType,
  type Envelope,
  type MessageType,
  type PayloadOf,
  type RequestType,
  type ResponseTypeOf,
} from "@brain-boost-academy/agent-protocol";
import type { Logger } from "../log.ts";
import type { OutboxEntry, Store } from "../store/store.ts";
import type { Upload } from "../acp/prompt.ts";
import { backoffDelay, DEFAULT_BACKOFF, type BackoffOptions } from "./backoff.ts";
import type { GatewayConfig } from "./config.ts";
import { fitEnvelope } from "./fit-frame.ts";

export type PairingInfo = PayloadOf<"welcome">["pairing"];
export type Limits = PayloadOf<"welcome">["limits"];

export interface LinkHandler {
  hello(): PayloadOf<"hello">;
  sync(link: GatewayLink): PayloadOf<"sync">;
  message(link: GatewayLink, env: AnyEnvelope): void;
  /** A non-notify durable was dropped for good (terminal error from the gateway, or it cannot fit a frame). */
  durableRejected(link: GatewayLink, key: string, err: ProtocolError): void;
  storeUpload(blob: { path: string; name: string; mime: string }): Promise<string>;
}

export type LinkTimings = {
  pingIntervalMs: number;
  /** After 4401 (or HTTP 401): do not retry more often than this. */
  unauthorizedRetryMs: number;
  backoff: BackoffOptions;
  /** A connection that lived this long resets the backoff. */
  stableMs: number;
  welcomeTimeoutMs: number;
  /** A durable without any answer after this long is resent while the link stays up. */
  ackTimeoutMs: number;
  /** Per-message resend backoff after `internal`/`timeout` (5 s → 5 min). */
  retryBackoff: BackoffOptions;
};

export const DEFAULT_TIMINGS: LinkTimings = {
  pingIntervalMs: 30_000,
  unauthorizedRetryMs: 5 * 60_000,
  backoff: DEFAULT_BACKOFF,
  stableMs: 60_000,
  welcomeTimeoutMs: 30_000,
  ackTimeoutMs: 60_000,
  retryBackoff: { baseMs: 5000, maxMs: 5 * 60_000, jitter: 0.2 },
};

const MAX_MEMORY_DURABLES = 1000;
const DEFAULT_LIMITS: Limits = { max_inbound_file_bytes: 20 * 1024 * 1024, max_outbound_file_bytes: 50 * 1024 * 1024 };

type DeliveryWaiter = { resolve: (r: { ok: true } | { ok: false; error: ProtocolError }) => void };

/** The gateway will never show these: the message is dropped, not retried. */
const TERMINAL_CODES = new Set(["invalid_message", "not_paired", "too_large"]);

/**
 * Send state of one durable on the current connection. `repump`: a notify whose retry is due and
 * waits for the outbox pump (which skips notifies still inside their backoff).
 */
type Flight = { envId: string | undefined; attempt: number; nextAt: number; repump?: boolean };

/**
 * One gateway connection: ws client with ping/backoff/close-code rules, hello → welcome → sync,
 * durable delivery until `delivered` (notify from the SQLite outbox, the rest from memory; resent after
 * every welcome and, while online, after `internal` or no answer with backoff),
 * inbound blobs into the uploads dir.
 */
export class GatewayLink {
  readonly name: string;
  readonly url: string;
  #tokenFile: string;
  #store: Store;
  #handler: LinkHandler;
  #log: Logger;
  #t: LinkTimings;
  #ws: WebSocket | undefined;
  #peer: Peer | undefined;
  #online = false;
  #stopped = true;
  #attempt = 0;
  #reconnectTimer: NodeJS.Timeout | undefined;
  #pingTimer: NodeJS.Timeout | undefined;
  #stableTimer: NodeJS.Timeout | undefined;
  #missedPongs = 0;
  #receiver: BlobReceiver;
  #blobDir: string;
  #failedBlobs = new Map<string, ProtocolError>();
  #uploads = new Map<string, Upload & { at: number }>();
  /** Durable messages kept in memory until delivered (turn.ended/error, permission/elicitation requests). */
  #durables = new Map<string, { type: DurableType; payload: PayloadOf<DurableType> }>();
  /** Envelope id of a sent durable → its key (to map `error` replies). */
  #sentIds = new Map<string, string>();
  /** Durable key → resend schedule on this connection (everything is resent after a reconnect anyway). */
  #flights = new Map<string, Flight>();
  #retryTimer: NodeJS.Timeout | undefined;
  #pairing: PairingInfo | undefined;
  #limits: Limits | undefined;
  #label: string | undefined;
  #outboxSent = new Set<string>();
  #pumping = false;
  #pumpAgain = false;
  #waiters = new Map<string, DeliveryWaiter[]>();
  welcome: PayloadOf<"welcome"> | undefined;
  lastError: string | undefined;
  nextRetryAt: number | undefined;
  connectedAt: number | undefined;

  constructor(cfg: GatewayConfig, store: Store, handler: LinkHandler, log: Logger, blobRoot: string, timings: Partial<LinkTimings> = {}) {
    this.name = cfg.name;
    this.url = cfg.url;
    this.#tokenFile = cfg.token_file;
    this.#store = store;
    this.#handler = handler;
    this.#log = log.child(`gw:${cfg.name}`);
    this.#t = { ...DEFAULT_TIMINGS, ...timings };
    this.#blobDir = join(blobRoot, cfg.name);
    mkdirSync(this.#blobDir, { recursive: true, mode: 0o700 });
    removeStaleParts(this.#blobDir, this.#log);
    this.#receiver = new BlobReceiver(this.#blobDir, () => this.limits.max_inbound_file_bytes);
    this.#pairing = store.kvGet<PairingInfo>(`pairing:${this.name}`);
    this.#limits = store.kvGet<Limits>(`limits:${this.name}`);
    this.#label = store.kvGet<string>(`label:${this.name}`);
  }

  get online(): boolean {
    return this.#online;
  }

  /** Last known pairing (persisted, so it is known while offline). */
  get pairing(): PairingInfo | undefined {
    return this.#pairing;
  }

  get limits(): Limits {
    return this.#limits ?? DEFAULT_LIMITS;
  }

  get label(): string {
    return this.welcome?.gateway.label ?? this.#label ?? this.name;
  }

  start(): void {
    if (!this.#stopped) return;
    this.#stopped = false;
    void this.#connect();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    clearTimeout(this.#reconnectTimer);
    const ws = this.#ws;
    if (ws && ws.readyState !== WebSocket.CLOSED) {
      const closed = new Promise<void>((r) => ws.once("close", () => r()));
      ws.close(1000, "connector stopping");
      const t = setTimeout(() => ws.terminate(), 2000);
      await closed;
      clearTimeout(t);
    }
    this.#teardown();
  }

  // ---- sending ----

  /** Non-durable message; dropped while offline (streaming updates are never replayed). */
  send<T extends MessageType>(type: T, payload: PayloadOf<T>): void {
    if (this.#online) this.#sendFitted(makeEnvelope(type, payload) as Envelope);
  }

  reply<T extends MessageType>(req: { id: string }, type: T, payload: PayloadOf<T>): void {
    if (!this.#peer || this.#peer.closed) return;
    if (!this.#sendFitted(makeEnvelope(type, payload, { re: req.id }) as Envelope)) this.replyError(req, new ProtocolError("too_large", `${type} does not fit in a frame`));
  }

  /** Every frame we build goes through here: oversized ACP fields are shortened to fit (Transport). */
  #sendFitted(env: Envelope): boolean {
    const r = fitEnvelope(env);
    if (!r.fits) {
      this.#log.error("frame too large even after shortening, not sent", { type: env.type });
      return false;
    }
    if (r.truncated > 0) this.#log.info("shortened an oversized frame", { type: env.type, removed_bytes: r.truncated });
    this.#peer!.sendEnvelope(r.env);
    return true;
  }

  replyError(req: { id: string } | undefined, err: unknown): void {
    if (this.#peer && !this.#peer.closed) this.#peer.replyError(req, err);
  }

  request<T extends RequestType>(type: T, payload: PayloadOf<T>): Promise<PayloadOf<ResponseTypeOf<T>>> {
    if (!this.#online) return Promise.reject(new ProtocolError("timeout", `gateway ${this.name} is offline`));
    return this.#peer!.request(type, payload);
  }

  /** turn.ended / turn.error / permission.request / elicitation.request: kept until `delivered` or a terminal error. */
  sendDurable(type: Exclude<DurableType, "notify">, payload: PayloadOf<DurableType>): void {
    const k = durableKey(type, payload);
    this.#durables.set(k, { type, payload });
    if (this.#durables.size > MAX_MEMORY_DURABLES) {
      const oldest = this.#durables.keys().next().value!;
      this.#forget(oldest);
      this.#log.warn("durable buffer full, dropping oldest unacked message", { key: oldest });
    }
    if (this.#online) this.#sendDurableNow(type, payload, k);
  }

  /** Forget a durable that no longer matters (resolved permission/elicitation). */
  dropDurable(k: string): void {
    this.#forget(k);
  }

  #forget(k: string): void {
    this.#durables.delete(k);
    const f = this.#flights.get(k);
    if (f?.envId) this.#sentIds.delete(f.envId);
    this.#flights.delete(k);
  }

  hasDurable(k: string): boolean {
    return this.#durables.has(k);
  }

  #sendDurableNow(type: DurableType, payload: PayloadOf<DurableType>, k: string): void {
    const env = makeEnvelope(type, payload as never) as Envelope;
    const prev = this.#flights.get(k);
    if (prev?.envId) this.#sentIds.delete(prev.envId);
    if (!this.#sendFitted(env)) {
      this.#dropRejected(k, new ProtocolError("too_large", `${type} does not fit in a frame`));
      return;
    }
    const attempt = (prev?.attempt ?? 0) + 1;
    this.#sentIds.set(env.id, k);
    // no answer at all: resend after the ack timeout (or the backoff, once it is longer)
    this.#flights.set(k, { envId: env.id, attempt, nextAt: Date.now() + Math.max(this.#t.ackTimeoutMs, this.#retryDelay(attempt)) });
    this.#armRetry();
  }

  #retryDelay(attempt: number): number {
    return backoffDelay(attempt - 1, this.#t.retryBackoff);
  }

  /**
   * Resend `k` after its backoff: the gateway said `internal`/`timeout` to a send (counted when
   * sent), or a notify failed before it was sent (`unsent`: its blob transfer failed), which
   * counts as one more attempt so the delay keeps growing.
   */
  #retryLater(k: string, unsent = false): void {
    if (!this.#online) return;
    const f = this.#flights.get(k) ?? { envId: undefined, attempt: 0, nextAt: 0 };
    if (f.envId) this.#sentIds.delete(f.envId);
    if (unsent || f.attempt === 0) f.attempt++;
    f.envId = undefined;
    f.repump = false;
    f.nextAt = Date.now() + this.#retryDelay(f.attempt);
    this.#flights.set(k, f);
    this.#armRetry();
  }

  #armRetry(): void {
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    if (!this.#online) return;
    let next = Infinity;
    for (const f of this.#flights.values()) next = Math.min(next, f.nextAt);
    if (next === Infinity) return;
    this.#retryTimer = setTimeout(() => this.#resendDue(), Math.max(0, next - Date.now()));
    this.#retryTimer.unref();
  }

  /** While online: resend durables that got `internal`/`timeout` or no answer in time. */
  #resendDue(): void {
    this.#retryTimer = undefined;
    if (!this.#online) return;
    const now = Date.now();
    let pump = false;
    for (const [k, f] of this.#flights) {
      if (f.nextAt > now) continue;
      this.#log.info("resending an unacknowledged durable message", { key: k, attempt: f.attempt + 1 });
      if (k.startsWith("notify:")) {
        // re-pumped from the outbox so its blobs are sent again first; #sendNotify re-arms it
        if (f.envId) this.#sentIds.delete(f.envId);
        f.envId = undefined;
        f.nextAt = Infinity;
        f.repump = true;
        this.#outboxSent.delete(k.slice("notify:".length));
        pump = true;
        continue;
      }
      const d = this.#durables.get(k);
      if (d) this.#sendDurableNow(d.type, d.payload, k);
      else this.#forget(k);
    }
    if (pump) void this.pumpOutbox();
    this.#armRetry();
  }

  /** Terminal rejection (or a frame that cannot fit): drop the message and tell a notify's caller. */
  #dropRejected(k: string, err: ProtocolError): void {
    this.#forget(k);
    if (k.startsWith("notify:")) {
      const id = k.slice("notify:".length);
      this.#store.deleteOutbox(id);
      this.#outboxSent.delete(id);
    } else {
      this.#handler.durableRejected(this, k, err);
    }
    this.#settleWaiters(k, { ok: false, error: err });
  }

  /** Persist a notify in the outbox and try to deliver it. */
  enqueueNotify(e: OutboxEntry): void {
    this.#store.addOutbox(e);
    void this.pumpOutbox();
  }

  /** Resolves when the gateway acks (ok), rejects it (error) or after `ms` (undefined). */
  waitDelivered(k: string, ms: number): Promise<{ ok: true } | { ok: false; error: ProtocolError } | undefined> {
    return new Promise((resolve) => {
      const w: DeliveryWaiter = {
        resolve: (r) => {
          clearTimeout(t);
          resolve(r);
        },
      };
      const t = setTimeout(() => {
        const list = this.#waiters.get(k);
        if (list) this.#waiters.set(k, list.filter((x) => x !== w));
        resolve(undefined);
      }, ms);
      const list = this.#waiters.get(k) ?? [];
      list.push(w);
      this.#waiters.set(k, list);
    });
  }

  #settleWaiters(k: string, r: { ok: true } | { ok: false; error: ProtocolError }): void {
    const list = this.#waiters.get(k);
    this.#waiters.delete(k);
    for (const w of list ?? []) w.resolve(r);
  }

  /** Send outbox notifies not yet sent on this connection, each with its blobs first. */
  async pumpOutbox(): Promise<void> {
    if (!this.#online) return;
    if (this.#pumping) {
      this.#pumpAgain = true;
      return;
    }
    this.#pumping = true;
    try {
      do {
        this.#pumpAgain = false;
        for (const e of this.#store.listOutbox(this.name)) {
          if (!this.#online) return;
          if (this.#outboxSent.has(e.notify_id)) continue;
          // still inside its backoff after a failed blob transfer: the retry timer re-pumps it
          const f = this.#flights.get(`notify:${e.notify_id}`);
          if (f && !f.repump && f.envId === undefined && f.nextAt > Date.now()) continue;
          await this.#sendNotify(e);
        }
      } while (this.#pumpAgain && this.#online);
    } finally {
      this.#pumping = false;
    }
  }

  async #sendNotify(e: OutboxEntry): Promise<void> {
    const peer = this.#peer!;
    const k = `notify:${e.notify_id}`;
    const blobIds: string[] = [];
    for (const f of e.files) {
      const problem = await localFileProblem(f.path);
      if (problem?.kind === "missing") {
        this.#log.warn("outbox file vanished, sending without it", { notify_id: e.notify_id, path: f.path });
        continue;
      }
      if (problem?.kind === "terminal") {
        // a local problem no retry will fix: fail the send_message caller instead of retrying forever
        this.#log.error("cannot read a notify file, dropping the notify", { notify_id: e.notify_id, path: f.path, err: problem.reason });
        this.#dropRejected(k, new ProtocolError("invalid_message", `cannot read ${f.path}: ${problem.reason}`));
        return;
      }
      if (problem) {
        this.#log.warn("cannot read a notify file right now, will retry", { notify_id: e.notify_id, path: f.path, err: problem.reason });
        if (peer === this.#peer) this.#retryLater(k, true);
        return;
      }
      try {
        const stored = await sendFileBlob(peer, f.path, { name: f.name, mime: f.mime });
        blobIds.push(stored.blob_id);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.#log.warn("outbox file vanished, sending without it", { notify_id: e.notify_id, path: f.path });
          continue;
        }
        if (err instanceof ProtocolError && TERMINAL_CODES.has(err.code)) {
          this.#log.error("gateway rejected a notify file, dropping the notify", { notify_id: e.notify_id, path: f.path, code: err.code });
          this.#dropRejected(k, err);
          return;
        }
        // link dropped (resent after reconnect) or the gateway failed to store it (resent with backoff)
        this.#log.warn("blob transfer interrupted, will retry", { notify_id: e.notify_id, err: (err as Error).message });
        if (peer === this.#peer) this.#retryLater(k, true);
        return;
      }
    }
    if (!this.#online || peer !== this.#peer) return;
    const payload: PayloadOf<"notify"> = { notify_id: e.notify_id, switched: e.switched };
    if (e.conversation_id) payload.conversation_id = e.conversation_id;
    if (e.session) payload.session = e.session;
    if (e.text) payload.text = e.text;
    if (blobIds.length) payload.files = blobIds;
    if (!payload.text && !payload.files) {
      this.#log.warn("notify has neither text nor files left, dropping", { notify_id: e.notify_id });
      this.#dropRejected(k, new ProtocolError("invalid_message", "files vanished"));
      return;
    }
    this.#outboxSent.add(e.notify_id);
    this.#sendDurableNow("notify", payload, k);
  }

  hasUpload(blob_id: string): boolean {
    return this.#uploads.has(blob_id);
  }

  /** Received upload for a later conversation.prompt attachment. */
  takeUpload(blob_id: string): Upload | undefined {
    const u = this.#uploads.get(blob_id);
    this.#uploads.delete(blob_id);
    return u;
  }

  // ---- connection ----

  async #connect(): Promise<void> {
    if (this.#stopped) return;
    let token: string;
    try {
      token = (await readFile(this.#tokenFile, "utf8")).trim();
      if (!token) throw new Error("empty token file");
      if (((await stat(this.#tokenFile)).mode & 0o077) !== 0) this.#log.warn(`token file ${this.#tokenFile} is readable by others; chmod 600 it`);
    } catch (err) {
      this.lastError = `token file ${this.#tokenFile}: ${(err as Error).message}`;
      this.#log.error(this.lastError);
      this.#schedule(this.#t.unauthorizedRetryMs);
      return;
    }
    this.#log.info("connecting", { url: this.url });
    const ws = new WebSocket(this.url, { headers: { Authorization: `Bearer ${token}` }, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 30_000 });
    this.#ws = ws;
    let unauthorized = false;
    ws.on("unexpected-response", (_req, res) => {
      unauthorized = res.statusCode === 401 || res.statusCode === 403;
      this.lastError = `HTTP ${res.statusCode} on upgrade`;
      ws.terminate();
    });
    ws.on("error", (err) => {
      this.lastError = err.message;
      this.#log.warn("socket error", err.message);
    });
    ws.on("open", () => this.#onOpen(ws));
    ws.on("pong", () => (this.#missedPongs = 0));
    ws.on("message", (data, isBinary) => {
      if (isBinary) {
        this.#peer?.replyError(undefined, new ProtocolError("invalid_message", "binary frames are not allowed"));
        return;
      }
      this.#onFrame(data as Buffer);
    });
    ws.on("close", (code, reason) => {
      if (this.#ws !== ws) return;
      this.#teardown();
      if (this.#stopped) return;
      const why = reason.toString();
      if (code === CloseCode.unauthorized || unauthorized) {
        this.lastError = `unauthorized (${code}${why ? `: ${why}` : ""}); check ${this.#tokenFile}`;
        this.#log.error(`gateway rejected the token, next attempt in ≥${Math.round(this.#t.unauthorizedRetryMs / 1000)} s`, { code, reason: why });
        this.#schedule(Math.max(this.#t.unauthorizedRetryMs, backoffDelay(this.#attempt++, this.#t.backoff)));
        return;
      }
      if (code === CloseCode.replaced) {
        this.lastError = "replaced by another connection with the same token";
        this.#log.error("CONNECTION REPLACED (4409): another agent-connector is using this gateway token. Two copies will keep evicting each other; stop one of them or rotate the token.");
      } else if (code === CloseCode.unsupportedVersion) {
        this.lastError = `gateway does not support protocol ${PROTOCOL_VERSION}`;
        this.#log.error(this.lastError);
        this.#schedule(Math.max(this.#t.unauthorizedRetryMs, backoffDelay(this.#attempt++, this.#t.backoff)));
        return;
      } else {
        this.#log.warn("disconnected", { code, reason: why });
      }
      this.#schedule(backoffDelay(this.#attempt++, this.#t.backoff));
    });
  }

  #schedule(delay: number): void {
    if (this.#stopped) return;
    clearTimeout(this.#reconnectTimer);
    this.nextRetryAt = Date.now() + delay;
    this.#reconnectTimer = setTimeout(() => {
      this.nextRetryAt = undefined;
      void this.#connect();
    }, delay);
    this.#reconnectTimer.unref();
  }

  #onOpen(ws: WebSocket): void {
    this.#peer = new Peer(
      { send: (data, cb) => (ws.readyState === WebSocket.OPEN ? ws.send(data, cb) : cb(new Error("socket closed"))) },
      { onSendError: (err) => this.#log.debug("send failed", err.message) },
    );
    this.#missedPongs = 0;
    this.#pingTimer = setInterval(() => {
      if (this.#missedPongs >= 2) {
        this.#log.warn("2 pongs missed, reconnecting");
        ws.terminate();
        return;
      }
      this.#missedPongs++;
      ws.ping();
    }, this.#t.pingIntervalMs);
    this.#pingTimer.unref();
    this.#peer.send("hello", this.#handler.hello());
    const t = setTimeout(() => {
      if (!this.#online && this.#ws === ws) {
        this.#log.warn("no welcome, reconnecting");
        ws.terminate();
      }
    }, this.#t.welcomeTimeoutMs);
    t.unref();
  }

  #onFrame(data: Buffer): void {
    const peer = this.#peer;
    if (!peer) return;
    const r = decode(data);
    if (!r.ok) {
      this.#log.warn("invalid frame from gateway", { code: r.code, message: r.message });
      peer.sendEnvelope(errorEnvelope(new ProtocolError("invalid_message", r.message), r.id));
      return;
    }
    const env = r.env;
    if (env.type === "error" && env.re && this.#sentIds.has(env.re)) {
      this.#onDurableError(env.re, env.payload);
      return;
    }
    if (peer.handleResponse(env)) return;
    if (!this.#online) {
      if (env.type === "welcome") this.#onWelcome(env.payload);
      else if (env.type === "error") this.#log.error("gateway refused hello", env.payload);
      else peer.replyError(env, new ProtocolError("invalid_message", `expected welcome, got ${env.type}`));
      return;
    }
    switch (env.type) {
      case "delivered":
        this.#onDelivered(env.payload.id);
        return;
      case "pairing.changed": {
        const { reason: _r, ...info } = env.payload;
        this.#savePairing(info);
        this.#log.info("pairing changed", env.payload);
        return;
      }
      case "blob.begin":
        this.#receiver.begin(env.payload).catch((e) => this.#failedBlobs.set(env.payload.blob_id, asProtocolError(e)));
        return;
      case "blob.chunk":
        if (this.#failedBlobs.has(env.payload.blob_id)) return;
        this.#receiver.chunk(env.payload).catch((e) => this.#failedBlobs.set(env.payload.blob_id, asProtocolError(e)));
        return;
      case "blob.end":
        void this.#onBlobEnd(env as Envelope<"blob.end">);
        return;
      case "error":
        this.#log.warn("gateway error", env.payload);
        return;
      default:
        this.#handler.message(this, env);
    }
  }

  async #onBlobEnd(env: Envelope<"blob.end">): Promise<void> {
    const { blob_id } = env.payload;
    try {
      const blob = await this.#receiver.end(env.payload);
      const failed = this.#failedBlobs.get(blob_id);
      if (failed) throw failed;
      this.#receiver.take(blob_id);
      const path = await this.#handler.storeUpload(blob);
      this.#uploads.set(blob_id, { path, name: blob.name, mime: blob.mime, size: blob.size, at: Date.now() });
      this.#pruneUploads();
      this.reply(env, "blob.stored", { blob_id, path });
    } catch (err) {
      const pe = this.#failedBlobs.get(blob_id) ?? asProtocolError(err);
      this.#failedBlobs.delete(blob_id);
      this.#log.warn("inbound blob rejected", { blob_id, code: pe.code, message: pe.message });
      this.replyError(env, pe);
    }
  }

  #pruneUploads(): void {
    const cutoff = Date.now() - 60 * 60_000;
    for (const [id, u] of this.#uploads) if (u.at < cutoff) this.#uploads.delete(id);
  }

  #onWelcome(w: PayloadOf<"welcome">): void {
    this.welcome = w;
    this.#online = true;
    this.connectedAt = Date.now();
    this.lastError = undefined;
    this.#limits = w.limits;
    this.#label = w.gateway.label;
    this.#store.kvSet(`limits:${this.name}`, w.limits);
    this.#store.kvSet(`label:${this.name}`, w.gateway.label);
    this.#savePairing(w.pairing);
    this.#log.info("connected", { gateway: w.gateway, connector_id: w.connector_id, paired: w.pairing.paired });
    this.#stableTimer = setTimeout(() => (this.#attempt = 0), this.#t.stableMs);
    this.#stableTimer.unref();
    // R2: snapshot first, then everything not yet acknowledged.
    const sync = this.#handler.sync(this);
    this.#sendFitted(makeEnvelope("sync", sync) as Envelope);
    const inSync = new Set(sync.pending.map((p) => `req:${p.request_id}`));
    for (const [k, d] of this.#durables) {
      if (!inSync.has(k)) this.#sendDurableNow(d.type, d.payload, k);
      // shown through sync: if the gateway never acks it (its sync path failed), resend it like any unacked durable
      else this.#flights.set(k, { envId: undefined, attempt: 0, nextAt: Date.now() + this.#t.ackTimeoutMs });
    }
    this.#armRetry();
    void this.pumpOutbox();
  }

  #savePairing(p: PairingInfo): void {
    this.#pairing = p;
    this.#store.kvSet(`pairing:${this.name}`, p);
  }

  #onDelivered(k: string): void {
    this.#forget(k);
    if (k.startsWith("notify:")) {
      const id = k.slice("notify:".length);
      this.#store.deleteOutbox(id);
      this.#outboxSent.delete(id);
    }
    for (const [envId, key] of this.#sentIds) if (key === k) this.#sentIds.delete(envId);
    this.#settleWaiters(k, { ok: true });
  }

  #onDurableError(envId: string, err: PayloadOf<"error">): void {
    const k = this.#sentIds.get(envId)!;
    this.#sentIds.delete(envId);
    const pe = new ProtocolError(err.code, err.message, err.details);
    if (TERMINAL_CODES.has(err.code)) {
      // R16: e.g. a queued notify rejected as not_paired is dropped, not retried forever
      this.#log.error("gateway rejected a durable message, dropping it", { key: k, code: err.code, message: err.message });
      this.#dropRejected(k, pe);
      return;
    }
    this.#log.warn("gateway could not deliver a durable message, will resend", { key: k, code: err.code });
    if (this.#flights.get(k)?.envId === envId) this.#retryLater(k);
  }

  #teardown(): void {
    this.#online = false;
    this.connectedAt = undefined;
    clearInterval(this.#pingTimer);
    clearTimeout(this.#stableTimer);
    this.#peer?.close();
    this.#peer = undefined;
    this.#ws = undefined;
    this.#sentIds.clear();
    this.#flights.clear();
    clearTimeout(this.#retryTimer);
    this.#retryTimer = undefined;
    this.#outboxSent.clear();
    this.#failedBlobs.clear();
    this.#receiver.clear().catch((err) => this.#log.warn("cannot clean up partial blobs", (err as Error).message));
  }
}

/** Local file errors no retry will fix; anything else (EMFILE, ENFILE, EIO, EBUSY, ...) is retried. */
const TERMINAL_FILE_ERRORS = new Set(["EACCES", "EPERM", "EISDIR"]);

export type FileProblem = { kind: "missing" } | { kind: "terminal" | "transient"; reason: string };

/** Why a file cannot be sent now; undefined when it is a readable regular file. `fs` is a test seam. */
export async function localFileProblem(path: string, fs: { stat: typeof stat; open: typeof open } = { stat, open }): Promise<FileProblem | undefined> {
  try {
    const st = await fs.stat(path);
    if (!st.isFile()) return { kind: "terminal", reason: "not a regular file" };
    await (await fs.open(path, "r")).close();
    return undefined;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    const reason = `${code ?? "error"}: ${(err as Error).message}`;
    return { kind: code && TERMINAL_FILE_ERRORS.has(code) ? "terminal" : "transient", reason };
  }
}

/** Partial blobs of a previous run (crash mid-transfer) are never completed: delete them. */
function removeStaleParts(dir: string, log: Logger): void {
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".part")) continue;
    try {
      rmSync(join(dir, f), { force: true });
    } catch (err) {
      log.warn("cannot remove a stale partial blob", { file: f, err: (err as Error).message });
    }
  }
}

function asProtocolError(e: unknown): ProtocolError {
  return e instanceof ProtocolError ? e : new ProtocolError("internal", e instanceof Error ? e.message : String(e));
}
