import { z } from "zod";
import { Payloads, type MessageType, type PayloadOf } from "./messages.ts";
import { uuidv7 } from "./uuid.ts";

export const PROTOCOL_VERSION = 1;
export const MAX_FRAME_BYTES = 1024 * 1024;
/** Raw bytes per blob.chunk before base64. */
export const BLOB_CHUNK_BYTES = 512 * 1024;
export const REQUEST_TIMEOUT_MS = 30_000;

export type Envelope<T extends MessageType = MessageType> = {
  v: 1;
  id: string;
  type: T;
  ts: string;
  re?: string;
  payload: PayloadOf<T>;
};

export type AnyEnvelope = { [T in MessageType]: Envelope<T> }[MessageType];

const EnvelopeHead = z.object({
  v: z.literal(1),
  id: z.string().min(1).max(128),
  type: z.string().min(1),
  ts: z.string().min(1),
  re: z.string().min(1).max(128).optional(),
  payload: z.unknown(),
});

export function makeEnvelope<T extends MessageType>(
  type: T,
  payload: PayloadOf<T>,
  opts: { id?: string; re?: string } = {},
): Envelope<T> {
  const env: Envelope<T> = { v: 1, id: opts.id ?? uuidv7(), type, ts: new Date().toISOString(), payload };
  if (opts.re) env.re = opts.re;
  return env;
}

export function encode(env: Envelope): string {
  return JSON.stringify(env);
}

export type DecodeResult =
  | { ok: true; env: AnyEnvelope }
  | { ok: false; id?: string; code: "invalid_message" | "too_large"; message: string };

/** Parse and validate one text frame. Never throws. */
export function decode(raw: string | Buffer | ArrayBuffer | Buffer[]): DecodeResult {
  const text = typeof raw === "string" ? raw : Buffer.isBuffer(raw) ? raw.toString("utf8") : Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw).toString("utf8");
  if (Buffer.byteLength(text, "utf8") > MAX_FRAME_BYTES) {
    return { ok: false, code: "too_large", message: `frame exceeds ${MAX_FRAME_BYTES} bytes` };
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, code: "invalid_message", message: "not JSON" };
  }
  const head = EnvelopeHead.safeParse(json);
  if (!head.success) {
    const id = typeof (json as { id?: unknown })?.id === "string" ? (json as { id: string }).id : undefined;
    return { ok: false, id, code: "invalid_message", message: `bad envelope: ${z.prettifyError(head.error)}` };
  }
  const { type } = head.data;
  if (!Object.hasOwn(Payloads, type)) {
    return { ok: false, id: head.data.id, code: "invalid_message", message: `unknown type ${type}` };
  }
  const schema = Payloads[type as MessageType];
  const payload = schema.safeParse(head.data.payload);
  if (!payload.success) {
    return { ok: false, id: head.data.id, code: "invalid_message", message: `bad ${type} payload: ${z.prettifyError(payload.error)}` };
  }
  return { ok: true, env: { ...head.data, payload: payload.data } as AnyEnvelope };
}

export class ProtocolError extends Error {
  readonly code: PayloadOf<"error">["code"];
  readonly details?: unknown;
  constructor(code: PayloadOf<"error">["code"], message: string, details?: unknown) {
    super(message);
    this.name = "ProtocolError";
    this.code = code;
    this.details = details;
  }
}

export function errorEnvelope(err: unknown, re?: string): Envelope<"error"> {
  const pe = err instanceof ProtocolError ? err : new ProtocolError("internal", err instanceof Error ? err.message : String(err));
  const payload: PayloadOf<"error"> = { code: pe.code, message: pe.message };
  if (pe.details !== undefined) payload.details = pe.details;
  return makeEnvelope("error", payload, re ? { re } : {});
}
