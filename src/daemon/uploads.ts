import { constants } from "node:fs";
import { copyFile, link, mkdir, rm } from "node:fs/promises";
import { extname, join } from "node:path";

/** Keep a file name safe for the uploads dir: no path parts, no control chars, bounded length. */
export function sanitizeName(name: string): string {
  let n = name.split(/[\\/]/).pop() ?? "";
  n = n.replace(/[\x00-\x1f\x7f]/g, "").replace(/^\.+/, "").trim();
  if (n.length > 200) {
    const ext = extname(n).slice(0, 20);
    n = n.slice(0, 200 - ext.length) + ext;
  }
  return n || "file";
}

/** `name`, `name-1.ext`, `name-2.ext`, ... (suffix before the extension). */
export function candidateName(name: string, n: number): string {
  if (n === 0) return name;
  const ext = extname(name);
  const stem = ext && ext !== name ? name.slice(0, -ext.length) : name;
  return `${stem}-${n}${ext && ext !== name ? ext : ""}`;
}

export function dateDir(now: Date): string {
  const p = (x: number) => String(x).padStart(2, "0");
  return `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}`;
}

/**
 * Flow 4 / D14: move a received blob to <uploads_dir>/YYYY-MM-DD/<name> without overwriting
 * anything. Returns the final absolute path.
 */
export async function storeUpload(src: string, uploadsDir: string, name: string, now = new Date()): Promise<string> {
  const dir = join(uploadsDir, dateDir(now));
  await mkdir(dir, { recursive: true });
  const safe = sanitizeName(name);
  for (let n = 0; n < 10_000; n++) {
    const dst = join(dir, candidateName(safe, n));
    try {
      await link(src, dst); // fails with EEXIST instead of overwriting
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") continue;
      if (code !== "EXDEV" && code !== "EPERM") throw err;
      try {
        await copyFile(src, dst, constants.COPYFILE_EXCL);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
    }
    await rm(src, { force: true });
    return dst;
  }
  throw new Error(`no free name for ${safe} in ${dir}`);
}
