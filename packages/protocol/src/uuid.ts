import { randomBytes } from "node:crypto";

let lastMs = 0;
let seq = 0;

/** RFC 9562 UUIDv7: 48-bit ms timestamp, monotonic within a process. */
export function uuidv7(): string {
  let ms = Date.now();
  if (ms <= lastMs) {
    seq = (seq + 1) & 0xfff;
    if (seq === 0) lastMs += 1;
    ms = lastMs;
  } else {
    lastMs = ms;
    seq = randomBytes(2).readUInt16BE(0) & 0x7ff;
  }
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((seq >> 8) & 0x0f);
  b[7] = seq & 0xff;
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
