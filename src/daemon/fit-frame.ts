import { encode, MAX_FRAME_BYTES, type Envelope } from "@brain-boost-academy/agent-protocol";

/** Frames we send stay this far under MAX_FRAME_BYTES. */
export const FRAME_LIMIT = MAX_FRAME_BYTES - 4096;

/** Strings shorter than this are never cut (ids, paths, titles). */
const KEEP_MIN = 512;

type Obj = Record<string, unknown>;

/** One shortenable string field: `tail` keeps the end (running text), otherwise the start. */
type Slot = { obj: Obj; key: string; tail: boolean; orig: string; origBytes: number; kept: number };

const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** `obj` is an object or an array (then `key` is the index). */
function slot(slots: Slot[], obj: unknown, key: string, tail = false): void {
  if (!isObj(obj) && !Array.isArray(obj)) return;
  const v = (obj as Obj)[key];
  if (typeof v === "string" && v.length > KEEP_MIN) slots.push({ obj: obj as Obj, key, tail, orig: v, origBytes: Buffer.byteLength(v, "utf8"), kept: v.length });
}

/** Every long string inside an arbitrary JSON value (tool rawInput / rawOutput). */
function leaves(slots: Slot[], v: unknown, depth = 0): void {
  if (depth > 32) return;
  if (Array.isArray(v)) {
    v.forEach((x, i) => (typeof x === "string" ? slot(slots, v, String(i)) : leaves(slots, x, depth + 1)));
  } else if (isObj(v)) {
    for (const k of Object.keys(v)) typeof v[k] === "string" ? slot(slots, v, k) : leaves(slots, v[k], depth + 1);
  }
}

/** ACP ToolCall / ToolCallUpdate: rawInput, rawOutput, content[] text and diff texts. */
function toolCall(slots: Slot[], tc: unknown): void {
  if (!isObj(tc)) return;
  for (const k of ["rawInput", "rawOutput"]) typeof tc[k] === "string" ? slot(slots, tc, k) : leaves(slots, tc[k]);
  if (!Array.isArray(tc.content)) return;
  for (const c of tc.content) {
    if (!isObj(c)) continue;
    if (c.type === "diff") {
      slot(slots, c, "oldText");
      slot(slots, c, "newText");
    } else if (c.type === "content") slot(slots, c.content, "text");
  }
}

/** ACP SessionUpdate: tool calls and message chunks. */
function sessionUpdate(slots: Slot[], u: unknown): void {
  if (!isObj(u)) return;
  if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") toolCall(slots, u);
  else slot(slots, u.content, "text");
}

function collect(type: string, p: Obj): Slot[] {
  const slots: Slot[] = [];
  switch (type) {
    case "session.update":
      sessionUpdate(slots, p.update);
      break;
    case "permission.request":
      toolCall(slots, (p.params as Obj | undefined)?.toolCall);
      break;
    case "elicitation.request":
      slot(slots, p.params, "message");
      break;
    case "sync":
      for (const t of (p.running_turns as unknown[]) ?? []) slot(slots, t, "text_so_far", true);
      for (const x of (p.pending as unknown[]) ?? []) {
        if (!isObj(x) || !isObj(x.params)) continue;
        if (x.kind === "permission") toolCall(slots, x.params.toolCall);
        else slot(slots, x.params, "message");
      }
      break;
    case "session.attach.result":
      slot(slots, p, "last_assistant_text", true);
      break;
    case "turn.ended":
      slot(slots, p, "text", true);
      break;
    case "turn.error":
    case "notify":
      slot(slots, p, type === "notify" ? "text" : "message");
      break;
  }
  return slots;
}

const marker = (bytes: number) => `…[truncated ${bytes} bytes]`;

/** Cut a slot so that its JSON form shrinks by about `over` bytes; false when it is already minimal. */
function shrink(s: Slot, over: number): boolean {
  if (s.kept <= KEEP_MIN) return false;
  const cur = s.obj[s.key] as string;
  const jsonBytes = Buffer.byteLength(JSON.stringify(cur), "utf8");
  // bytes per kept char of the original (escapes, multi-byte), to turn a byte budget into a length
  const keptJson = Buffer.byteLength(JSON.stringify(s.tail ? s.orig.slice(s.orig.length - s.kept) : s.orig.slice(0, s.kept)), "utf8");
  const perChar = keptJson / s.kept;
  const target = jsonBytes - over - 64;
  let keep = Math.max(KEEP_MIN, Math.min(s.kept - 1, Math.floor(target / perChar)));
  let kept = s.tail ? s.orig.slice(s.orig.length - keep) : s.orig.slice(0, keep);
  // never split a surrogate pair
  if (s.tail && /^[\udc00-\udfff]/.test(kept)) kept = kept.slice(1);
  if (!s.tail && /[\ud800-\udbff]$/.test(kept)) kept = kept.slice(0, -1);
  keep = kept.length;
  s.kept = keep;
  const cut = marker(s.origBytes - Buffer.byteLength(kept, "utf8"));
  s.obj[s.key] = s.tail ? cut + kept : kept + cut;
  return true;
}

/**
 * Keep a connector→gateway frame under the frame limit by shortening embedded ACP fields
 * (largest first). Returns the original envelope when it already fits, otherwise a shortened
 * copy; `fits: false` when even the shortened frame is too large (the caller drops it).
 */
export function fitEnvelope<E extends Envelope>(env: E, limit = FRAME_LIMIT): { env: E; fits: boolean; truncated: number } {
  let size = Buffer.byteLength(encode(env), "utf8");
  if (size <= limit) return { env, fits: true, truncated: 0 };
  const out = { ...env, payload: structuredClone(env.payload) } as E;
  const slots = collect(env.type, out.payload as Obj);
  const before = size;
  for (let i = 0; i < 64 && size > limit; i++) {
    const s = slots
      .filter((x) => x.kept > KEEP_MIN)
      .sort((a, b) => (b.obj[b.key] as string).length - (a.obj[a.key] as string).length)[0];
    if (!s || !shrink(s, size - limit)) break;
    size = Buffer.byteLength(encode(out), "utf8");
  }
  return { env: out, fits: size <= limit, truncated: before - size };
}
