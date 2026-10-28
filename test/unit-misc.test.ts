// protects=config defaults/`~` expansion/agent override rules, SQLite bindings/outbox/kv persistence, uploads naming without overwrite, backoff bounds, Claude transcript path rule;
// fails_when=spec defaults drift (after_turn/3/30/10, 1800 s, uploads under cwd), an outbox row is lost on reopen, an upload overwrites an existing file or escapes the uploads dir, backoff exceeds 60 s ±20 %;
// no_claim=behaviour on filesystems without hard links (copy fallback is only exercised on EXDEV)
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeConfig, expandHome, BUNDLED_CLAUDE_ACP } from "../src/daemon/config.ts";
import { resolveCommand } from "../src/acp/agent-pool.ts";
import { Store } from "../src/store/store.ts";
import { candidateName, dateDir, sanitizeName, storeUpload } from "../src/daemon/uploads.ts";
import { backoffDelay } from "../src/daemon/backoff.ts";
import { claudeTranscriptPath, transcriptChanged } from "../src/acp/transcript.ts";
import { localFileProblem } from "../src/daemon/gateway-link.ts";

test("config: spec defaults when the file is empty", () => {
  const c = normalizeConfig({}, "/home/u");
  assert.equal(c.cwd, "/home/u/work");
  assert.equal(c.uploads_dir, "/home/u/work/uploads");
  assert.equal(c.default_agent, "claude");
  assert.equal(c.permission_timeout_s, 1800);
  assert.deepEqual(c.session_lifecycle, { mode: "after_turn", max_open_sessions: 3, idle_close_minutes: 30, busy_hold_minutes: 10 });
  assert.deepEqual(Object.keys(c.agents), ["claude", "opencode"]);
  assert.equal(c.agents.claude!.command, BUNDLED_CLAUDE_ACP);
  assert.equal(c.agents.claude!.env.CLAUDE_CODE_EXECUTABLE, "/home/u/.local/bin/claude");
  assert.deepEqual(c.agents.opencode!.args, ["acp"]);
  assert.deepEqual(c.gateways, []);
});

test("config: spec example with ~ expansion, agents replace defaults but inherit known fields", () => {
  const c = normalizeConfig(
    {
      cwd: "~/work", uploads_dir: "~/up", default_agent: "claude",
      agents: { claude: { command: "claude-agent-acp", env: { FOO: "~/x" } } },
      gateways: [{ name: "telegram", url: "wss://gw/v1/connect", token_file: "~/.config/agent-connector/telegram.token" }],
      session_lifecycle: { mode: "lru" },
    },
    "/h",
  );
  assert.equal(c.uploads_dir, "/h/up");
  assert.deepEqual(Object.keys(c.agents), ["claude"]);
  assert.deepEqual(c.agents.claude!.env, { CLAUDE_CODE_EXECUTABLE: "/h/.local/bin/claude", FOO: "/h/x" });
  assert.equal(c.gateways[0]!.token_file, "/h/.config/agent-connector/telegram.token");
  assert.equal(c.default_channel, "telegram");
  assert.equal(c.session_lifecycle.mode, "lru");
  assert.equal(c.session_lifecycle.max_open_sessions, 3);
  assert.throws(() => normalizeConfig({ default_agent: "nope" }), /default_agent/);
  assert.throws(() => normalizeConfig({ gateways: [{ name: "a", url: "x", token_file: "t" }, { name: "a", url: "y", token_file: "t" }] }), /duplicate/);
  assert.equal(expandHome("~", "/h"), "/h");
  assert.equal(expandHome("/abs", "/h"), "/abs");
});

test("the default claude agent runs the pinned claude-agent-acp entrypoint with this node", () => {
  const { command, args } = resolveCommand(normalizeConfig({}).agents.claude!);
  assert.equal(command, process.execPath);
  assert.match(args[0]!, /@agentclientprotocol\/claude-agent-acp\/dist\/index\.js$/);
  assert.ok(existsSync(args[0]!));
});

