import { CreateQueueCommand, GetQueueAttributesCommand, SendMessageCommand, SQSClient } from "@aws-sdk/client-sqs";
import request from "supertest";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DlqMonitor } from "../src/messaging/dlq-monitor.js";
import { createWorkers } from "../src/messaging/runner.js";
import { auth, buildTestContext, newId, resetDatabase, rows } from "./helpers.js";

// Runs against the local AWS emulator (Floci), with a private queue set per run.
const endpoint = process.env.TEST_AWS_ENDPOINT_URL ?? "http://localhost:4566";
process.env.AWS_ACCESS_KEY_ID ??= "test";
process.env.AWS_SECRET_ACCESS_KEY ??= "test";
const sqs = new SQSClient({ region: "us-east-1", endpoint, useQueueUrlAsEndpoint: false });

const id = newId().slice(-10);
const names = { commands: `t-${id}-notification-commands`, inbox: `t-${id}-notification-inbox`, commandsDlq: `t-${id}-notification-commands-dlq`, inboxDlq: `t-${id}-notification-inbox-dlq` };
const url = (name: string) => `${endpoint}/000000000000/${name}`;
const arn = async (name: string) => (await sqs.send(new GetQueueAttributesCommand({ QueueUrl: url(name), AttributeNames: ["QueueArn"] }))).Attributes!.QueueArn!;
const sendRaw = (queue: string, body: string) => sqs.send(new SendMessageCommand({ QueueUrl: url(queue), MessageBody: body }));

beforeAll(async () => {
  for (const [main, dlq] of [[names.commands, names.commandsDlq], [names.inbox, names.inboxDlq]] as const) {
    await sqs.send(new CreateQueueCommand({ QueueName: dlq }));
    await sqs.send(new CreateQueueCommand({ QueueName: main, Attributes: { VisibilityTimeout: "1", RedrivePolicy: JSON.stringify({ deadLetterTargetArn: await arn(dlq), maxReceiveCount: 2 }) } }));
  }
});

let ctx: Awaited<ReturnType<typeof buildTestContext>>;
let workers: ReturnType<typeof createWorkers>;
let dlq: DlqMonitor;
let monitorLogs: string[];

beforeEach(async () => {
  await resetDatabase();
  const monitorCtx = await buildTestContext();
  monitorLogs = monitorCtx.logLines;
  dlq = new DlqMonitor(sqs, [names.commandsDlq, names.inboxDlq], monitorCtx.logger);
  ctx = await buildTestContext({
    overrides: { AWS_ENDPOINT_URL: endpoint, COMMANDS_QUEUE_NAME: names.commands, INBOX_QUEUE_NAME: names.inbox, CONSUMER_WAIT_TIME_SECONDS: "1" },
    dlq,
  });
  workers = createWorkers(ctx.env, sqs, ctx.notifications, dlq, ctx.logger); // not started: driven step by step
});

const envelope = (messageType: string, kind: "event" | "command", payload: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  messageId: newId(), messageKind: kind, messageType, messageVersion: 1, occurredAt: new Date().toISOString(),
  correlationId: newId(), causationId: null, sagaId: null, idempotencyKey: null, payload, ...extra,
});

describe("notification-inbox (events fanned out from SNS, raw delivery)", () => {
  it("applies events over SQS, deletes them, and tolerates fields it does not know", async () => {
    const userId = newId();
    await sendRaw(names.inbox, JSON.stringify(envelope("UserRegistered", "event", { userId, email: "q@example.com", fullName: "Q", roles: ["customer"], newField: 1 }, { producer: "ecommerce-auth-service", futureEnvelopeField: true })));
    expect(await workers.inbox.pollOnce()).toBe(1);
    expect((await rows()).map((r) => r.template_key)).toEqual(["account.welcome"]);
    expect(await workers.inbox.pollOnce()).toBe(0); // deleted
  });
});

describe("notification-commands", () => {
  it("validates NotificationRequested against this service's own schema", async () => {
    const cmd = envelope("NotificationRequested", "command", { recipientUserId: newId(), channel: "email", templateKey: "order.shipped", data: { orderId: newId() } },
      { producer: "ecommerce-order-service", idempotencyKey: `shipped:${newId()}` });
    await sendRaw(names.commands, JSON.stringify(cmd));
    expect(await workers.commands.pollOnce()).toBe(1);
    expect(await rows()).toHaveLength(1);
  });
});

describe("dead letters", () => {
  it("poison messages end up in the DLQs; the monitor sees them and the admin API peeks without consuming", async () => {
    await sendRaw(names.inbox, "{not json");
    await sendRaw(names.inbox, JSON.stringify(envelope("OrderConfirmed", "event", { orderId: "nope", customerId: newId() })));
    await sendRaw(names.commands, JSON.stringify(envelope("NotificationRequested", "command", { recipientUserId: newId(), channel: "email", templateKey: "auth.password-reset", data: {} }, { producer: "ecommerce-saga-orchestrator", idempotencyKey: "k" })));
    for (let i = 0; i < 3; i++) {
      expect(await workers.inbox.pollOnce()).toBe(0);
      expect(await workers.commands.pollOnce()).toBe(0);
      await new Promise((r) => setTimeout(r, 1_200));
    }
    await workers.inbox.pollOnce();
    await workers.commands.pollOnce();

    let depths: Record<string, number> = {};
    for (let i = 0; i < 10 && (depths[names.inboxDlq] ?? 0) + (depths[names.commandsDlq] ?? 0) < 3; i++) {
      depths = await dlq.check();
      await new Promise((r) => setTimeout(r, 500));
    }
    expect(depths).toEqual({ [names.commandsDlq]: 1, [names.inboxDlq]: 2 });
    expect(monitorLogs.join("\n")).toMatch(/need attention/);

    const res = await request(ctx.app).get("/api/v1/admin/notifications/dead-letters").set(await auth(["admin"]));
    expect(res.body.data.map((d: { messageType: string | null }) => d.messageType).sort()).toEqual([null, "NotificationRequested", "OrderConfirmed"].sort());
    expect(JSON.stringify(res.body)).not.toContain("payload"); // identifying fields only
    expect(await dlq.depths()).toEqual(depths); // a peek, not a consume
  });
});
