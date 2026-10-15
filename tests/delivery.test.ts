import { beforeEach, describe, expect, it } from "vitest";
import { InvalidMessage } from "../src/messaging/message-consumer.js";
import { buildTestContext, event, makeDue, newId, resetDatabase, rows } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestContext>>;
let ctx: Ctx;
beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext();
});

const registered = (userId: string, email = "asha@example.com") => event("UserRegistered", { userId, email, fullName: "Asha Rao", roles: ["customer"] });
const confirmed = (customerId: string, orderId = newId()) =>
  event("OrderConfirmed", { orderId, customerId, total: { amountMinor: 117_764, currency: "INR" } });
const statusOf = async (id: string) => (await ctx.db.query(`SELECT * FROM notifications WHERE id = $1`, [id])).rows[0];

describe("ingest", () => {
  it("UserRegistered fills the recipient directory and sends a welcome email, once per redelivery", async () => {
    const userId = newId();
    const e = registered(userId);
    expect(await ctx.notifications.handleEvent(e)).toBe("applied");
    expect(await ctx.notifications.handleEvent(e)).toBe("duplicate"); // SQS at-least-once
    expect(await ctx.notifications.handleEvent(registered(userId))).toBe("applied"); // same fact, new message id
    expect(await rows()).toHaveLength(1); // ...still one welcome (dedupe key welcome:<user>)

    expect(await ctx.notifications.deliverDue()).toBe(1);
    expect(ctx.email.sent).toEqual([expect.objectContaining({ to: "asha@example.com", subject: "Welcome to the shop" })]);
    expect(ctx.email.sent[0]!.text).toContain("Hi Asha Rao,");
  });

  it("an order update creates email + SMS rows; preferences decide at send time", async () => {
    const userId = newId();
    await ctx.notifications.handleEvent(registered(userId));
    await ctx.notifications.handleEvent(confirmed(userId));
    await ctx.notifications.deliverDue();
    const byTemplate = (await rows()).filter((r) => r.template_key === "order.confirmed");
    expect(byTemplate.map((r) => [r.channel, r.status, r.skip_reason])).toEqual([
      ["email", "SENT", null],
      ["sms", "SKIPPED", "OPTED_OUT"], // SMS is opt-in
    ]);
    expect(ctx.email.sent.find((m) => m.subject.includes("confirmed"))!.text).toContain("₹1,177.64");
  });

  it("SMS goes out once the customer opts in with a phone number", async () => {
    const userId = newId();
    await ctx.notifications.handleEvent(registered(userId));
    await ctx.notifications.setPreferences(userId, { email: { orderUpdates: false, marketing: false }, sms: { orderUpdates: true, phone: "+919800000001" } });
    await ctx.notifications.handleEvent(confirmed(userId));
    await ctx.notifications.deliverDue();
    expect(ctx.sms.sent).toEqual([expect.objectContaining({ to: "+919800000001", text: expect.stringContaining("confirmed") })]);
    const email = (await rows()).find((r) => r.template_key === "order.confirmed" && r.channel === "email")!;
    expect([email.status, email.skip_reason]).toEqual(["SKIPPED", "OPTED_OUT"]);
  });

  it("an order email that arrives BEFORE UserRegistered waits for the directory, then goes out", async () => {
    const userId = newId();
    await ctx.notifications.handleEvent(confirmed(userId)); // topics are not ordered relative to each other
    await ctx.notifications.deliverDue();
    const [email] = (await rows()).filter((r) => r.channel === "email");
    expect([email!.status, email!.attempts]).toEqual(["QUEUED", 1]);
    expect(email!.last_error).toMatch(/RECIPIENT_UNKNOWN/);

    await ctx.notifications.handleEvent(registered(userId));
    await makeDue();
    await ctx.notifications.deliverDue();
    expect((await statusOf(email!.id as string)).status).toBe("SENT");
  });

  it("maps the other events; ignores what is not customer news", async () => {
    const userId = newId();
    const orderId = newId();
    await ctx.notifications.handleEvent(registered(userId));
    expect(await ctx.notifications.handleEvent(event("OrderStatusChanged", { orderId, customerId: userId, fromStatus: "CONFIRMED", toStatus: "PROCESSING" }))).toBe("ignored");
    expect(await ctx.notifications.handleEvent(event("PaymentFailed", { paymentId: newId(), orderId, customerId: userId, amount: { amountMinor: 1, currency: "INR" }, provider: "mock", failureCode: "DECLINED" }))).toBe("ignored");
    await ctx.notifications.handleEvent(event("OrderStatusChanged", { orderId, customerId: userId, fromStatus: "PROCESSING", toStatus: "SHIPPED" }));
    await ctx.notifications.handleEvent(event("OrderCancelled", { orderId: newId(), customerId: userId, previousStatus: "PAYMENT_PENDING", reason: "PAYMENT_FAILED" }));
    await ctx.notifications.handleEvent(event("RefundSucceeded", { refundId: newId(), paymentId: newId(), orderId, customerId: userId, amount: { amountMinor: 50_000, currency: "INR" } }));
    await ctx.notifications.handleEvent(event("InventoryLowStock", { sku: "TEE-CLASSIC-WHT-S", available: 2, threshold: 5 }));
    await ctx.notifications.handleEvent(event("SomethingNew", {}));
    await ctx.notifications.deliverDue();
    expect(ctx.email.sent.map((m) => [m.to, m.subject.replace(/[0-9A-F]{8}/, "#")])).toEqual([
      ["asha@example.com", "Welcome to the shop"],
      ["asha@example.com", "Order # shipped"],
      ["asha@example.com", "Order # cancelled"],
      ["asha@example.com", "Refund for order #"],
      ["ops@shop.local", "Low stock: TEE-CLASSIC-WHT-S"],
    ]);
    expect(ctx.email.sent[2]!.text).toContain("the payment did not go through");
    expect(ctx.email.sent[3]!.text).toContain("₹500.00");
  });

  it("an event with a broken payload is rejected (→ DLQ) and leaves no trace, so a fixed redelivery still works", async () => {
    const bad = event("OrderConfirmed", { orderId: "not-a-uuid", customerId: newId() });
    await expect(ctx.notifications.handleEvent(bad)).rejects.toBeInstanceOf(InvalidMessage);
    expect((await ctx.db.query(`SELECT count(*)::int AS n FROM processed_messages`)).rows[0].n).toBe(0);
  });
});

