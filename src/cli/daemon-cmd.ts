import { configPath, loadConfig, socketPath, stateDir } from "../daemon/config.ts";
import { Daemon } from "../daemon/daemon.ts";
import { createLogger } from "../log.ts";

export async function runDaemon(): Promise<void> {
  const log = createLogger();
  const { config, path, exists } = loadConfig(configPath());
  if (!exists) log.warn(`no config at ${path}; running with defaults and no gateways`);
  const daemon = new Daemon({ config, stateDir: stateDir(), socketPath: socketPath(), configPath: path, log });
  await daemon.start();
  let stopping = false;
  const stop = (sig: string) => {
    if (stopping) return;
    stopping = true;
    log.info(`${sig}: stopping`);
    daemon.stop().then(
      () => process.exit(0),
      (e) => {
        log.error("stop failed", e);
        process.exit(1);
      },
    );
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
}
