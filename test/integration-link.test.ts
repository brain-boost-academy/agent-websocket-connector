// protects=R2 reconnect contract (sync after every welcome, unacked durables resent, notify outbox survives connector restarts until `delivered`, blobs re-sent first), retries of unacked durables while the link stays up, terminal errors drop any durable, turn.error is durable, 4401 slow retry, 4409 normal reconnect, ping timeout reconnect, R16 not_paired drop;
// fails_when=a notify is lost or resent after its ack, sync is missing after reconnect, a durable that got `internal` or no answer waits for a reconnect, a terminally rejected durable is kept or resent, a turn.error is lost while offline, a revoked token is retried at backoff speed, a replaced connection never comes back, a frozen socket is never dropped, a not_paired notify is retried forever;
// no_claim=real network partitions, TLS, the real gateway's dedupe table
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { callControl } from "../src/control/client.ts";
import { DEFAULT_TIMINGS } from "../src/daemon/gateway-link.ts";
import { FakeGateway } from "./helpers/fake-gateway.ts";
import { sleep, startHarness, waitUntil } from "./helpers/harness.ts";

test("reconnect: sync again, unacked turn.ended resent; acked ones are not", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }]);
  try {
    await gw.waitFor("sync");
    gw.autoAck = false;
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "one", origin: "text" });
    const t1 = await gw.waitFor("turn.ended", () => true, 5000, from);
    gw.autoAck = true;
    const from2 = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "two", origin: "text" });
    const t2 = await gw.waitFor("turn.ended", () => true, 5000, from2); // auto-acked
    const from3 = gw.received.length;
    gw.drop(1012);
    await gw.waitFor("hello", () => true, 5000, from3);
    await gw.waitFor("sync", () => true, 5000, from3);
    const resent = await gw.waitFor("turn.ended", () => true, 5000, from3);
    assert.equal(resent.payload.turn_id, t1.payload.turn_id);
    assert.notEqual(resent.id, t1.id); // new envelope, same durable key
    await sleep(200);
    assert.equal(gw.received.slice(from3).filter((e) => e.type === "turn.ended" && (e.payload as { turn_id: string }).turn_id === t2.payload.turn_id).length, 0);
    assert.equal(gw.connections, 2);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("AC14: notify stays in the SQLite outbox across a connector restart and is delivered with its file re-sent first", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { deliveryWaitMs: 500 });
  try {
    await gw.waitFor("sync");
    gw.autoAck = false;
    const file = join(h.dir, "report.txt");
    writeFileSync(file, "hello report");
    const r = await callControl<{ delivered: Array<{ status: string }> }>("send_message", { text: "report", files: [file] }, { path: h.socket });
    assert.equal(r.delivered[0]!.status, "queued");
    const n1 = await gw.waitFor("notify");
    assert.equal(h.daemon.store.listOutbox("tg").length, 1);
    const beginIdx = gw.received.findIndex((e) => e.type === "blob.begin");
    assert.ok(beginIdx >= 0 && beginIdx < gw.received.indexOf(n1), "blob before notify");

    await h.restart();
    gw.autoAck = true;
    const from = gw.received.length;
    const n2 = await gw.waitFor("notify", () => true, 8000, from);
    assert.equal(n2.payload.notify_id, n1.payload.notify_id);
    const blobBegin = gw.received.slice(from).findIndex((e) => e.type === "blob.begin");
    const notifyIdx = gw.received.slice(from).indexOf(n2);
    assert.ok(blobBegin >= 0 && blobBegin < notifyIdx, "file re-sent before the notify");
    assert.notDeepEqual(n2.payload.files, n1.payload.files); // fresh blob ids
    await waitUntil(() => h.daemon.store.listOutbox("tg").length === 0, 3000, "outbox drained");
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("R16: a queued notify rejected with not_paired is dropped, not retried", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }]);
  try {
    await gw.waitFor("sync");
    gw.notifyError = "not_paired";
    await assert.rejects(callControl("send_message", { text: "hi" }, { path: h.socket }), (e: Error & { code?: string }) => e.code === "not_paired");
    assert.equal(h.daemon.store.listOutbox().length, 0);
    const from = gw.received.length;
    gw.notifyError = undefined;
    gw.drop(1012);
    await gw.waitFor("sync", () => true, 5000, from);
    await sleep(200);
    assert.equal(gw.received.slice(from).filter((e) => e.type === "notify").length, 0);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

const FAST_RETRY = { ackTimeoutMs: 400, retryBackoff: { baseMs: 150, maxMs: 600, jitter: 0 } };

test("online retry: a durable answered with `internal` is resent with backoff on the same connection, until delivered", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: FAST_RETRY });
  try {
    await gw.waitFor("sync");
    let failures = 0;
    gw.onDurable = (env) => (env.type === "turn.ended" && failures++ < 2 ? "internal" : undefined);
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "one", origin: "text" });
    await waitUntil(() => gw.received.slice(from).filter((e) => e.type === "turn.ended").length === 3, 4000, "two resends");
    const sends = gw.received.slice(from).filter((e) => e.type === "turn.ended");
    assert.equal(new Set(sends.map((e) => (e.payload as { turn_id: string }).turn_id)).size, 1);
    const gaps = sends.slice(1).map((e, i) => Date.parse(e.ts) - Date.parse(sends[i]!.ts));
    assert.ok(gaps[0]! >= 140 && gaps[1]! >= 290, `backoff grows: ${gaps}`);
    await sleep(800); // delivered: no more resends
    assert.equal(gw.received.slice(from).filter((e) => e.type === "turn.ended").length, 3);
    assert.equal(gw.connections, 1);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("online retry: a durable without any answer is resent after the ack timeout", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: FAST_RETRY });
  try {
    await gw.waitFor("sync");
    let n = 0;
    gw.onDurable = (env) => (env.type === "turn.ended" && n++ === 0 ? "ignore" : undefined);
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "one", origin: "text" });
    await waitUntil(() => gw.received.slice(from).filter((e) => e.type === "turn.ended").length === 2, 3000, "resend after silence");
    const [a, b] = gw.received.slice(from).filter((e) => e.type === "turn.ended");
    assert.ok(Date.parse(b!.ts) - Date.parse(a!.ts) >= 390);
    assert.equal(gw.connections, 1);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("online retry: a notify answered with `internal` is resent with its file re-sent first", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: FAST_RETRY });
  try {
    await gw.waitFor("sync");
    let n = 0;
    gw.onDurable = (env) => (env.type === "notify" && n++ === 0 ? "internal" : undefined);
    const file = join(h.dir, "r.txt");
    writeFileSync(file, "report");
    const from = gw.received.length;
    const r = await callControl<{ delivered: Array<{ status: string }> }>("send_message", { text: "report", files: [file] }, { path: h.socket });
    assert.equal(r.delivered[0]!.status, "delivered");
    const types = gw.received.slice(from).filter((e) => e.type === "blob.begin" || e.type === "notify").map((e) => e.type);
    assert.deepEqual(types, ["blob.begin", "notify", "blob.begin", "notify"]);
    const notifies = gw.all("notify").slice(-2);
    assert.equal(notifies[0]!.payload.notify_id, notifies[1]!.payload.notify_id);
    assert.equal(h.daemon.store.listOutbox().length, 0);
    assert.equal(gw.connections, 1);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("terminal errors drop any durable: a turn.ended rejected with not_paired is neither kept nor resent", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: FAST_RETRY });
  try {
    await gw.waitFor("sync");
    gw.onDurable = (env) => (env.type === "turn.ended" ? "not_paired" : undefined);
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "one", origin: "text" });
    const ended = await gw.waitFor("turn.ended", () => true, 5000, from);
    const link = h.daemon.router.links.get("tg")!;
    await waitUntil(() => !link.hasDurable(`turn:${ended.payload.turn_id}`), 2000, "dropped");
    gw.onDurable = undefined;
    const from2 = gw.received.length;
    gw.drop(1012);
    await gw.waitFor("sync", () => true, 5000, from2);
    await sleep(600);
    assert.equal(gw.received.slice(from).filter((e) => e.type === "turn.ended").length, 1);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("turn.error is durable: kept until delivered and resent after a reconnect", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }]);
  try {
    await gw.waitFor("sync");
    gw.autoAck = false;
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "die [crash]", origin: "text" });
    const err = await gw.waitFor("turn.error", () => true, 8000, from);
    gw.autoAck = true;
    const from2 = gw.received.length;
    gw.drop(1012);
    await gw.waitFor("sync", () => true, 5000, from2);
    const again = await gw.waitFor("turn.error", () => true, 5000, from2);
    assert.equal(again.payload.turn_id, err.payload.turn_id);
    await waitUntil(() => !h.daemon.router.links.get("tg")!.hasDurable(`turn:${err.payload.turn_id}`), 2000, "acked");
    // let the crashed agent finish restarting: stopping the pool mid-restart would orphan the new process
    await waitUntil(() => h.daemon.pool.agent("fake").running, 5000, "agent restarted");
  } finally {
    await h.stop();
    await gw.stop();
  }
});