describe("NotificationRequested commands", () => {
  const command = (payload: Record<string, unknown>, idempotencyKey = `k-${newId()}`) => ({ ...event("NotificationRequested", payload), idempotencyKey });

  it("enqueues once per idempotency key, whatever the number of deliveries", async () => {
    const userId = newId();
    const cmd = command({ recipientUserId: userId, channel: "email", templateKey: "order.shipped", data: { orderId: newId() } });
    expect(await ctx.notifications.handleCommand(cmd)).toBe("applied");
    expect(await ctx.notifications.handleCommand(cmd)).toBe("duplicate");
    expect(await ctx.notifications.handleCommand({ ...cmd, messageId: newId() })).toBe("applied"); // re-sent by the producer
    expect(await rows()).toHaveLength(1);
  });

  it("order.under-review (sent by the saga on manual review) reaches the customer by email", async () => {
    const userId = newId();
    const orderId = "0192a1b2-0000-7000-8000-0000000abc12";
    await ctx.notifications.handleEvent(registered(userId));
    await ctx.notifications.handleCommand(command({ recipientUserId: userId, channel: "email", templateKey: "order.under-review", data: { orderId } }));
    await ctx.notifications.deliverDue();
    const mail = ctx.email.sent.find((m) => m.subject.startsWith("We are checking order"))!;
    expect(mail).toMatchObject({ to: "asha@example.com", subject: "We are checking order 000ABC12" });
    expect(mail.text).toContain("You do not need to do anything");
    expect(mail.text).toContain(`/orders/${orderId}`);
  });

  it.each([
    ["an unknown template", { templateKey: "nope.nothing", channel: "email" }],
    ["a security template (secrets never travel through queues)", { templateKey: "auth.password-reset", channel: "email" }],
    ["a channel the template lacks", { templateKey: "payment.refunded", channel: "sms" }],
    ["push (not supported yet)", { templateKey: "order.shipped", channel: "push" }],
  ])("refuses %s", async (_label, p) => {
    await expect(ctx.notifications.handleCommand(command({ recipientUserId: newId(), data: {}, ...p }))).rejects.toBeInstanceOf(InvalidMessage);
  });
});

