const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 } as const;
export type Level = keyof typeof LEVELS;

export interface Logger {
  debug(msg: string, data?: unknown): void;
  info(msg: string, data?: unknown): void;
  warn(msg: string, data?: unknown): void;
  error(msg: string, data?: unknown): void;
  child(scope: string): Logger;
}

function threshold(): number {
  const env = (process.env.AGENT_CONNECTOR_LOG ?? "info") as Level;
  return LEVELS[env] ?? LEVELS.info;
}

function fmt(data: unknown): string {
  if (data === undefined) return "";
  if (data instanceof Error) return ` ${data.message}`;
  try {
    return " " + JSON.stringify(data, (_k, v) => (v instanceof Error ? v.message : v));
  } catch {
    return " " + String(data);
  }
}

/** Line logger to stderr (journald picks it up under systemd). */
export function createLogger(scope = "connector"): Logger {
  const write = (level: Exclude<Level, "silent">, msg: string, data?: unknown) => {
    if (LEVELS[level] < threshold()) return;
    process.stderr.write(`${new Date().toISOString()} ${level.toUpperCase()} [${scope}] ${msg}${fmt(data)}\n`);
  };
  return {
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
    child: (s) => createLogger(`${scope}:${s}`),
  };
}