// protects=a notify whose file cannot be uploaded backs off (5 s → 5 min) instead of re-uploading the file every few seconds, an unreadable local file fails the send instead of retrying forever, requests already in sync.pending are resent when unacked, a request every gateway rejects terminally does not leave the agent waiting;
// fails_when=blob failures retry at a fixed interval, any other send bypasses the backoff, EACCES is treated as transient, a pending permission shown only via sync is never resent, a not_paired permission/elicitation waits 30 min / forever;
// no_claim=the real gateway's sync-path dedupe
test("a notify whose blob upload keeps failing backs off with growing delays; other sends do not bypass it", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: { ackTimeoutMs: 400, retryBackoff: { baseMs: 300, maxMs: 5000, jitter: 0 } }, deliveryWaitMs: 200 });
  try {
    await gw.waitFor("sync");
    gw.blobError = "internal";
    const file = join(h.dir, "r.txt");
    writeFileSync(file, "report");
    const from = gw.received.length;
    const r = await callControl<{ delivered: Array<{ status: string }> }>("send_message", { text: "report", files: [file] }, { path: h.socket });
    assert.equal(r.delivered[0]!.status, "queued");
    // every send pumps the outbox: the failing notify must still wait for its backoff
    for (let i = 0; i < 3; i++) await h.daemon.sendMessage({ text: `ping ${i}` });
    const first = gw.received.slice(from).find((e) => e.type === "blob.begin")!;
    await sleep(Math.max(0, Date.parse(first.ts) + 1700 - Date.now()));
    const begins = gw.received.slice(from).filter((e) => e.type === "blob.begin").map((e) => Date.parse(e.ts));
    // uploads at ~0, +300, +600 later (900); the next one is due at 2100
    assert.equal(begins.length, 3, `uploads at ${begins.map((t) => t - begins[0]!)}`);
    assert.ok(begins[1]! - begins[0]! >= 290 && begins[2]! - begins[1]! >= 590, `${begins.map((t) => t - begins[0]!)}`);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("a notify file that cannot be read (EACCES) fails the send and leaves the outbox", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { deliveryWaitMs: 1000 });
  try {
    await gw.waitFor("sync");
    const file = join(h.dir, "secret.txt");
    writeFileSync(file, "x");
    chmodSync(file, 0);
    const from = gw.received.length;
    const r = await callControl<{ delivered: Array<{ status: string; error?: string }> }>("send_message", { text: "with file", files: [file] }, { path: h.socket });
    assert.equal(r.delivered[0]!.status, "failed");
    assert.match(r.delivered[0]!.error ?? "", /EACCES/);
    assert.equal(h.daemon.store.listOutbox().length, 0);
    assert.equal(gw.received.slice(from).filter((e) => e.type === "notify" || e.type === "blob.begin").length, 0);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("a permission request listed in sync.pending is resent if the gateway does not ack it", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: FAST_RETRY });
  try {
    await gw.waitFor("sync");
    gw.autoAck = false;
    const from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "ask [permission]", origin: "text" });
    const perm = await gw.waitFor("permission.request", () => true, 5000, from);
    const from2 = gw.received.length;
    gw.drop(1012);
    const sync = await gw.waitFor("sync", () => true, 5000, from2);
    assert.deepEqual(sync.payload.pending.map((p) => p.request_id), [perm.payload.request_id]);
    const again = await gw.waitFor("permission.request", () => true, 2000, from2);
    assert.equal(again.payload.request_id, perm.payload.request_id);
    assert.ok(Date.parse(again.ts) - Date.parse(sync.ts) >= 390, "not resent right with the sync");
    gw.autoAck = true;
    gw.send("permission.respond", { request_id: perm.payload.request_id, outcome: { outcome: "selected", optionId: "allow-once" } });
    await gw.waitFor("turn.ended", () => true, 5000, from2);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("a permission or question every gateway rejects terminally is cancelled, not left waiting", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }]);
  try {
    await gw.waitFor("sync");
    gw.onDurable = (env) => (env.type === "permission.request" ? "not_paired" : env.type === "elicitation.request" ? "invalid_message" : undefined);
    let from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "ask [permission]", origin: "text" });
    const perm = await gw.waitFor("permission.request", () => true, 5000, from);
    const resolved = await gw.waitFor("permission.resolved", (p) => p.request_id === perm.payload.request_id, 3000, from);
    assert.equal(resolved.payload.by, "cancelled");
    const ended = await gw.waitFor("turn.ended", () => true, 5000, from);
    assert.equal(ended.payload.stop_reason, "cancelled");
    from = gw.received.length;
    await gw.request("conversation.prompt", { conversation_id: "chat-1", text: "ask [elicit]", origin: "text" });
    const q = await gw.waitFor("elicitation.request", () => true, 5000, from);
    const qr = await gw.waitFor("elicitation.resolved", (p) => p.request_id === q.payload.request_id, 3000, from);
    assert.equal(qr.payload.by, "cancelled");
    assert.equal((await gw.waitFor("turn.ended", () => true, 5000, from)).payload.stop_reason, "cancelled");
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("4401: a rejected token is not retried at backoff speed", async () => {
  const gw = new FakeGateway({ token: "right" });
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: { unauthorizedRetryMs: 1500 } });
  try {
    // overwrite the token file with a wrong token and force a reconnect
    await gw.waitFor("sync");
    writeFileSync(join(h.dir, "tg.token"), "wrong\n");
    gw.drop(1012);
    await waitUntil(() => gw.authFailures === 1, 3000, "first auth failure");
    await sleep(700); // normal backoff here is 50-200 ms
    assert.equal(gw.authFailures, 1);
    const link = h.daemon.router.links.get("tg")!;
    assert.match(link.lastError ?? "", /unauthorized/);
    writeFileSync(join(h.dir, "tg.token"), "right\n");
    await waitUntil(() => link.online, 4000, "reconnect after the slow retry");
    assert.ok(gw.authFailures <= 2);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("4409 replaced: reconnects with normal backoff, not the slow unauthorized retry", async () => {
  const gw = new FakeGateway();
  await gw.start();
  // the slow retry is 60 s here: a reconnect within ~1 s proves 4409 uses the normal backoff (300 ms)
  const h = await startHarness([{ name: "tg", gw }], { link: { unauthorizedRetryMs: 60_000, backoff: { baseMs: 300, maxMs: 300, jitter: 0 } } });
  try {
    await gw.waitFor("sync");
    const link = h.daemon.router.links.get("tg")!;
    const from = gw.received.length;
    const t0 = Date.now();
    gw.drop(4409);
    await waitUntil(() => /replaced/.test(link.lastError ?? ""), 1000, "lastError says replaced");
    await gw.waitFor("sync", () => true, 1200, from);
    assert.ok(Date.now() - t0 < 1200);
    assert.equal(gw.connections, 2);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("production default: after 4401 the token is retried at most every 5 min", () => {
  assert.ok(DEFAULT_TIMINGS.unauthorizedRetryMs >= 300_000);
});

test("2 missed pongs → reconnect", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }], { link: { pingIntervalMs: 100 } });
  try {
    await gw.waitFor("sync");
    gw.freeze();
    await waitUntil(() => gw.connections === 2 && gw.online, 5000, "reconnect after missed pongs");
  } finally {
    await h.stop();
    await gw.stop();
  }
});

