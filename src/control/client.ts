import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { socketPath } from "../daemon/config.ts";
import { ControlError } from "./server.ts";

export class DaemonNotRunning extends Error {
  constructor(path: string, cause: string) {
    super(`agent-connector daemon is not running (cannot connect to ${path}: ${cause}). Start it with \`systemctl --user start agent-connector\` or \`agent-connector daemon\`.`);
    this.name = "DaemonNotRunning";
  }
}

/** One JSON-RPC call to the daemon's control socket. */
export function callControl<T = unknown>(method: string, params: object = {}, opts: { path?: string; timeoutMs?: number } = {}): Promise<T> {
  const path = opts.path ?? socketPath();
  return new Promise<T>((resolve, reject) => {
    const sock = createConnection(path);
    let connected = false;
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new ControlError("timeout", `daemon did not answer ${method} in ${opts.timeoutMs ?? 60_000} ms`));
    }, opts.timeoutMs ?? 60_000);
    sock.once("error", (err) => {
      clearTimeout(timer);
      reject(connected ? err : new DaemonNotRunning(path, (err as NodeJS.ErrnoException).code ?? err.message));
    });
    sock.once("connect", () => {
      connected = true;
      const rl = createInterface({ input: sock });
      rl.on("error", () => {});
      rl.once("line", (line) => onLine(line));
      sock.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) + "\n");
    });
    sock.once("close", () => {
      clearTimeout(timer);
      reject(new ControlError("internal", `daemon closed the connection during ${method}`));
    });
    const onLine = (line: string) => {
      clearTimeout(timer);
      sock.end();
      try {
        const res = JSON.parse(line) as { result?: T; error?: { message: string; data?: { code?: string; details?: unknown } } };
        if (res.error) reject(new ControlError(res.error.data?.code ?? "internal", res.error.message, res.error.data?.details));
        else resolve(res.result as T);
      } catch (err) {
        reject(err);
      }
    };
  });
}