test("store: bindings, outbox and kv persist across reopen", (t) => {
  const tmp = mkdtempSync(join(tmpdir(), "acn-store-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const path = join(tmp, "state.db");
  let s = new Store(path);
  const ref = { agent_id: "claude", session_id: "s1", cwd: "/w" };
  s.setBinding({ gateway: "tg", conversation_id: "1", agent_id: "claude", session: ref });
  s.setBinding({ gateway: "web", conversation_id: "t", agent_id: "claude", session: ref });
  s.setBinding({ gateway: "tg", conversation_id: "2", agent_id: "opencode", session: null });
  s.addOutbox({ notify_id: "n1", gateway: "tg", text: "hi", switched: true, session: ref, conversation_id: "1", files: [{ path: "/f", name: "f", mime: "text/plain" }], created_at: 1 });
  s.addOutbox({ notify_id: "n2", gateway: "web", text: "yo", switched: false, files: [], created_at: 2 });
  s.kvSet("pairing:tg", { paired: true });
  s.close();
  s = new Store(path);
  assert.deepEqual(s.getBinding("tg", "1")!.session, ref);
  assert.equal(s.getBinding("tg", "2")!.session, null);
  assert.deepEqual(s.bindingsForSession("claude", "s1").map((b) => `${b.gateway}/${b.conversation_id}`), ["tg/1", "web/t"]);
  assert.deepEqual(s.listOutbox("tg").map((e) => e.notify_id), ["n1"]);
  assert.deepEqual(s.listOutbox().map((e) => e.notify_id), ["n1", "n2"]);
  assert.deepEqual(s.listOutbox("tg")[0]!.files, [{ path: "/f", name: "f", mime: "text/plain" }]);
  assert.equal(s.deleteOutbox("n1"), true);
  assert.equal(s.deleteOutbox("n1"), false);
  assert.deepEqual(s.kvGet("pairing:tg"), { paired: true });
  assert.equal(s.kvGet("missing"), undefined);
  s.close();
});

test("uploads: sanitized names, -1/-2 suffix before the extension, never overwrite", async (t) => {
  assert.equal(sanitizeName("../../etc/passwd"), "passwd");
  assert.equal(sanitizeName("a\\b\\c.txt"), "c.txt");
  assert.equal(sanitizeName("..hidden"), "hidden");
  assert.equal(sanitizeName("bad\x00\x07name.pdf"), "badname.pdf");
  assert.equal(sanitizeName("   "), "file");
  assert.equal(sanitizeName("x".repeat(300) + ".pdf").length, 200);
  assert.ok(sanitizeName("x".repeat(300) + ".pdf").endsWith(".pdf"));
  assert.equal(candidateName("photo.jpg", 0), "photo.jpg");
  assert.equal(candidateName("photo.jpg", 2), "photo-2.jpg");
  assert.equal(candidateName("archive.tar.gz", 1), "archive.tar-1.gz");
  assert.equal(candidateName("README", 1), "README-1");
  assert.equal(dateDir(new Date(2026, 0, 5)), "2026-01-05");

  const dir = mkdtempSync(join(tmpdir(), "acn-up-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const day = new Date(2026, 9, 19);
  const mk = (c: string) => {
    const p = join(dir, `src-${Math.random()}`);
    writeFileSync(p, c);
    return p;
  };
  const a = await storeUpload(mk("A"), join(dir, "uploads"), "doc.txt", day);
  const b = await storeUpload(mk("B"), join(dir, "uploads"), "doc.txt", day);
  const c = await storeUpload(mk("C"), join(dir, "uploads"), "../doc.txt", day);
  assert.equal(a, join(dir, "uploads", "2026-10-19", "doc.txt"));
  assert.equal(b, join(dir, "uploads", "2026-10-19", "doc-1.txt"));
  assert.equal(c, join(dir, "uploads", "2026-10-19", "doc-2.txt"));
  assert.deepEqual([a, b, c].map((p) => readFileSync(p, "utf8")), ["A", "B", "C"]);
});

test("backoff: 1 s → 60 s, ×2, ±20 % jitter", () => {
  assert.equal(backoffDelay(0, undefined, () => 0.5), 1000);
  assert.equal(backoffDelay(3, undefined, () => 0.5), 8000);
  assert.equal(backoffDelay(10, undefined, () => 0.5), 60_000);
  assert.equal(backoffDelay(10, undefined, () => 1), 72_000);
  assert.equal(backoffDelay(10, undefined, () => 0), 48_000);
});

test("Claude transcript path: every non-alphanumeric char of cwd becomes '-'", () => {
  assert.equal(claudeTranscriptPath("abc", "/home/af03/work.v2", "/h/.claude"), "/h/.claude/projects/-home-af03-work-v2/abc.jsonl");
  assert.equal(transcriptChanged({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 2 }), false);
  assert.equal(transcriptChanged({ mtimeMs: 1, size: 2 }, { mtimeMs: 1, size: 3 }), true);
  assert.equal(transcriptChanged(undefined, { mtimeMs: 1, size: 3 }), false);
});

// protects=only local file problems no retry can fix fail a queued notify; resource exhaustion and I/O hiccups are retried;
// fails_when=EMFILE/ENFILE/EIO/EBUSY drop the user's message, or EACCES/EPERM/EISDIR/a directory retry forever;
// no_claim=which errno a given filesystem returns
test("localFileProblem: EACCES/EPERM/EISDIR/not a file are terminal, ENOENT is missing, anything else is transient", async () => {
  const errno = (code: string) => Object.assign(new Error(`${code}: boom`), { code });
  const fileStat = async () => ({ isFile: () => true }) as never;
  const failOpen = (code: string) => ({ stat: fileStat, open: (async () => { throw errno(code); }) as never });
  for (const code of ["EACCES", "EPERM", "EISDIR"]) assert.equal((await localFileProblem("/f", failOpen(code)))?.kind, "terminal", code);
  for (const code of ["EMFILE", "ENFILE", "EIO", "EBUSY", "EAGAIN"]) assert.equal((await localFileProblem("/f", failOpen(code)))?.kind, "transient", code);
  assert.equal((await localFileProblem("/f", failOpen("ENOENT")))?.kind, "missing");
  const dir = { stat: (async () => ({ isFile: () => false })) as never, open: (async () => assert.fail("not opened")) as never };
  assert.equal((await localFileProblem("/d", dir))?.kind, "terminal");
  const statFails = { stat: (async () => { throw errno("EMFILE"); }) as never, open: (async () => assert.fail("not opened")) as never };
  assert.equal((await localFileProblem("/f", statFails))?.kind, "transient");
  assert.equal(await localFileProblem("/f", { stat: fileStat, open: (async () => ({ close: async () => {} })) as never }), undefined);
});
