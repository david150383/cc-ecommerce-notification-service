import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { z } from "zod";
import { type InboundMessage, InvalidMessage } from "./message-consumer.js";

/**
 * Commands belong to their consumer: NotificationRequested is validated strictly against the
 * schema THIS service owns (events/schemas, shipped in the image, the same files the tests use).
 */
export function commandParser(schemasDir = join(import.meta.dirname, "..", "..", "events", "schemas")) {
  const ajv = new Ajv2020({ strict: true, strictTypes: false, allErrors: true });
  addFormats.default(ajv);
  ajv.addVocabulary(["x-producer", "x-consumers", "x-channel", "x-message-kind"]);
  const byType = new Map<string, string>();
  for (const file of readdirSync(schemasDir).filter((f) => f.endsWith(".schema.json"))) {
    const schema = JSON.parse(readFileSync(join(schemasDir, file), "utf8"));
    ajv.addSchema(schema);
    // Only commands addressed to THIS service: the vendored contracts also hold commands it sends.
    if (schema["x-message-kind"] === "command" && (schema["x-consumers"] ?? []).includes("ecommerce-notification-service")) {
      byType.set(schema.properties.messageType.const, schema.$id);
    }
  }
  return (raw: unknown): InboundMessage => {
    const type = (raw as { messageType?: unknown } | null)?.messageType;
    const schemaId = typeof type === "string" ? byType.get(type) : undefined;
    if (!schemaId) throw new InvalidMessage(`unknown command type ${String(type)}`);
    const validate = ajv.getSchema(schemaId)!;
    if (!validate(raw)) throw new InvalidMessage(`schema violation: ${ajv.errorsText(validate.errors)}`);
    return raw as InboundMessage;
  };
}

/**
 * Events belong to their producers: only the envelope is checked here, tolerantly (new optional
 * fields never break us). Each handled payload is validated where it is used.
 */
const EventEnvelope = z.looseObject({
  messageId: z.uuid(),
  messageKind: z.literal("event"),
  messageType: z.string().min(1),
  correlationId: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
});

export function eventParser() {
  return (raw: unknown): InboundMessage => {
    const r = EventEnvelope.safeParse(raw);
    if (!r.success) throw new InvalidMessage(`not an event envelope: ${z.prettifyError(r.error)}`);
    return r.data;
  };
}
