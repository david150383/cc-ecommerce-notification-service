import request from "supertest";
import { beforeEach, describe, expect, it } from "vitest";
import { auth, buildTestContext, event, newId, resetDatabase } from "./helpers.js";

type Ctx = Awaited<ReturnType<typeof buildTestContext>>;
let ctx: Ctx;
beforeEach(async () => {
  await resetDatabase();
  ctx = await buildTestContext();
});

const SECRET = "s3cr3t-reset-token-value-0123456789abcdef";
const transactional = (over: Record<string, unknown> = {}) => ({
  recipient: { userId: USER, email: "asha@example.com", fullName: "Asha Rao" },
  templateKey: "auth.password-reset",
  data: { fullName: "Asha Rao" },
  secretData: { url: `http://localhost:5173/reset-password?token=${SECRET}` },
  ...over,
});
const USER = "0192a1b2-0000-7000-8000-000000000101";
const fromAuth = () => auth(["service"], "ecommerce-auth-service");
const send = async (body: object, key = newId(), headers?: Record<string, string>) =>
  request(ctx.app).post("/internal/v1/notifications/transactional").set(headers ?? (await fromAuth())).set("Idempotency-Key", key).send(body);

/** Everything this service persisted, as one string. */
async function databaseDump(): Promise<string> {
  const out: unknown[] = [];
  for (const t of ["notifications", "delivery_attempts", "processed_messages", "recipients", "preferences"]) {
    out.push((await ctx.db.query(`SELECT * FROM ${t}`)).rows);
  }
  return JSON.stringify(out, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
}

describe("POST /internal/v1/notifications/transactional (secret-bearing)", () => {
  it("sends now; the secret is in the email and NOWHERE else (database, logs)", async () => {
    const res = await send(transactional());
    expect(res.status).toBe(202);
    expect(res.body.status).toBe("SENT");
    expect(ctx.email.sent).toHaveLength(1);
    expect(ctx.email.sent[0]).toMatchObject({ to: "asha@example.com", subject: "Reset your password" });
    expect(ctx.email.sent[0]!.text).toContain(SECRET);

    expect(await databaseDump()).not.toContain(SECRET);
    expect(ctx.logLines.length).toBeGreaterThan(0); // the request was logged...
    expect(ctx.logLines.join("\n")).not.toContain(SECRET); // ...without the secret
  });

  it("is idempotent: a repeat after success sends nothing; a different message under the key is refused", async () => {
    const key = newId();
    await send(transactional(), key);
    const again = await send(transactional(), key);
    expect([again.status, again.headers["idempotency-replayed"]]).toEqual([202, "true"]);
    expect(ctx.email.sent).toHaveLength(1);
    expect((await send(transactional({ templateKey: "auth.verify-email" }), key)).body.code).toBe("IDEMPOTENCY_KEY_REUSED");
  });

  it("retries quickly in-request; if SMTP stays down → 503, FAILED, still no secret stored", async () => {
    ctx.email.failNext(1);
    expect((await send(transactional())).status).toBe(202); // 2nd attempt worked

    ctx.email.failNext(3);
    const key = newId();
    const res = await send(transactional(), key);
    expect([res.status, res.body.code]).toEqual([503, "DELIVERY_FAILED"]);
    const row = (await ctx.db.query(`SELECT * FROM notifications WHERE dedupe_key = $1`, [`transactional:${key}`])).rows[0];
    expect([row.status, row.attempts, row.in_memory_only]).toEqual(["FAILED", 3, true]);
    expect(await databaseDump()).not.toContain(SECRET);

    // The worker can never pick it up (it could not render it), and an operator cannot re-send it...
    expect(await ctx.notifications.deliverDue()).toBe(0);
    expect((await request(ctx.app).post(`/api/v1/admin/notifications/${row.id}/retry`).set(await auth(["admin"]))).body.code).toBe("NOT_RETRYABLE");
    // ...but Auth retrying with the same key (it still holds the secret) does.
    expect((await send(transactional(), key)).status).toBe(202);
  });

  it("only allow-listed services may call it", async () => {
    expect((await send(transactional(), newId(), await auth(["service"], "ecommerce-order-service"))).status).toBe(403);
    expect((await send(transactional(), newId(), await auth(["customer"]))).status).toBe(403);
    expect((await request(ctx.app).post("/internal/v1/notifications/transactional").send(transactional())).status).toBe(401);
    expect((await send(transactional({ templateKey: "order.confirmed" }))).status).toBe(400);
    expect(ctx.email.sent).toHaveLength(0);
  });
});

describe("customer API", () => {
  it("preferences: defaults, update, validation; SMS needs a phone number", async () => {
    const me = await auth(["customer"]);
    const get = await request(ctx.app).get("/api/v1/notifications/preferences").set(me);
    expect(get.body.preferences).toEqual({ email: { orderUpdates: true, marketing: false }, sms: { orderUpdates: false, phone: null } });

    const bad = await request(ctx.app).put("/api/v1/notifications/preferences").set(me).send({ email: { orderUpdates: true, marketing: false }, sms: { orderUpdates: true, phone: null } });
    expect([bad.status, bad.body.code]).toEqual([400, "VALIDATION_FAILED"]);

    const body = { email: { orderUpdates: false, marketing: true }, sms: { orderUpdates: true, phone: "+919800000001" } };
    expect((await request(ctx.app).put("/api/v1/notifications/preferences").set(me).send(body)).body.preferences).toEqual(body);
    expect((await request(ctx.app).get("/api/v1/notifications/preferences").set(me)).body.preferences).toEqual(body);
  });

  it("history shows only my notifications, without template data or addresses", async () => {
    const userId = newId();
    await ctx.notifications.handleEvent(event("UserRegistered", { userId, email: "me@example.com", fullName: "Me", roles: [] }));
    await ctx.notifications.handleEvent(event("UserRegistered", { userId: newId(), email: "other@example.com", fullName: "Other", roles: [] }));
    await ctx.notifications.deliverDue();
    const res = await request(ctx.app).get("/api/v1/notifications/history").set(await auth(["customer"], userId));
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0]).toMatchObject({ templateKey: "account.welcome", status: "SENT", channel: "email" });
    expect(JSON.stringify(res.body)).not.toContain("example.com");
  });
});

