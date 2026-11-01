import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Connector version from the root package.json (works from src/ and dist/). */
export const CONNECTOR_VERSION: string = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

/** Root of the installed package (contains integrations/). */
export const PACKAGE_ROOT: string = fileURLToPath(new URL("..", import.meta.url));
