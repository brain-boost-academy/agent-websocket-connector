import { createHash } from "node:crypto";
import { open, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { BLOB_CHUNK_BYTES, ProtocolError } from "./envelope.ts";
import { BLOB_ID_RE, type PayloadOf } from "./messages.ts";
import type { Peer } from "./peer.ts";
import { uuidv7 } from "./uuid.ts";

export type BlobMeta = { name: string; mime: string };

async function sha256File(path: string): Promise<string> {
  const h = createHash("sha256");
  const fh = await open(path, "r");
  try {
    for await (const chunk of fh.createReadStream()) h.update(chunk as Buffer);
  } finally {
    await fh.close();
  }
  return h.digest("hex");
}

/** Bulk chunk frames allowed in memory at once (one being written, one queued). */
const CHUNKS_IN_FLIGHT = 2;

/**
 * Send chunks produced by `next` with backpressure: a chunk is queued only after the one two
 * places before it has been written, so a large file never sits in memory as base64 frames.
 */
async function sendChunks(peer: Peer, blob_id: string, next: () => Promise<Buffer | undefined>): Promise<void> {
  const inflight: Array<Promise<void>> = [];
  for (let index = 0; ; index++) {
    const data = await next();
    if (!data) break;
    if (peer.closed) throw new ProtocolError("timeout", "link closed");
    const w = peer.sendWritten("blob.chunk", { blob_id, index, data: data.toString("base64") }, { bulk: true });
    w.catch(() => {}); // awaited below; avoid an unhandled rejection while an earlier write is awaited
    inflight.push(w);
    if (inflight.length >= CHUNKS_IN_FLIGHT) await inflight.shift();
  }
  for (const w of inflight) await w;
}

/**
 * Send a file as blob.begin/chunk/end on the bulk queue and wait for blob.stored.
 * The caller sends the message that references `blob_id` only after this resolves.
 */
export async function sendFileBlob(peer: Peer, path: string, meta: BlobMeta, opts: { timeoutMs?: number } = {}): Promise<PayloadOf<"blob.stored">> {
  const { size } = await stat(path);
  const blob_id = uuidv7();
  peer.send("blob.begin", { blob_id, name: meta.name, mime: meta.mime, size, sha256: await sha256File(path) }, { bulk: true });
  const fh = await open(path, "r");
  try {
    const buf = Buffer.alloc(BLOB_CHUNK_BYTES); // reused: each chunk is base64-encoded before the next read
    await sendChunks(peer, blob_id, async () => {
      const { bytesRead } = await fh.read(buf, 0, BLOB_CHUNK_BYTES, null);
      return bytesRead === 0 ? undefined : buf.subarray(0, bytesRead);
    });
  } finally {
    await fh.close();
  }
  // Large files queue many chunks; give the transfer time proportional to size.
  const timeoutMs = opts.timeoutMs ?? 30_000 + Math.ceil(size / (256 * 1024)) * 1000;
  return peer.request("blob.end", { blob_id }, { bulk: true, timeoutMs });
}

export async function sendBufferBlob(peer: Peer, data: Buffer, meta: BlobMeta): Promise<PayloadOf<"blob.stored">> {
  const blob_id = uuidv7();
  const sha256 = createHash("sha256").update(data).digest("hex");
  peer.send("blob.begin", { blob_id, name: meta.name, mime: meta.mime, size: data.length, sha256 }, { bulk: true });
  let off = 0;
  await sendChunks(peer, blob_id, async () => {
    if (off >= data.length) return undefined;
    const chunk = data.subarray(off, off + BLOB_CHUNK_BYTES);
    off += BLOB_CHUNK_BYTES;
    return chunk;
  });
  return peer.request("blob.end", { blob_id }, { bulk: true, timeoutMs: 30_000 + Math.ceil(data.length / (256 * 1024)) * 1000 });
}

/** Default lifetime of a stored blob nobody takes: covers multi-file messages on a slow uplink. */
export const BLOB_DONE_TTL_MS = 30 * 60_000;
/** How many expired blob ids a receiver remembers for wasExpired(). */
const EXPIRED_MEMORY = 1000;

/** Best-effort file removal: cleanup must never turn into an unhandled rejection (EPERM, EBUSY, ...). */
const removeQuietly = (path: string) => rm(path, { force: true }).catch(() => {});

export type ReceivedBlob = { blob_id: string; name: string; mime: string; size: number; path: string };

type Incoming = {
  begin: PayloadOf<"blob.begin">;
  path: string;
  fh: Awaited<ReturnType<typeof open>>;
  hash: ReturnType<typeof createHash>;
  received: number;
  nextIndex: number;
};

/**
 * Assembles incoming blobs into files under `dir`. Verifies order, size and sha256.
 * Completed blobs stay in `dir` until the owner takes them with `take()`, or are deleted after
 * `doneTtlMs` (default 30 min) when nobody does; `wasExpired()` then tells a late reference apart
 * from an unknown id (answer `internal`, the sender re-sends fresh blobs).
 */
export class BlobReceiver {
  #dir: string;
  #maxBytes: () => number;
  #incoming = new Map<string, Incoming>();
  #done = new Map<string, { blob: ReceivedBlob; timer: NodeJS.Timeout }>();
  // Frames arrive faster than file I/O completes; run operations strictly in arrival order.
  #chain: Promise<unknown> = Promise.resolve();

  #maxOpen: number;
  #doneTtlMs: number;
  /** Recently expired ids, oldest first (insertion order), at most EXPIRED_MEMORY. */
  #expired = new Set<string>();

  /** `maxOpen` caps blobs that are in flight or stored but not yet taken; untaken ones expire after `doneTtlMs`. */
  constructor(dir: string, maxBytes: number | (() => number), opts: { maxOpen?: number; doneTtlMs?: number } = {}) {
    this.#dir = dir;
    this.#maxBytes = typeof maxBytes === "number" ? () => maxBytes : maxBytes;
    this.#maxOpen = opts.maxOpen ?? 16;
    this.#doneTtlMs = opts.doneTtlMs ?? BLOB_DONE_TTL_MS;
  }

  begin(p: PayloadOf<"blob.begin">): Promise<void> {
    return this.#serial(() => this.#begin(p));
  }

  chunk(p: PayloadOf<"blob.chunk">): Promise<void> {
    return this.#serial(() => this.#chunk(p));
  }

  end(p: PayloadOf<"blob.end">): Promise<ReceivedBlob> {
    return this.#serial(() => this.#end(p));
  }

  #serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.#chain.then(fn, fn);
    this.#chain = run.catch(() => {});
    return run;
  }

  async #begin(p: PayloadOf<"blob.begin">): Promise<void> {
    if (!BLOB_ID_RE.test(p.blob_id)) throw new ProtocolError("invalid_message", "blob_id must be a uuid");
    if (this.#incoming.has(p.blob_id) || this.#done.has(p.blob_id)) throw new ProtocolError("invalid_message", `duplicate blob ${p.blob_id}`);
    // transient: slots free up when blobs are taken or expire, so the sender may retry
    if (this.#incoming.size + this.#done.size >= this.#maxOpen) throw new ProtocolError("internal", `more than ${this.#maxOpen} blobs open`);
    if (p.size > this.#maxBytes()) throw new ProtocolError("too_large", `${p.name}: ${p.size} bytes > limit ${this.#maxBytes()}`);
    const path = join(this.#dir, `${p.blob_id}.part`);
    const fh = await open(path, "w", 0o600);
    this.#incoming.set(p.blob_id, { begin: p, path, fh, hash: createHash("sha256"), received: 0, nextIndex: 0 });
  }

  async #chunk(p: PayloadOf<"blob.chunk">): Promise<void> {
    const inc = this.#incoming.get(p.blob_id);
    if (!inc) throw new ProtocolError("invalid_message", `unknown blob ${p.blob_id}`);
    if (p.index !== inc.nextIndex) {
      await this.#abort(p.blob_id);
      throw new ProtocolError("invalid_message", `blob ${p.blob_id}: chunk ${p.index}, expected ${inc.nextIndex}`);
    }
    const data = Buffer.from(p.data, "base64");
    inc.received += data.length;
    if (inc.received > inc.begin.size) {
      await this.#abort(p.blob_id);
      throw new ProtocolError("too_large", `blob ${p.blob_id} exceeds declared size`);
    }
    inc.nextIndex++;
    inc.hash.update(data);
    await inc.fh.write(data);
  }

  async #end(p: PayloadOf<"blob.end">): Promise<ReceivedBlob> {
    const inc = this.#incoming.get(p.blob_id);
    if (!inc) throw new ProtocolError("invalid_message", `unknown blob ${p.blob_id}`);
    this.#incoming.delete(p.blob_id);
    await inc.fh.close();
    const sha = inc.hash.digest("hex");
    if (inc.received !== inc.begin.size || sha !== inc.begin.sha256) {
      await removeQuietly(inc.path);
      throw new ProtocolError("invalid_message", `blob ${p.blob_id}: size/sha256 mismatch`);
    }
    const blob: ReceivedBlob = { blob_id: p.blob_id, name: inc.begin.name, mime: inc.begin.mime, size: inc.received, path: inc.path };
    const timer = setTimeout(() => this.#serial(() => this.#expire(p.blob_id)).catch(() => {}), this.#doneTtlMs);
    timer.unref?.();
    this.#done.set(p.blob_id, { blob, timer });
    return blob;
  }

  async #expire(blob_id: string): Promise<void> {
    const d = this.#done.get(blob_id);
    if (!d) return;
    this.#done.delete(blob_id);
    this.#expired.add(blob_id);
    if (this.#expired.size > EXPIRED_MEMORY) this.#expired.delete(this.#expired.values().next().value!);
    await removeQuietly(d.blob.path);
  }

  /** The blob was stored here but expired before anyone took it (a message referencing it came too late). */
  wasExpired(blob_id: string): boolean {
    return this.#expired.has(blob_id);
  }

  /** Hand a completed blob to the caller, who becomes responsible for its file. */
  take(blob_id: string): ReceivedBlob | undefined {
    const d = this.#done.get(blob_id);
    if (!d) return undefined;
    clearTimeout(d.timer);
    this.#done.delete(blob_id);
    return d.blob;
  }

  /** Remove partial and unclaimed files (on disconnect). */
  clear(): Promise<void> {
    return this.#serial(() => this.#clear());
  }

  async #clear(): Promise<void> {
    for (const id of [...this.#incoming.keys()]) await this.#abort(id);
    for (const d of this.#done.values()) {
      clearTimeout(d.timer);
      await removeQuietly(d.blob.path);
    }
    this.#done.clear();
  }

  async #abort(blob_id: string): Promise<void> {
    const inc = this.#incoming.get(blob_id);
    if (!inc) return;
    this.#incoming.delete(blob_id);
    await inc.fh.close().catch(() => {});
    await removeQuietly(inc.path);
  }
}
