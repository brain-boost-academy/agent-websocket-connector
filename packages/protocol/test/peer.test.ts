// protects=request/response matching, R21 control-before-bulk ordering, blob integrity checks;
// fails_when=a response resolves the wrong request, control waits behind >1 chunk, a corrupted blob is accepted;
// no_claim=real WebSocket backpressure
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Peer, BlobReceiver, sendFileBlob, sendBufferBlob, decode, encode, makeEnvelope, uuidv7, ProtocolError, BLOB_CHUNK_BYTES, type AnyEnvelope, type FrameSink } from "../src/index.ts";

/** Sink that holds each write until released, to observe queue order. */
class ManualSink implements FrameSink {
  frames: AnyEnvelope[] = [];
  #cbs: Array<() => void> = [];
  #types: string[] = [];
  send(data: string, cb: (err?: Error) => void): void {
    const r = decode(data);
    assert.ok(r.ok);
    this.frames.push(r.env);
    this.#types.push(r.env.type);
    this.#cbs.push(() => {
      this.#types.shift();
      cb();
    });
  }
  /** Frames of `type` handed to the sink whose write has not completed yet. */
  unflushed(type: string): number {
    return this.#types.filter((t) => t === type).length;
  }
  flushOne(): void {
    this.#cbs.shift()?.();
  }
  flushAll(): void {
    while (this.#cbs.length) this.flushOne();
  }
}

/** Two peers wired together; each frame is dispatched to the other side's handler. */
function pair(onA: (env: AnyEnvelope, a: Peer) => void, onB: (env: AnyEnvelope, b: Peer) => void) {
  let a!: Peer, b!: Peer;
  a = new Peer({ send: (d, cb) => { queueMicrotask(() => { const r = decode(d); if (r.ok && !b.handleResponse(r.env)) onB(r.env, b); cb(); }); } });
  b = new Peer({ send: (d, cb) => { queueMicrotask(() => { const r = decode(d); if (r.ok && !a.handleResponse(r.env)) onA(r.env, a); cb(); }); } });
  return { a, b };
}

test("control frames overtake queued bulk frames, at most one chunk in between (R21)", () => {
  const sink = new ManualSink();
  const p = new Peer(sink);
  for (let i = 0; i < 3; i++) p.send("blob.chunk", { blob_id: uuidv7(), index: i, data: "" }, { bulk: true });
  p.send("session.cancel", { conversation_id: "1" });
  // first chunk is already in flight
  assert.deepEqual(sink.frames.map((f) => f.type), ["blob.chunk"]);
  sink.flushOne();
  assert.deepEqual(sink.frames.map((f) => f.type), ["blob.chunk", "session.cancel"]);
  sink.flushAll();
  sink.flushAll();
  sink.flushAll();
  assert.deepEqual(sink.frames.map((f) => f.type), ["blob.chunk", "session.cancel", "blob.chunk", "blob.chunk"]);
});

test("request resolves with matching response and rejects with error payload", async () => {
  const { a } = pair(() => {}, (env, b) => {
    if (env.type === "session.cancel") b.reply(env, "session.cancel.result", { cancelled: true });
    if (env.type === "session.set_mode") b.replyError(env, new ProtocolError("unknown_session", "nope"));
  });
  assert.deepEqual(await a.request("session.cancel", { conversation_id: "1" }), { cancelled: true });
  await assert.rejects(a.request("session.set_mode", { conversation_id: "1", mode_id: "x" }), (e: unknown) => e instanceof ProtocolError && e.code === "unknown_session");
});

test("unmatched error frames are not swallowed; late non-error responses are", () => {
  const p = new Peer({ send: (_d, cb) => cb() });
  const err = decode(JSON.stringify({ v: 1, id: "e", type: "error", ts: "t", re: "nobody", payload: { code: "not_paired", message: "x" } }));
  const late = decode(JSON.stringify({ v: 1, id: "l", type: "session.cancel.result", ts: "t", re: "nobody", payload: { cancelled: true } }));
  assert.ok(err.ok && late.ok);
  if (err.ok) assert.equal(p.handleResponse(err.env), false);
  if (late.ok) assert.equal(p.handleResponse(late.env), true);
});

