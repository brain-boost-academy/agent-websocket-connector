// Fake ACP agent for integration tests, built on the SDK's AgentSideConnection.
// Scenario is chosen by markers in the prompt text: [crash] [permission] [elicit] [slow] [tools] [background], plus [cfg-mode:<id>] (combinable);
// anything else streams "echo: <text>" in chunks. Sessions persist in $FAKE_AGENT_STATE so a
// restarted process can load them; every ACP call is appended to $FAKE_AGENT_LOG.
// With $CLAUDE_CONFIG_DIR set it also writes a Claude-style jsonl transcript per session.
// With FAKE_AGENT_CONFIG_MODES=1 modes come as a grouped "mode" select in configOptions (like opencode v2)
// and are set with session/set_config_option; session/set_mode is then not supported.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";

type Hist = { role: "user" | "agent"; text: string };
type Sess = { cwd: string; title: string | null; updatedAt: string; history: Hist[]; mode: string };

const stateDir = process.env.FAKE_AGENT_STATE!;
const logPath = process.env.FAKE_AGENT_LOG;
const claudeDir = process.env.CLAUDE_CONFIG_DIR;
mkdirSync(stateDir, { recursive: true });
const dbPath = join(stateDir, "sessions.json");
const db: Record<string, Sess> = existsSync(dbPath) ? JSON.parse(readFileSync(dbPath, "utf8")) : {};
const save = () => writeFileSync(dbPath, JSON.stringify(db));
const log = (m: string, extra: object = {}) => logPath && appendFileSync(logPath, JSON.stringify({ m, pid: process.pid, ...extra }) + "\n");
const open = new Set<string>();
const active = new Map<string, () => void>();

function transcript(id: string, s: Sess, line: object): void {
  if (!claudeDir) return;
  const dir = join(claudeDir, "projects", s.cwd.replace(/[^a-zA-Z0-9]/g, "-"));
  mkdirSync(dir, { recursive: true });
  appendFileSync(join(dir, `${id}.jsonl`), JSON.stringify(line) + "\n");
}

const closeDelayMs = Number(process.env.FAKE_AGENT_CLOSE_DELAY_MS ?? 0);
const MODES = { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const CONFIG_MODES = process.env.FAKE_AGENT_CONFIG_MODES === "1";
const modeConfig = (current: string): acp.SessionConfigOption[] => [
  { id: "model", name: "Model", category: "model", type: "select", currentValue: "m1", options: [{ value: "m1", name: "M1" }] },
  {
    id: "mode", name: "Mode", category: "mode", type: "select", currentValue: current,
    options: [{ group: "primary", name: "Primary", options: [{ value: "default", name: "Default" }] }, { group: "extra", name: "Extra", options: [{ value: "plan", name: "Plan" }] }],
  },
];
const sessionModes = () => (CONFIG_MODES ? { configOptions: modeConfig("default") } : { modes: MODES });

const stream = acp.ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>, Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>);

