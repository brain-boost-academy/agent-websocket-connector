import {
  encode,
  makeEnvelope,
  ProtocolError,
  errorEnvelope,
  REQUEST_TIMEOUT_MS,
  type AnyEnvelope,
  type Envelope,
} from "./envelope.ts";
import { ResponseOf, type MessageType, type PayloadOf, type RequestType, type ResponseTypeOf } from "./messages.ts";

/** Minimal surface of a `ws` WebSocket we write to. */
export interface FrameSink {
  send(data: string, cb: (err?: Error) => void): void;
}

/** A queued frame; `written` settles once the sink has written it (or the link closed). */
type Frame = { data: string; written?: (err?: Error) => void };

type Pending = {
  type: RequestType;
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
};

/**
 * One side of a connector<->gateway link: two-priority send queue (R21) and
 * request/response tracking by `re`. Bulk frames (blob.*) never delay control
 * frames by more than one chunk.
 */
export class Peer {
  #sink: FrameSink;
  #control: Frame[] = [];
  #bulk: Frame[] = [];
  #writing = false;
  #closed = false;
  #pending = new Map<string, Pending>();
  #timeoutMs: number;
  #onSendError: (err: Error) => void;

  constructor(sink: FrameSink, opts: { requestTimeoutMs?: number; onSendError?: (err: Error) => void } = {}) {
    this.#sink = sink;
    this.#timeoutMs = opts.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#onSendError = opts.onSendError ?? (() => {});
  }

  get closed(): boolean {
    return this.#closed;
  }

  /** Bulk frames waiting in the queue (not yet handed to the sink). */
  get queuedBulk(): number {
    return this.#bulk.length;
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { id?: string; re?: string; bulk?: boolean } = {}): Envelope<T> {
    const env = makeEnvelope(type, payload, opts);
    this.sendEnvelope(env, opts.bulk ?? false);
    return env;
  }

  sendEnvelope(env: Envelope, bulk = false): void {
    if (this.#closed) return;
    (bulk ? this.#bulk : this.#control).push({ data: encode(env) });
    this.#pump();
  }

  /**
   * Like send(), but resolves once the sink has written the frame (rejects when the write fails
   * or the link closes first). Blob senders await it to keep only a couple of chunks in memory.
   */
  sendWritten<T extends MessageType>(type: T, payload: PayloadOf<T>, opts: { id?: string; re?: string; bulk?: boolean } = {}): Promise<void> {
    if (this.#closed) return Promise.reject(new ProtocolError("timeout", "link closed"));
    const env = makeEnvelope(type, payload, opts);
    return new Promise<void>((resolve, reject) => {
      (opts.bulk ? this.#bulk : this.#control).push({ data: encode(env), written: (err) => (err ? reject(err) : resolve()) });
      this.#pump();
    });
  }

  request<T extends RequestType>(
    type: T,
    payload: PayloadOf<T>,
    opts: { bulk?: boolean; timeoutMs?: number } = {},
  ): Promise<PayloadOf<ResponseTypeOf<T>>> {
    if (this.#closed) return Promise.reject(new ProtocolError("timeout", "link closed"));
    const env = makeEnvelope(type, payload);
    const p = new Promise<PayloadOf<ResponseTypeOf<T>>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(env.id);
        reject(new ProtocolError("timeout", `${type} timed out`));
      }, opts.timeoutMs ?? this.#timeoutMs);
      timer.unref?.();
      this.#pending.set(env.id, { type, resolve: resolve as (p: unknown) => void, reject, timer });
    });
    this.sendEnvelope(env, opts.bulk ?? false);
    return p;
  }

  reply<T extends MessageType>(req: { id: string }, type: T, payload: PayloadOf<T>): void {
    this.send(type, payload, { re: req.id });
  }

  replyError(req: { id: string } | undefined, err: unknown): void {
    this.sendEnvelope(errorEnvelope(err, req?.id));
  }

  /** Consumes responses to our own requests. Returns true if `env` was one (an unmatched `error` returns false). */
  handleResponse(env: AnyEnvelope): boolean {
    if (!env.re) return false;
    const pending = this.#pending.get(env.re);
    // Late responses (after a timeout) are dropped; unmatched errors go to the caller's dispatcher to be logged.
    if (!pending) return env.type !== "error" && Object.values(ResponseOf).includes(env.type as never);
    this.#pending.delete(env.re);
    clearTimeout(pending.timer);
    if (env.type === "error") {
      pending.reject(new ProtocolError(env.payload.code, env.payload.message, env.payload.details));
    } else if (env.type !== ResponseOf[pending.type]) {
      pending.reject(new ProtocolError("invalid_message", `expected ${ResponseOf[pending.type]}, got ${env.type}`));
    } else {
      pending.resolve(env.payload);
    }
    return true;
  }

  /** Drop queued frames and fail pending requests. */
  close(reason = "link closed"): void {
    if (this.#closed) return;
    this.#closed = true;
    const dropped = [...this.#control, ...this.#bulk];
    this.#control = [];
    this.#bulk = [];
    for (const f of dropped) f.written?.(new ProtocolError("timeout", reason));
    for (const [id, p] of this.#pending) {
      clearTimeout(p.timer);
      p.reject(new ProtocolError("timeout", reason));
      this.#pending.delete(id);
    }
  }

  #pump(): void {
    if (this.#writing || this.#closed) return;
    const frame = this.#control.shift() ?? this.#bulk.shift();
    if (frame === undefined) return;
    this.#writing = true;
    this.#sink.send(frame.data, (err) => {
      this.#writing = false;
      if (err) this.#onSendError(err);
      frame.written?.(err);
      this.#pump();
    });
  }
}