test("request times out and close rejects pending", async () => {
  const p = new Peer({ send: (_d, cb) => cb() }, { requestTimeoutMs: 20 });
  await assert.rejects(p.request("pairing.status", {}), (e: unknown) => e instanceof ProtocolError && e.code === "timeout");
  const pending = p.request("pairing.status", {}, { timeoutMs: 10_000 });
  p.close();
  await assert.rejects(pending, /link closed/);
});

test("file blob round-trips across chunk boundaries and verifies sha256", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const src = join(dir, "src.bin");
  const data = Buffer.alloc(BLOB_CHUNK_BYTES * 2 + 17, 7);
  data[5] = 1;
  writeFileSync(src, data);
  const rx = new BlobReceiver(dir, 10 << 20);
  const { a } = pair(() => {}, async (env, b) => {
    try {
      if (env.type === "blob.begin") await rx.begin(env.payload);
      else if (env.type === "blob.chunk") await rx.chunk(env.payload);
      else if (env.type === "blob.end") {
        const blob = await rx.end(env.payload);
        b.reply(env, "blob.stored", { blob_id: blob.blob_id, path: blob.path });
      }
    } catch (e) {
      b.replyError(env, e);
    }
  });
  const stored = await sendFileBlob(a, src, { name: "src.bin", mime: "application/octet-stream" });
  const blob = rx.take(stored.blob_id);
  assert.ok(blob);
  assert.deepEqual(readFileSync(blob.path), data);
});

test("blob over the limit is too_large; size mismatch is rejected and cleaned", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const rx = new BlobReceiver(dir, 4);
  await assert.rejects(rx.begin({ blob_id: uuidv7(), name: "n", mime: "m", size: 5, sha256: "0".repeat(64) }), (e: unknown) => e instanceof ProtocolError && e.code === "too_large");
  const rx2 = new BlobReceiver(dir, 100);
  const y = uuidv7();
  await rx2.begin({ blob_id: y, name: "n", mime: "m", size: 3, sha256: "0".repeat(64) });
  await rx2.chunk({ blob_id: y, index: 0, data: Buffer.from("abc").toString("base64") });
  await assert.rejects(rx2.end({ blob_id: y }), /mismatch/);
  assert.equal(existsSync(join(dir, `${y}.part`)), false);
});

test("buffer blob goes through the same path", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const rx = new BlobReceiver(dir, 100);
  const { a } = pair(() => {}, async (env, b) => {
    if (env.type === "blob.begin") await rx.begin(env.payload);
    else if (env.type === "blob.chunk") await rx.chunk(env.payload);
    else if (env.type === "blob.end") b.reply(env, "blob.stored", { blob_id: (await rx.end(env.payload)).blob_id });
  });
  const stored = await sendBufferBlob(a, Buffer.from("hello"), { name: "h.txt", mime: "text/plain" });
  assert.equal(readFileSync(rx.take(stored.blob_id)!.path, "utf8"), "hello");
});

// protects=blob files stay inside the receiver's dir and one peer cannot pile up open blobs;
// fails_when=a blob_id with path separators reaches the filesystem, a duplicate begin leaks a handle, open blobs are unbounded;
// no_claim=disk quota of the host
test("blob_id must be a uuid: traversal ids are rejected by the schema and by the receiver", async () => {
  const bad = { blob_id: "../../escape", name: "n", mime: "m", size: 1, sha256: "0".repeat(64) };
  const r = decode(encode(makeEnvelope("blob.begin", bad)));
  assert.ok(!r.ok && r.code === "invalid_message");
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const rx = new BlobReceiver(join(dir, "inner"), 100);
  await assert.rejects(rx.begin(bad), (e: unknown) => e instanceof ProtocolError && e.code === "invalid_message");
  assert.equal(existsSync(join(dir, "..", "escape.part")), false);
});

