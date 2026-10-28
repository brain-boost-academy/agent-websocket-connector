# Changelog

## 1.2.0

- `blob_id` must be a lowercase uuid (blob.begin/chunk/end/stored). `BlobReceiver` rejects other ids, duplicate ids and more than `maxOpen` (16) open blobs (`internal`, retryable); stored blobs nobody takes are deleted after `doneTtlMs` (30 min) and `wasExpired(blob_id)` tells a late reference (answer `internal`, the sender re-sends fresh blobs) from an unknown id. Breaking for senders that used free-form ids; the bundled helpers always used uuidv7.
- `notify` carries at most 10 files (the connector's `send_message` rejects more with `too_large`).
- `turn.error` is durable (key `turn:<turn_id>`, shared with `turn.ended`).
- Delivery rules: gateway answers an undeliverable durable with `error internal` (retry) or a terminal code; connector retries while the link is up; gateway closes turns missing from `sync`; gateway re-sends answers to requests still pending after a reconnect.
- Frames stay under `MAX_FRAME_BYTES`; slow requests (`conversation.prompt`, `session.new`, `session.attach`) get 120 s.
- `Peer.sendWritten()` (resolves when the frame is written) and `Peer.queuedBulk`; blob senders keep at most 2 chunk frames pending instead of queueing the whole file.

## 1.1.0

- `session.state.busy_reason?: "turn" | "foreign"` and `prompt.accepted.waiting_foreign?` so a gateway can say the agent is busy in the background (Flow 9). Optional, backward compatible.
- `Peer.handleResponse` returns false for an `error` frame that matches no pending request, so receivers can log it instead of losing it.

## 1.0.0

- Protocol v1: envelope, handshake (`hello`/`welcome`/`sync`), message catalog, blobs, durable delivery with `delivered` acks, close codes.
- Runtime helpers: `Peer` (two-priority send queue, request tracking), `BlobReceiver`, `sendFileBlob`, `sendBufferBlob`, `uuidv7`.
