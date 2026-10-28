import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type TranscriptStat = { mtimeMs: number; size: number };

/** Claude Code keeps transcripts in ~/.claude/projects/<cwd with every non-alphanumeric char → "-">/<id>.jsonl. */
export function claudeTranscriptPath(session_id: string, cwd: string, claudeDir = join(homedir(), ".claude")): string {
  return join(claudeDir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${session_id}.jsonl`);
}

export async function statTranscript(path: string | undefined): Promise<TranscriptStat | undefined> {
  if (!path) return undefined;
  try {
    const s = await stat(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return undefined;
  }
}

/** R13: the transcript changed since we last saw it (someone else wrote to the session). */
export function transcriptChanged(seen: TranscriptStat | undefined, now: TranscriptStat | undefined): boolean {
  if (!seen || !now) return false;
  return seen.mtimeMs !== now.mtimeMs || seen.size !== now.size;
}
