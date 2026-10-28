// Writes protocol.schema.json: one JSON Schema per message payload plus the envelope.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { Payloads, ResponseOf, GATEWAY_TO_CONNECTOR, CONNECTOR_TO_GATEWAY, BOTH_DIRECTIONS, DURABLE_TYPES } from "../src/messages.ts";
import { PROTOCOL_VERSION } from "../src/envelope.ts";

export function buildSchema(): unknown {
  const payloads: Record<string, unknown> = {};
  for (const [type, schema] of Object.entries(Payloads)) {
    payloads[type] = z.toJSONSchema(schema, { io: "input", unrepresentable: "any" });
  }
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "agent-connector <-> gateway protocol",
    version: PROTOCOL_VERSION,
    envelope: {
      type: "object",
      required: ["v", "id", "type", "ts", "payload"],
      properties: {
        v: { const: 1 },
        id: { type: "string", description: "uuidv7" },
        type: { type: "string", enum: Object.keys(Payloads) },
        ts: { type: "string", description: "ISO 8601" },
        re: { type: "string", description: "id of the request this answers" },
        payload: {},
      },
    },
    directions: { gateway_to_connector: GATEWAY_TO_CONNECTOR, connector_to_gateway: CONNECTOR_TO_GATEWAY, both: BOTH_DIRECTIONS },
    responses: ResponseOf,
    durable: DURABLE_TYPES,
    payloads,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = new URL("../protocol.schema.json", import.meta.url);
  writeFileSync(out, JSON.stringify(buildSchema(), null, 2) + "\n");
  console.log(`wrote ${fileURLToPath(out)}`);
}