describe("delivery and retries", () => {
  async function queuedWelcome() {
    const userId = newId();
    await ctx.notifications.handleEvent(registered(userId));
    return (await rows())[0]!.id as string;
  }

  it("transient failures back off exponentially (full jitter, here at its ceiling), then FAILED after max attempts", async () => {
    const id = await queuedWelcome();
    ctx.email.failNext(3);
    const delays: number[] = [];
    for (let i = 0; i < 3; i++) {
      const before = Date.now();
      await ctx.notifications.deliverDue();
      const n = await statusOf(id);
      if (n.status === "QUEUED") delays.push(Math.round(((n.next_attempt_at as Date).getTime() - before) / 1000));
      await makeDue();
    }
    expect(delays).toEqual([1, 2]); // base 1s: attempt 1 → ≤1s, attempt 2 → ≤2s (random() = 1 in tests)
    const n = await statusOf(id);
    expect([n.status, n.attempts]).toEqual(["FAILED", 3]);
    expect((await ctx.notifications.attemptsOf(id)).map((a) => a.outcome)).toEqual(["FAILED", "FAILED", "FAILED"]);
    expect(ctx.email.sent).toHaveLength(0);

    // An operator retries; the next round succeeds.
    expect((await ctx.notifications.retry(id)).status).toBe("QUEUED");
    await ctx.notifications.deliverDue();
    expect((await statusOf(id)).status).toBe("SENT");
  });

  it("a permanent rejection (SMTP 5xx) fails at once, without retries", async () => {
    const id = await queuedWelcome();
    ctx.email.failNext(1, "permanent");
    await ctx.notifications.deliverDue();
    expect([(await statusOf(id)).status, (await statusOf(id)).attempts]).toEqual(["FAILED", 1]);
  });

  it("a worker that died mid-send: the row is picked up again when its lease expires", async () => {
    const id = await queuedWelcome();
    await ctx.db.query(`UPDATE notifications SET status = 'SENDING', attempts = 1, lease_until = now() + interval '1 minute' WHERE id = $1`, [id]);
    expect(await ctx.notifications.deliverDue()).toBe(0); // lease still held
    await ctx.db.query(`UPDATE notifications SET lease_until = now() - interval '1 second' WHERE id = $1`, [id]);
    expect(await ctx.notifications.deliverDue()).toBe(1);
    expect([(await statusOf(id)).status, (await statusOf(id)).attempts]).toEqual(["SENT", 2]);
  });

  it("parallel workers never send the same notification twice", async () => {
    for (let i = 0; i < 25; i++) await ctx.notifications.handleEvent(registered(newId(), `user${i}@example.com`));
    const other = await buildTestContext(); // a second instance with its own sender
    await Promise.all([ctx.notifications.deliverDue(25), other.notifications.deliverDue(25), ctx.notifications.deliverDue(25)]);
    const to = [...ctx.email.sent, ...other.email.sent].map((m) => m.to);
    expect(to).toHaveLength(25);
    expect(new Set(to).size).toBe(25);
  });
});