test("pairing.changed updates list_channels; pair_channel and unpair go through the gateway", async () => {
  const gw = new FakeGateway({ pairing: { paired: false } });
  await gw.start();
  const h = await startHarness([{ name: "tg", gw }]);
  try {
    await gw.waitFor("sync");
    let ch = await callControl<Array<{ paired: boolean; connected: boolean; label: string }>>("list_channels", {}, { path: h.socket });
    assert.deepEqual(ch[0], { name: "tg", label: "Fake", connected: true, paired: false });
    const code = await callControl<{ url: string; instructions: string }>("pair_channel", {}, { path: h.socket });
    assert.equal(code.url, "https://t.me/fakebot?start=CODE123");
    assert.match(code.instructions, /expires in 10 minutes/);
    gw.pairingTtlMs = 5 * 60_000; // the lifetime comes from the gateway's expires_at
    const short = await callControl<{ instructions: string }>("pair_channel", {}, { path: h.socket });
    assert.match(short.instructions, /expires in 5 minutes/);
    gw.send("pairing.changed", { paired: true, user_display: "@new", conversation_id: "chat-9", reason: "paired" });
    await waitUntil(() => h.daemon.router.links.get("tg")!.pairing?.paired === true, 2000, "paired");
    ch = await callControl("list_channels", {}, { path: h.socket });
    assert.equal(ch[0]!.paired, true);
    const un = await callControl<{ ok: boolean }>("unpair", {}, { path: h.socket });
    assert.equal(un.ok, true);
  } finally {
    await h.stop();
    await gw.stop();
  }
});

// protects=no disk leak from blob transfers interrupted by a crash;
// fails_when=*.part files of a previous run stay in the connector blob dir;
// no_claim=cleanup of the uploads dir (files there belong to the user)
test("stale *.part files in the blob dir are removed when the link starts", async () => {
  const gw = new FakeGateway();
  await gw.start();
  const dir = mkdtempSync(join(tmpdir(), "acn-"));
  const blobDir = join(dir, "state", "blobs", "tg");
  mkdirSync(blobDir, { recursive: true });
  writeFileSync(join(blobDir, "0190f0f0-0000-7000-8000-000000000000.part"), "half");
  writeFileSync(join(blobDir, "keep.txt"), "not ours to judge");
  const h = await startHarness([{ name: "tg", gw }], { dir });
  try {
    assert.equal(existsSync(join(blobDir, "0190f0f0-0000-7000-8000-000000000000.part")), false);
    assert.equal(existsSync(join(blobDir, "keep.txt")), true);
  } finally {
    await h.stop();
    await gw.stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
