// Fake gateway: a ws server speaking protocol v1 through the protocol package (Peer, BlobReceiver).
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  BlobReceiver,
  CloseCode,
  decode,
  DURABLE_TYPES,
  durableKey,
  Peer,
  ProtocolError,
  sendFileBlob,
  type AnyEnvelope,
  type DurableType,
  type MessageType,
  type PayloadOf,
  type RequestType,
  type ResponseTypeOf,
} from "@brain-boost-academy/agent-protocol";

export type FakeGatewayOptions = {
  token?: string;
  pairing?: PayloadOf<"welcome">["pairing"];
  limits?: PayloadOf<"welcome">["limits"];
  label?: string;
};

export class FakeGateway {
  readonly token: string;
  received: AnyEnvelope[] = [];
  connections = 0;
  authFailures = 0;
  /** Ack durable messages with `delivered` (as a gateway does after showing them). */
  autoAck = true;
  /** Reply to notify with this error instead of acking. */
  notifyError: PayloadOf<"error">["code"] | undefined;
  /** Per-message answer to a durable: an error code, "ignore" (no answer), or undefined for the defaults above. */
  onDurable: ((env: AnyEnvelope) => PayloadOf<"error">["code"] | "ignore" | undefined) | undefined;
  /** Answer every blob.end with this error (the gateway cannot store files right now). */
  blobError: PayloadOf<"error">["code"] | undefined;
  pairing: PayloadOf<"welcome">["pairing"];
  limits: PayloadOf<"welcome">["limits"];
  label: string;
  /** Lifetime of pairing codes (expires_at). */
  pairingTtlMs = 600_000;
  storedBlobs = new Map<string, { name: string; size: number; path: string }>();
  #wss: WebSocketServer | undefined;
  #ws: WebSocket | undefined;
  #peer: Peer | undefined;
  #receiver: BlobReceiver;
  #blobDir: string;
  #waiters: Array<{ pred: (e: AnyEnvelope) => boolean; resolve: (e: AnyEnvelope) => void }> = [];
  port = 0;

