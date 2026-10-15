import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { commandParser } from "../src/messaging/parsers.js";
import { buildTestContext, resetDatabase } from "./helpers.js";

/**
 * Consumer contract: every event this service consumes, as its PRODUCER publishes it (the example in the
 * pinned contracts release), goes through the real handler without being rejected. Bumping the pin to a
 * release whose producers changed something this service relies on fails here.
 */
const root = join(import.meta.dirname, "..");
const schemasDir = join(root, "events", "schemas");
const examplesDir = join(root, "events", "examples");
const schemas = readdirSync(schemasDir)
  .filter((f) => f.endsWith(".schema.json") && !f.startsWith("envelope."))
  .map((f) => ({ file: f, schema: JSON.parse(readFileSync(join(schemasDir, f), "utf8")) }));
const example = (file: string) => JSON.parse(readFileSync(join(examplesDir, file.replace(".schema.json", ".json")), "utf8"));
const consumedEvents = schemas.filter(({ schema }) => schema["x-message-kind"] === "event" && (schema["x-consumers"] ?? []).includes("ecommerce-notification-service"));

let ctx: Awaited<ReturnType<typeof buildTestContext>>;
beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext();
});

describe("pinned contracts (ecommerce-contracts)", () => {
  it("vendored schemas and examples match contracts.lock.json (no hand edits)", () => {
    expect(() => execFileSync(process.execPath, [join(root, "scripts", "verify-contracts.mjs"), root], { stdio: "pipe" })).not.toThrow();
  });
});

describe("events this service consumes (consumer contract)", () => {
  it("covers every event routed to notification-inbox", () => {
    expect(consumedEvents.map((c) => c.schema.properties.messageType.const).sort()).toEqual(
      ["InventoryLowStock", "OrderCancelled", "OrderConfirmed", "OrderStatusChanged", "PaymentFailed", "RefundSucceeded", "UserEmailVerified", "UserRegistered"],
    );
  });

  it.each(consumedEvents.map((c) => [c.schema.properties.messageType.const, c.file]))("%s: the producer's example is handled", async (_type, file) => {
    await expect(ctx.notifications.handleEvent(example(file as string))).resolves.toMatch(/^(applied|ignored)$/);
  });
});

describe("commands this service owns", () => {
  it("the command parser accepts the published NotificationRequested example", () => {
    const parse = commandParser();
    expect(parse(example("notification-requested.v1.schema.json")).messageType).toBe("NotificationRequested");
  });
});
