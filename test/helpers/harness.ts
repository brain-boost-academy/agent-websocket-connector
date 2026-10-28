// In-process daemon with temp dirs, a fake ACP agent and fake gateways.
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeConfig, type LifecycleConfig } from "../../src/daemon/config.ts";
import { Daemon } from "../../src/daemon/daemon.ts";
import type { LinkTimings } from "../../src/daemon/gateway-link.ts";
import { createLogger } from "../../src/log.ts";
import type { FakeGateway } from "./fake-gateway.ts";

process.env.AGENT_CONNECTOR_LOG ??= "warn";

export const FAKE_AGENT = fileURLToPath(new URL("../fixtures/fake-agent.ts", import.meta.url));

export const FAST_LINK: Partial<LinkTimings> = {
  pingIntervalMs: 60_000,
  backoff: { baseMs: 50, maxMs: 200, jitter: 0 },
  unauthorizedRetryMs: 1500,
  stableMs: 60_000,
  welcomeTimeoutMs: 5000,
};

export type Harness = {
  daemon: Daemon;
  dir: string;
  socket: string;
  workDir: string;
  claudeDir: string;
  agentLog: () => Array<{ m: string; sessionId?: string; [k: string]: unknown }>;
  restart: () => Promise<Daemon>;
  /** Shift the daemon's lifecycle clock forward. */
  advance: (ms: number) => void;
  stop: () => Promise<void>;
};

export async function startHarness(
  gateways: Array<{ name: string; gw: FakeGateway }>,
  o: {
    lifecycle?: Partial<LifecycleConfig>;
    link?: Partial<LinkTimings>;
    deliveryWaitMs?: number;
    tickMs?: number;
    permission_timeout_s?: number;
    dir?: string;
    /** Replace the fake agent (adapter tests). */
    agents?: Record<string, unknown>;
    /** Extra env for the fake agent (e.g. FAKE_AGENT_CLOSE_DELAY_MS). */
    agentEnv?: Record<string, string>;
    default_agent?: string;
  } = {},
): Promise<Harness> {
  const dir = o.dir ?? mkdtempSync(join(tmpdir(), "acn-"));
  const workDir = join(dir, "work");
  const claudeDir = join(dir, "claude");
  const agentLogPath = join(dir, "agent.log");
  const raw = {
    cwd: workDir,
    default_agent: o.default_agent ?? "fake",
    agents: o.agents ?? {
      fake: {
        command: process.execPath,
        args: [FAKE_AGENT],
        env: { FAKE_AGENT_STATE: join(dir, "agent-state"), FAKE_AGENT_LOG: agentLogPath, CLAUDE_CONFIG_DIR: claudeDir, ...o.agentEnv },
        title: "Fake agent",
        kind: "claude",
      },
    },
    gateways: gateways.map(({ name, gw }) => {
      const tokenFile = join(dir, `${name}.token`);
      writeFileSync(tokenFile, gw.token + "\n", { mode: 0o600 });
      return { name, url: gw.url, token_file: tokenFile };
    }),
    permission_timeout_s: o.permission_timeout_s ?? 1800,
    session_lifecycle: o.lifecycle ?? {},
  };
  const config = normalizeConfig(raw);
  const socket = join(dir, "c.sock");
  let offset = 0;
  const make = () =>
    new Daemon({
      config,
      stateDir: join(dir, "state"),
      socketPath: socket,
      linkTimings: { ...FAST_LINK, ...o.link },
      agentBackoff: { baseMs: 50, maxMs: 200, jitter: 0 },
      tickMs: o.tickMs ?? 60_000,
      deliveryWaitMs: o.deliveryWaitMs ?? 3000,
      log: createLogger("test"),
      now: () => Date.now() + offset,
    });
  let daemon = make();
  await daemon.start();
  const h: Harness = {
    daemon,
    dir,
    socket,
    workDir,
    claudeDir,
    agentLog: () => (existsSync(agentLogPath) ? readFileSync(agentLogPath, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []),
    restart: async () => {
      await daemon.stop();
      daemon = make();
      h.daemon = daemon;
      await daemon.start();
      return daemon;
    },
    stop: async () => {
      await daemon.stop();
      if (!o.dir) rmSync(dir, { recursive: true, force: true });
    },
    advance: (ms) => {
      offset += ms;
    },
  };
  return h;
}

export function waitUntil(pred: () => boolean, timeoutMs = 5000, what = "condition"): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (pred()) {
        clearInterval(iv);
        resolve();
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(iv);
        reject(new Error(`timed out waiting for ${what}`));
      }
    }, 10);
  });
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