  constructor(o: FakeGatewayOptions = {}) {
    this.token = o.token ?? "test-token";
    this.pairing = o.pairing ?? { paired: true, user_display: "@owner", conversation_id: "chat-1" };
    this.limits = o.limits ?? { max_inbound_file_bytes: 20 * 1024 * 1024, max_outbound_file_bytes: 50 * 1024 * 1024 };
    this.label = o.label ?? "Fake";
    this.#blobDir = mkdtempSync(join(tmpdir(), "fgw-blobs-"));
    this.#receiver = new BlobReceiver(this.#blobDir, () => this.limits.max_outbound_file_bytes);
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}/v1/connect`;
  }

  get online(): boolean {
    return this.#peer !== undefined && !this.#peer.closed;
  }

  async start(port = 0): Promise<void> {
    this.#wss = new WebSocketServer({ port, host: "127.0.0.1" });
    await new Promise<void>((r) => this.#wss!.once("listening", () => r()));
    this.port = (this.#wss.address() as { port: number }).port;
    this.#wss.on("connection", (ws, req) => this.#onConnection(ws, req.headers.authorization));
  }

  async stop(): Promise<void> {
    for (const c of this.#wss?.clients ?? []) c.terminate();
    await new Promise<void>((r) => (this.#wss ? this.#wss.close(() => r()) : r()));
    this.#peer?.close();
    rmSync(this.#blobDir, { recursive: true, force: true });
  }

  #onConnection(ws: WebSocket, auth: string | undefined): void {
    if (auth !== `Bearer ${this.token}`) {
      this.authFailures++;
      ws.close(CloseCode.unauthorized, "unauthorized");
      return;
    }
    // last wins (R5)
    if (this.#ws) this.#ws.close(CloseCode.replaced, "replaced");
    this.connections++;
    this.#ws = ws;
    const peer = new Peer({ send: (d, cb) => ws.send(d, cb) });
    this.#peer = peer;
    ws.on("close", () => {
      peer.close();
      if (this.#ws === ws) {
        this.#ws = undefined;
        this.#peer = undefined;
      }
    });
    ws.on("message", (data) => {
      const r = decode(data as Buffer);
      if (!r.ok) {
        peer.replyError(r.id ? { id: r.id } : undefined, new Error(r.message));
        return;
      }
      void this.#onEnvelope(peer, r.env);
    });
  }

  async #onEnvelope(peer: Peer, env: AnyEnvelope): Promise<void> {
    if (peer.handleResponse(env)) {
      this.#record(env);
      return;
    }
    this.#record(env);
    switch (env.type) {
      case "hello":
        peer.reply(env, "welcome", {
          protocol: 1,
          gateway: { kind: "fake", label: this.label, version: "0" },
          connector_id: "c-1",
          limits: this.limits,
          pairing: this.pairing,
        });
        return;
      case "pairing.request":
        peer.reply(env, "pairing.code", { code: "CODE123", url: "https://t.me/fakebot?start=CODE123", expires_at: new Date(Date.now() + this.pairingTtlMs).toISOString() });
        return;
      case "pairing.revoke":
        this.pairing = { paired: false };
        peer.reply(env, "pairing.revoke.result", { ok: true });
        return;
      case "blob.begin":
        await this.#receiver.begin(env.payload).catch(() => {});
        return;
      case "blob.chunk":
        await this.#receiver.chunk(env.payload).catch(() => {});
        return;
      case "blob.end":
        if (this.blobError) {
          await this.#receiver.end(env.payload).then((b) => this.#receiver.take(b.blob_id), () => {});
          peer.replyError(env, new ProtocolError(this.blobError, "cannot store the file now"));
          return;
        }
        try {
          const b = await this.#receiver.end(env.payload);
          this.storedBlobs.set(b.blob_id, { name: b.name, size: b.size, path: b.path });
          peer.reply(env, "blob.stored", { blob_id: b.blob_id });
        } catch (err) {
          peer.replyError(env, err);
        }
        return;
    }
    if ((DURABLE_TYPES as readonly string[]).includes(env.type)) {
      const answer = this.onDurable?.(env);
      if (answer === "ignore") return;
      if (answer) {
        peer.replyError(env, new ProtocolError(answer, `${answer} from fake gateway`));
        return;
      }
      if (env.type === "notify" && this.notifyError) {
        peer.replyError(env, new ProtocolError(this.notifyError, "rejected by fake gateway"));
        return;
      }
      if (this.autoAck) peer.send("delivered", { id: durableKey(env.type as DurableType, env.payload as PayloadOf<DurableType>) });
    }
  }

  #record(env: AnyEnvelope): void {
    this.received.push(env);
    for (const w of [...this.#waiters]) {
      if (w.pred(env)) {
        this.#waiters.splice(this.#waiters.indexOf(w), 1);
        w.resolve(env);
      }
    }
  }

  /** Resolve with the first message (already received or future) matching `pred`. */
  waitFor<T extends MessageType>(type: T, pred: (p: PayloadOf<T>, env: AnyEnvelope) => boolean = () => true, timeoutMs = 8000, from = 0): Promise<AnyEnvelope & { payload: PayloadOf<T> }> {
    const match = (e: AnyEnvelope) => e.type === type && pred(e.payload as PayloadOf<T>, e);
    const seen = this.received.slice(from).find(match);
    if (seen) return Promise.resolve(seen as AnyEnvelope & { payload: PayloadOf<T> });
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.#waiters = this.#waiters.filter((w) => w !== waiter);
        reject(new Error(`timed out waiting for ${type}; got: ${this.received.map((e) => e.type).join(", ")}`));
      }, timeoutMs);
      const waiter = {
        pred: match,
        resolve: (e: AnyEnvelope) => {
          clearTimeout(t);
          resolve(e as AnyEnvelope & { payload: PayloadOf<T> });
        },
      };
      this.#waiters.push(waiter);
    });
  }

  all<T extends MessageType>(type: T): Array<AnyEnvelope & { payload: PayloadOf<T> }> {
    return this.received.filter((e) => e.type === type) as Array<AnyEnvelope & { payload: PayloadOf<T> }>;
  }

  request<T extends RequestType>(type: T, payload: PayloadOf<T>): Promise<PayloadOf<ResponseTypeOf<T>>> {
    if (!this.#peer) throw new Error("connector not connected");
    return this.#peer.request(type, payload);
  }

  send<T extends MessageType>(type: T, payload: PayloadOf<T>): void {
    if (!this.#peer) throw new Error("connector not connected");
    this.#peer.send(type, payload);
  }

  /** Raw frame (for invalid-message tests). */
  sendRaw(data: string): void {
    this.#ws?.send(data);
  }

  /** Close the current connection with a code (4409 replaced, 1012 restart, ...). */
  drop(code = 1012): void {
    this.#ws?.close(code, "test");
  }

  /** Simulate a missing network: stop answering pings (ws auto-pongs, so pause the socket). */
  freeze(): void {
    const s = (this.#ws as unknown as { _socket?: { pause(): void } })?._socket;
    s?.pause();
  }

  /** Upload a file to the connector; resolves with blob.stored. */
  sendFile(path: string, name: string, mime: string): Promise<PayloadOf<"blob.stored">> {
    if (!this.#peer) throw new Error("connector not connected");
    return sendFileBlob(this.#peer, path, { name, mime });
  }
}
