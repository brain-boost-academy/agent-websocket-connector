import type { ContentBlock } from "@agentclientprotocol/sdk";

export type Target = { gateway: string; conversation_id: string };

export type Upload = { path: string; name: string; mime: string; size: number };

export type QueuedPrompt = {
  text: string;
  origin: "text" | "voice" | "agent";
  uploads: Upload[];
  from: Target;
};

export type MergedPrompt = { text: string; origin: QueuedPrompt["origin"]; uploads: Upload[]; from: Target[] };

/** Consecutive queued prompts are merged into one (routing semantics). */
export function mergePrompts(items: QueuedPrompt[]): MergedPrompt {
  if (items.length === 0) throw new Error("nothing to merge");
  const from: Target[] = [];
  for (const i of items) {
    if (!from.some((t) => t.gateway === i.from.gateway && t.conversation_id === i.from.conversation_id)) from.push(i.from);
  }
  return {
    text: items.map((i) => i.text).filter((t) => t.length > 0).join("\n\n"),
    origin: items[0]!.origin,
    uploads: items.flatMap((i) => i.uploads),
    from,
  };
}

/**
 * Flow 4: text + "Файл сохранён: <path>" per upload, an image block for images when the agent
 * accepts images, and a resource_link for every file.
 */
export async function buildPromptBlocks(
  p: MergedPrompt,
  opts: { images: boolean; readFile: (path: string) => Promise<Buffer> },
): Promise<ContentBlock[]> {
  const lines = p.uploads.map((u) => `Файл сохранён: ${u.path}`);
  const text = [p.text, ...lines].filter((t) => t.length > 0).join("\n");
  const blocks: ContentBlock[] = [{ type: "text", text }];
  for (const u of p.uploads) {
    if (opts.images && u.mime.startsWith("image/")) {
      blocks.push({ type: "image", mimeType: u.mime, data: (await opts.readFile(u.path)).toString("base64") });
    }
    blocks.push({ type: "resource_link", uri: `file://${u.path}`, name: u.name, mimeType: u.mime, size: u.size });
  }
  return blocks;
}