describe("admin API", () => {
  it("lists with filters and paging; customers are refused", async () => {
    for (let i = 0; i < 3; i++) await ctx.notifications.handleEvent(event("UserRegistered", { userId: newId(), email: `u${i}@example.com`, fullName: "U", roles: [] }));
    const admin = await auth(["admin"]);
    const first = await request(ctx.app).get("/api/v1/admin/notifications?status=QUEUED&limit=2").set(admin);
    expect(first.body.data).toHaveLength(2);
    const second = await request(ctx.app).get(`/api/v1/admin/notifications?status=QUEUED&limit=2&cursor=${first.body.page.nextCursor}`).set(admin);
    expect([second.body.data.length, second.body.page.nextCursor]).toEqual([1, null]);
    expect((await request(ctx.app).get("/api/v1/admin/notifications").set(await auth(["customer"]))).status).toBe(403);
    expect((await request(ctx.app).get("/api/v1/admin/notifications/dead-letters").set(admin)).body.code).toBe("MESSAGING_DISABLED");
  });

  it("retry: only FAILED notifications; a SENT one is refused", async () => {
    await ctx.notifications.handleEvent(event("UserRegistered", { userId: newId(), email: "u@example.com", fullName: "U", roles: [] }));
    await ctx.notifications.deliverDue();
    const [n] = (await ctx.db.query(`SELECT id FROM notifications`)).rows;
    const res = await request(ctx.app).post(`/api/v1/admin/notifications/${n.id}/retry`).set(await auth(["admin"]));
    expect([res.status, res.body.code]).toEqual([409, "NOT_RETRYABLE"]);
  });
});
