import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import type { Logger } from "../log.ts";

/** Error with a machine-readable code (e.g. not_paired, too_large) for control clients. */
export class ControlError extends Error {
  readonly code: string;
  readonly data: unknown;
  constructor(code: string, message: string, data?: unknown) {
    super(message);
    this.name = "ControlError";
    this.code = code;
    this.data = data;
  }
}

export type Methods = Record<string, (params: Record<string, unknown>) => Promise<unknown>>;

type RpcRequest = { jsonrpc?: string; id?: string | number | null; method?: unknown; params?: unknown };

/** Newline-delimited JSON-RPC 2.0 over a 0600 unix socket (CLI, MCP server, hooks). */
export class ControlServer {
  #server: Server | undefined;
  #path: string;
  #methods: Methods;
  #log: Logger;
  #sockets = new Set<Socket>();

  constructor(path: string, methods: Methods, log: Logger) {
    this.#path = path;
    this.#methods = methods;
    this.#log = log.child("control");
  }

  async listen(): Promise<void> {
    if (await isAlive(this.#path)) throw new Error(`another agent-connector daemon is listening on ${this.#path}`);
    rmSync(this.#path, { force: true });
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const server = createServer((sock) => this.#onSocket(sock));
    const oldUmask = process.umask(0o177);
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.#path, () => resolve());
      });
    } finally {
      process.umask(oldUmask);
    }
    chmodSync(this.#path, 0o600);
    this.#server = server;
    this.#log.info("control socket listening", { path: this.#path });
  }

  async close(): Promise<void> {
    for (const s of this.#sockets) s.destroy();
    await new Promise<void>((r) => (this.#server ? this.#server.close(() => r()) : r()));
    rmSync(this.#path, { force: true });
  }

  #onSocket(sock: Socket): void {
    this.#sockets.add(sock);
    sock.on("close", () => this.#sockets.delete(sock));
    sock.on("error", () => {});
    const rl = createInterface({ input: sock });
    rl.on("error", () => {}); // readline re-emits socket errors (EPIPE when a client went away)
    rl.on("line", (line) => {
      if (!line.trim()) return;
      void this.#handle(line).then((res) => {
        if (res && !sock.destroyed) sock.write(JSON.stringify(res) + "\n");
      });
    });
  }

  async #handle(line: string): Promise<object | undefined> {
    let req: RpcRequest;
    try {
      req = JSON.parse(line) as RpcRequest;
    } catch {
      return { jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } };
    }
    const id = req.id ?? null;
    const fn = typeof req.method === "string" && Object.hasOwn(this.#methods, req.method) ? this.#methods[req.method] : undefined;
    if (!fn) return { jsonrpc: "2.0", id, error: { code: -32601, message: `unknown method ${String(req.method)}` } };
    try {
      const params = req.params && typeof req.params === "object" ? (req.params as Record<string, unknown>) : {};
      const result = await fn(params);
      return { jsonrpc: "2.0", id, result: result ?? null };
    } catch (err) {
      const code = err instanceof ControlError ? err.code : "internal";
      if (!(err instanceof ControlError)) this.#log.warn(`${String(req.method)} failed`, err);
      const data: Record<string, unknown> = { code };
      if (err instanceof ControlError && err.data !== undefined) data.details = err.data;
      return { jsonrpc: "2.0", id, error: { code: -32000, message: (err as Error).message, data } };
    }
  }
}

function isAlive(path: string): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.destroy();
      resolve(true);
    });
    s.once("error", () => resolve(false));
  });
}