new acp.AgentSideConnection((conn) => {
  const chunk = (sessionId: string, text: string) => conn.sessionUpdate({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  return {
    async initialize(p) {
      log("initialize", { caps: p.clientCapabilities });
      return {
        protocolVersion: acp.PROTOCOL_VERSION,
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, close: {} } },
      };
    },
    async authenticate() {},
    async newSession(p) {
      const id = randomUUID();
      db[id] = { cwd: p.cwd, title: null, updatedAt: new Date().toISOString(), history: [], mode: "default" };
      save();
      open.add(id);
      log("newSession", { sessionId: id, cwd: p.cwd, mcpServers: p.mcpServers });
      return { sessionId: id, ...sessionModes() };
    },
    async loadSession(p) {
      const s = db[p.sessionId];
      log("loadSession", { sessionId: p.sessionId, cwd: p.cwd });
      if (!s) throw acp.RequestError.resourceNotFound(p.sessionId);
      for (const h of s.history) {
        await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: h.role === "user" ? "user_message_chunk" : "agent_message_chunk", content: { type: "text", text: h.text } } });
      }
      open.add(p.sessionId);
      setTimeout(() => void conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "available_commands_update", availableCommands: [] } }), 5);
      return sessionModes(); // like a fresh process: the mode is not remembered across load
    },
    async listSessions(p) {
      log("listSessions", { cwd: p.cwd });
      const sessions = Object.entries(db)
        .filter(([, s]) => !p.cwd || s.cwd === p.cwd)
        .map(([sessionId, s]) => ({ sessionId, cwd: s.cwd, title: s.title, updatedAt: s.updatedAt }));
      return { sessions };
    },
    async closeSession(p) {
      log("closeSession", { sessionId: p.sessionId });
      if (closeDelayMs) await sleep(closeDelayMs); // a slow close: a load arriving meanwhile must not be undone
      open.delete(p.sessionId);
      log("closeSession.done", { sessionId: p.sessionId });
      return {};
    },
    async setSessionConfigOption(p) {
      log("setSessionConfigOption", { sessionId: p.sessionId, configId: p.configId, value: p.value });
      if (!CONFIG_MODES || p.configId !== "mode" || !MODES.availableModes.some((m) => m.id === p.value)) throw acp.RequestError.invalidParams({ configId: p.configId, value: p.value });
      const s = db[p.sessionId];
      if (s) {
        s.mode = String(p.value);
        save();
      }
      return { configOptions: modeConfig(String(p.value)) };
    },
    async setSessionMode(p) {
      log("setSessionMode", { sessionId: p.sessionId, modeId: p.modeId });
      if (CONFIG_MODES) throw acp.RequestError.methodNotFound("session/set_mode");
      if (!MODES.availableModes.some((m) => m.id === p.modeId)) throw acp.RequestError.invalidParams({ modeId: p.modeId });
      const s = db[p.sessionId];
      if (s) {
        s.mode = p.modeId;
        save();
      }
      await conn.sessionUpdate({ sessionId: p.sessionId, update: { sessionUpdate: "current_mode_update", currentModeId: p.modeId } });
      return {};
    },
    async cancel(p) {
      log("cancel", { sessionId: p.sessionId });
      active.get(p.sessionId)?.();
    },
    async prompt(p) {
      const id = p.sessionId;
      const s = db[id];
      if (!s || !open.has(id)) throw acp.RequestError.resourceNotFound(id);
      const text = p.prompt.map((b) => (b.type === "text" ? b.text : `<${b.type}${b.type === "resource_link" ? ` ${b.uri}` : ""}${b.type === "image" ? ` ${b.mimeType}` : ""}>`)).join(" | ");
      log("prompt", { sessionId: id, text, blocks: p.prompt.map((b) => b.type) });
      s.history.push({ role: "user", text });
      s.title ??= text.slice(0, 40);
      transcript(id, s, { type: "user", text });
      let cancelled = false;
      const cancelledP = new Promise<void>((r) => active.set(id, () => {
        cancelled = true;
        r();
      }));
      let reply = "";
      const say = async (t: string) => {
        reply += t;
        await chunk(id, t);
      };
      try {
        // the agent switches the mode itself; without FAKE_AGENT_CONFIG_MODES it reports it both ways, like claude-agent-acp
        const cfgMode = /\[cfg-mode:(\w+)\]/.exec(text)?.[1];
        if (cfgMode) {
          if (!CONFIG_MODES) await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "current_mode_update", currentModeId: cfgMode } });
          await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "config_option_update", configOptions: modeConfig(cfgMode) } });
        }
        if (text.includes("[crash]")) {
          await say("about to crash");
          await sleep(50);
          process.exit(3);
        } else if (text.includes("[permission]")) {
          const r = await conn.requestPermission({
            sessionId: id,
            toolCall: { toolCallId: "tc-perm", title: "rm -rf build", kind: "execute", status: "pending" },
            options: [
              { optionId: "allow-once", kind: "allow_once", name: "Yes" },
              { optionId: "reject", kind: "reject_once", name: "No" },
            ],
          });
          if (r.outcome.outcome === "cancelled") cancelled = true;
          await say(`permission: ${JSON.stringify(r.outcome)}`);
        } else if (text.includes("[elicit]")) {
          const r = await conn.createElicitation({
            sessionId: id,
            mode: "form",
            message: "Pick a color",
            requestedSchema: {
              type: "object",
              properties: {
                question_0: { type: "string", title: "Color", oneOf: [{ const: "red", title: "red" }, { const: "green", title: "green" }, { const: "blue", title: "blue" }] },
                question_0_custom: { type: "string", title: "Other" },
              },
            },
          } as acp.CreateElicitationRequest);
          if (r.action === "cancel") cancelled = true;
          await say(`elicitation: ${JSON.stringify(r)}`);
        } else if (text.includes("[slow]")) {
          await say("working");
          await Promise.race([cancelledP, sleep(20_000)]);
        } else {
          if (text.includes("[background]")) {
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call", toolCallId: "bg1", title: "Terminal", kind: "execute", status: "pending", rawInput: {} } });
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call_update", toolCallId: "bg1", rawInput: { command: "sleep 60", run_in_background: true } } });
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call_update", toolCallId: "bg1", status: "completed" } });
          }
          if (text.includes("[tools]")) {
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call", toolCallId: "t1", title: "Read file", kind: "read", status: "in_progress" } });
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed" } });
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call", toolCallId: "t2", title: "Edit file", kind: "edit", status: "in_progress" } });
            await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "tool_call_update", toolCallId: "t2", status: "completed" } });
          }
          const words = `echo: ${text}`.match(/.{1,12}/gs) ?? [];
          for (const w of words) await say(w);
          await conn.sessionUpdate({ sessionId: id, update: { sessionUpdate: "usage_update", used: 100, size: 1000, cost: { amount: 0.0123, currency: "USD" } } });
        }
      } finally {
        active.delete(id);
      }
      s.history.push({ role: "agent", text: reply });
      s.updatedAt = new Date().toISOString();
      save();
      transcript(id, s, { type: "assistant", text: reply });
      return { stopReason: cancelled ? "cancelled" : "end_turn" };
    },
  };
}, stream);