test("duplicate blob_id is rejected; open blobs per receiver are capped", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const rx = new BlobReceiver(dir, 100, { maxOpen: 2 });
  const meta = { name: "n", mime: "m", size: 1, sha256: "0".repeat(64) };
  const a = uuidv7();
  await rx.begin({ blob_id: a, ...meta });
  await assert.rejects(rx.begin({ blob_id: a, ...meta }), (e: unknown) => e instanceof ProtocolError && e.code === "invalid_message");
  await rx.begin({ blob_id: uuidv7(), ...meta });
  // retryable: the sender tries again once blobs are taken or expire
  await assert.rejects(rx.begin({ blob_id: uuidv7(), ...meta }), (e: unknown) => e instanceof ProtocolError && e.code === "internal");
  await rx.clear();
});

// protects=completed blobs nobody claims do not pile up on disk or block new transfers;
// fails_when=an untaken blob stays forever, its slot keeps counting against maxOpen, a taken blob is deleted by the expiry;
// no_claim=clock jumps
test("completed blobs that nobody takes expire after doneTtlMs (file removed, slot freed)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const rx = new BlobReceiver(dir, 100, { maxOpen: 1, doneTtlMs: 50 });
  const data = Buffer.from("abc");
  const sha256 = createHash("sha256").update(data).digest("hex");
  const store = async () => {
    const id = uuidv7();
    await rx.begin({ blob_id: id, name: "n", mime: "m", size: 3, sha256 });
    await rx.chunk({ blob_id: id, index: 0, data: data.toString("base64") });
    return rx.end({ blob_id: id });
  };
  const left = await store();
  assert.ok(existsSync(left.path));
  await assert.rejects(store(), (e: unknown) => e instanceof ProtocolError && e.code === "internal");
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(existsSync(left.path), false);
  assert.equal(rx.take(left.blob_id), undefined);
  const taken = await store(); // the slot is free again
  assert.equal(rx.take(taken.blob_id)!.path, taken.path);
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(existsSync(taken.path), true, "a taken blob belongs to the caller");
  await rx.clear();
});

// protects=blob senders apply backpressure: a large file is not turned into a queue of base64 strings in memory;
// fails_when=sendFileBlob/sendBufferBlob queue more than 2 chunk frames ahead of the socket, a chunk is lost or reordered, blob.end overtakes a chunk;
// no_claim=kernel socket buffers (ws calls back once the frame is written to the socket)
for (const kind of ["buffer", "file"] as const) {
  test(`${kind} blob: at most 2 chunk frames are pending at any time`, async () => {
    const sink = new ManualSink();
    const p = new Peer(sink);
    const data = Buffer.alloc(BLOB_CHUNK_BYTES * 6 + 5, 3);
    let sending: Promise<unknown>;
    if (kind === "buffer") sending = sendBufferBlob(p, data, { name: "b.bin", mime: "application/octet-stream" });
    else {
      const dir = mkdtempSync(join(tmpdir(), "blob-"));
      writeFileSync(join(dir, "f.bin"), data);
      sending = sendFileBlob(p, join(dir, "f.bin"), { name: "f.bin", mime: "application/octet-stream" });
    }
    let maxPending = 0;
    for (let i = 0; i < 200 && !sink.frames.some((f) => f.type === "blob.end"); i++) {
      await new Promise((r) => setTimeout(r, 2));
      maxPending = Math.max(maxPending, p.queuedBulk + sink.unflushed("blob.chunk"));
      sink.flushOne();
    }
    const chunks = sink.frames.filter((f) => f.type === "blob.chunk").map((f) => (f.payload as { index: number }).index);
    assert.deepEqual(chunks, [0, 1, 2, 3, 4, 5, 6]);
    assert.ok(maxPending <= 2, `pending chunk frames: ${maxPending}`);
    const end = sink.frames.find((f) => f.type === "blob.end")!;
    sink.flushAll();
    const blob_id = (end.payload as { blob_id: string }).blob_id;
    p.handleResponse(makeEnvelope("blob.stored", { blob_id }, { re: end.id }) as AnyEnvelope);
    assert.equal(((await sending) as { blob_id: string }).blob_id, blob_id);
  });
}

test("a blob transfer stops when the link closes mid-way", async () => {
  const sink = new ManualSink();
  const p = new Peer(sink);
  const sending = sendBufferBlob(p, Buffer.alloc(BLOB_CHUNK_BYTES * 5, 1), { name: "b", mime: "m" });
  await new Promise((r) => setTimeout(r, 5));
  p.close();
  sink.flushAll();
  await assert.rejects(sending, /link closed/);
  assert.ok(sink.frames.filter((f) => f.type === "blob.chunk").length < 5);
});

// protects=a blob that expired before the message referencing it arrived is recognisable (retry with fresh blobs instead of a terminal error), the default TTL leaves room for slow multi-file uploads, expiry/cleanup never crash the process;
// fails_when=expired ids are forgotten, the set of expired ids grows without bound, a blob expires before 30 min by default, an rm failure during expiry or clear() becomes an unhandled rejection;
// no_claim=how a gateway maps wasExpired to its reply
async function storeBlob(rx: BlobReceiver): Promise<{ blob_id: string; path: string }> {
  const data = Buffer.from("abc");
  const id = uuidv7();
  await rx.begin({ blob_id: id, name: "n", mime: "m", size: 3, sha256: createHash("sha256").update(data).digest("hex") });
  await rx.chunk({ blob_id: id, index: 0, data: data.toString("base64") });
  return rx.end({ blob_id: id });
}

test("default doneTtlMs is 30 min; wasExpired() remembers expired ids (bounded to the last 1000)", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const dir = mkdtempSync(join(tmpdir(), "blob-"));
  const rx = new BlobReceiver(dir, 100);
  const b = await storeBlob(rx);
  t.mock.timers.tick(29 * 60_000);
  for (let i = 0; i < 50; i++) await new Promise((r) => setImmediate(r)); // let a due expiry finish its rm
  assert.equal(existsSync(b.path), true, "still there after 29 min");
  assert.equal(rx.wasExpired(b.blob_id), false);
  t.mock.timers.tick(60_000);
  for (let i = 0; i < 50 && existsSync(b.path); i++) await new Promise((r) => setImmediate(r));
  assert.equal(existsSync(b.path), false);
  assert.equal(rx.wasExpired(b.blob_id), true);
  assert.equal(rx.wasExpired(uuidv7()), false);
  t.mock.timers.reset();

  const small = new BlobReceiver(mkdtempSync(join(tmpdir(), "blob-")), 100, { doneTtlMs: 1, maxOpen: 2000 });
  const ids: string[] = [];
  for (let i = 0; i < 1001; i++) ids.push((await storeBlob(small)).blob_id);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(small.wasExpired(ids[0]!), false, "the oldest expired id is forgotten");
  assert.equal(small.wasExpired(ids[1000]!), true);
  assert.equal(small.wasExpired(ids[1]!), true);
});

test("expiry and clear() survive files that cannot be removed (no unhandled rejection)", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (e: unknown) => unhandled.push(e);
  process.on("unhandledRejection", onUnhandled);
  try {
    const dir = mkdtempSync(join(tmpdir(), "blob-"));
    const rx = new BlobReceiver(dir, 100, { doneTtlMs: 20 });
    for (const b of [await storeBlob(rx), await storeBlob(rx)]) {
      // a non-empty directory where the file was: rm({force}) fails with EISDIR / ERR_FS_EISDIR
      rmSync(b.path);
      mkdirSync(b.path);
      writeFileSync(join(b.path, "x"), "x");
    }
    const kept = await storeBlob(new BlobReceiver(dir, 100)); // unrelated
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(unhandled, []);
    const rx2 = new BlobReceiver(dir, 100, { doneTtlMs: 60_000 });
    const b2 = await storeBlob(rx2);
    rmSync(b2.path);
    mkdirSync(b2.path);
    writeFileSync(join(b2.path, "x"), "x");
    await rx2.clear();
    await new Promise((r) => setTimeout(r, 20));
    assert.deepEqual(unhandled, []);
    assert.ok(existsSync(kept.path));
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});
