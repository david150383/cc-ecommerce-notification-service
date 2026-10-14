import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { type ChannelSender, PermanentDeliveryError } from "../channels/channels.js";
import { type Client, type Pool, transaction } from "../db/pool.js";
import type { Logger } from "../lib/logger.js";
import { HttpProblem } from "../lib/problem.js";
import { type InboundMessage, InvalidMessage } from "../messaging/message-consumer.js";
import { type Category, type Channel, getTemplate, render, TemplateError } from "../templates/templates.js";

export type NotificationStatus = "QUEUED" | "SENDING" | "SENT" | "FAILED" | "SKIPPED";

export interface Notification {
  id: string;
  dedupeKey: string;
  channel: Channel;
  templateKey: string;
  recipientUserId: string | null;
  recipientAddress: string | null;
  data: Record<string, unknown>;
  status: NotificationStatus;
  inMemoryOnly: boolean;
  skipReason: string | null;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  lastError: string | null;
  sourceType: string | null;
  sentAt: Date | null;
  createdAt: Date;
}

function toNotification(r: Record<string, unknown>): Notification {
  return {
    id: r.id as string,
    dedupeKey: r.dedupe_key as string,
    channel: r.channel as Channel,
    templateKey: r.template_key as string,
    recipientUserId: (r.recipient_user_id as string | null) ?? null,
    recipientAddress: (r.recipient_address as string | null) ?? null,
    data: r.data as Record<string, unknown>,
    status: r.status as NotificationStatus,
    inMemoryOnly: r.in_memory_only as boolean,
    skipReason: (r.skip_reason as string | null) ?? null,
    attempts: r.attempts as number,
    maxAttempts: r.max_attempts as number,
    nextAttemptAt: r.next_attempt_at as Date,
    lastError: (r.last_error as string | null) ?? null,
    sourceType: (r.source_type as string | null) ?? null,
    sentAt: (r.sent_at as Date | null) ?? null,
    createdAt: r.created_at as Date,
  };
}

export interface Preferences {
  email: { orderUpdates: boolean; marketing: boolean };
  sms: { orderUpdates: boolean; phone: string | null };
}

export interface DeliveryConfig {
  maxAttempts: number;
  retryBaseMs: number;
  retryCapMs: number;
  leaseMs: number;
  shopBaseUrl: string;
  adminAlertEmails: string[];
  /** In-request retries for secret-bearing messages (they cannot wait for the worker). */
  transactionalRetryDelaysMs: number[];
}

interface EnqueueSpec {
  dedupeKey: string;
  channel: Channel;
  templateKey: string;
  recipientUserId?: string;
  recipientAddress?: string;
  data: Record<string, unknown>;
  source: InboundMessage;
}

// Payloads of the events we act on. Producers own these schemas; we validate only what we use and
// tolerate additions (a producer adding a field must never break this consumer).
const uuid = z.uuid();
const money = z.object({ amountMinor: z.number().int(), currency: z.string().length(3) });
const EVENT_PAYLOADS = {
  UserRegistered: z.object({ userId: uuid, email: z.email(), fullName: z.string() }),
  UserEmailVerified: z.object({ userId: uuid, email: z.email() }),
  OrderConfirmed: z.object({ orderId: uuid, customerId: uuid, total: money }),
  OrderCancelled: z.object({ orderId: uuid, customerId: uuid, reason: z.string() }),
  OrderStatusChanged: z.object({ orderId: uuid, customerId: uuid, toStatus: z.string() }),
  PaymentFailed: z.object({ orderId: uuid, customerId: uuid }),
  RefundSucceeded: z.object({ refundId: uuid, orderId: uuid, customerId: uuid, amount: money }),
  InventoryLowStock: z.object({ sku: z.string(), available: z.number().int(), threshold: z.number().int() }),
} as const;

function parsePayload<K extends keyof typeof EVENT_PAYLOADS>(type: K, payload: unknown): z.infer<(typeof EVENT_PAYLOADS)[K]> {
  const r = EVENT_PAYLOADS[type].safeParse(payload);
  if (!r.success) throw new InvalidMessage(`${type} payload: ${z.prettifyError(r.error)}`);
  return r.data as z.infer<(typeof EVENT_PAYLOADS)[K]>;
}

/** Full jitter (AWS Architecture Blog): uniform in [0, min(cap, base * 2^(attempt-1))]. */
export function backoffMs(attempt: number, baseMs: number, capMs: number, random: () => number = Math.random): number {
  const ceiling = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt - 1));
  return Math.floor(random() * ceiling);
}

const truncate = (s: string, n = 500) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export class NotificationService {
  constructor(
    private readonly db: Pool,
    private readonly senders: Record<Channel, ChannelSender>,
    private readonly config: DeliveryConfig,
    private readonly logger: Logger,
    private readonly random: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  // ======================================================================= ingest

  /** One event from notification-inbox. Dedupe and every resulting enqueue share one transaction. */
  async handleEvent(event: InboundMessage): Promise<"applied" | "duplicate" | "ignored"> {
    return transaction(this.db, async (c) => {
      if (!(await this.markProcessed(c, event))) return "duplicate";
      return (await this.applyEvent(c, event)) ? "applied" : "ignored";
    });
  }

  private async applyEvent(c: Client, e: InboundMessage): Promise<boolean> {
    switch (e.messageType) {
      case "UserRegistered": {
        const p = parsePayload("UserRegistered", e.payload);
        await c.query(
          `INSERT INTO recipients (user_id, email, full_name) VALUES ($1, $2, $3)
           ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, updated_at = now()`,
          [p.userId, p.email, p.fullName],
        );
        await this.enqueue(c, { dedupeKey: `welcome:${p.userId}`, channel: "email", templateKey: "account.welcome", recipientUserId: p.userId, data: {}, source: e });
        return true;
      }
      case "UserEmailVerified": {
        const p = parsePayload("UserEmailVerified", e.payload);
        await c.query(
          `INSERT INTO recipients (user_id, email, email_verified) VALUES ($1, $2, true)
           ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, email_verified = true, updated_at = now()`,
          [p.userId, p.email],
        );
        return true;
      }
      case "OrderConfirmed": {
        const p = parsePayload("OrderConfirmed", e.payload);
        await this.toCustomer(c, e, `order-confirmed:${p.orderId}`, "order.confirmed", p.customerId, { orderId: p.orderId, total: p.total });
        return true;
      }
      case "OrderCancelled": {
        const p = parsePayload("OrderCancelled", e.payload);
        await this.toCustomer(c, e, `order-cancelled:${p.orderId}`, "order.cancelled", p.customerId, { orderId: p.orderId, reason: p.reason });
        return true;
      }
      case "OrderStatusChanged": {
        const p = parsePayload("OrderStatusChanged", e.payload);
        const template = { SHIPPED: "order.shipped", DELIVERED: "order.delivered" }[p.toStatus];
        if (!template) return false; // other transitions are not customer news
        await this.toCustomer(c, e, `order-${p.toStatus.toLowerCase()}:${p.orderId}`, template, p.customerId, { orderId: p.orderId });
        return true;
      }
      case "PaymentFailed":
        // Deliberately silent: a failed payment cancels the checkout, and OrderCancelled (reason
        // PAYMENT_FAILED) tells the customer. Two emails for one event would be noise.
        parsePayload("PaymentFailed", e.payload);
        return false;
      case "RefundSucceeded": {
        const p = parsePayload("RefundSucceeded", e.payload);
        await this.enqueue(c, {
          dedupeKey: `refund:${p.refundId}`, channel: "email", templateKey: "payment.refunded", recipientUserId: p.customerId,
          data: { orderId: p.orderId, amount: p.amount }, source: e,
        });
        return true;
      }
      case "InventoryLowStock": {
        const p = parsePayload("InventoryLowStock", e.payload);
        for (const address of this.config.adminAlertEmails) {
          await this.enqueue(c, {
            dedupeKey: `low-stock:${e.messageId}:${address}`, channel: "email", templateKey: "admin.low-stock", recipientAddress: address,
            data: { sku: p.sku, available: p.available, threshold: p.threshold }, source: e,
          });
        }
        return this.config.adminAlertEmails.length > 0;
      }
      default:
        this.logger.info({ messageType: e.messageType, messageId: e.messageId }, "event type not handled; ignored");
        return false;
    }
  }

  /** NotificationRequested from notification-commands (payload already schema-validated). */
  async handleCommand(cmd: InboundMessage): Promise<"applied" | "duplicate"> {
    const p = cmd.payload as { recipientUserId: string; channel: string; templateKey: string; data: Record<string, unknown> };
    const template = getTemplate(p.templateKey);
    if (!template) throw new InvalidMessage(`unknown template ${p.templateKey}`);
    // Secrets never travel through queues (durable, replayable): those use the internal endpoint.
    if (template.category === "security") throw new InvalidMessage(`${p.templateKey} must be sent through the transactional endpoint`);
    if (p.channel !== "email" && p.channel !== "sms") throw new InvalidMessage(`channel ${p.channel} is not supported`);
    if (!template.channels.includes(p.channel)) throw new InvalidMessage(`${p.templateKey} has no ${p.channel} version`);
    if (!cmd.idempotencyKey) throw new InvalidMessage("NotificationRequested needs an idempotencyKey");
    return transaction(this.db, async (c) => {
      if (!(await this.markProcessed(c, cmd))) return "duplicate";
      await this.enqueue(c, { dedupeKey: cmd.idempotencyKey!, channel: p.channel as Channel, templateKey: p.templateKey, recipientUserId: p.recipientUserId, data: p.data, source: cmd });
      return "applied";
    });
  }

  private async markProcessed(c: Client, m: InboundMessage): Promise<boolean> {
    const r = await c.query(`INSERT INTO processed_messages (message_id, message_type) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [m.messageId, m.messageType]);
    return r.rowCount === 1;
  }

  /** Customer updates go out on every channel the template supports; preferences decide at send time. */
  private async toCustomer(c: Client, e: InboundMessage, dedupeKey: string, templateKey: string, userId: string, data: Record<string, unknown>) {
    for (const channel of getTemplate(templateKey)!.channels) {
      await this.enqueue(c, { dedupeKey, channel, templateKey, recipientUserId: userId, data, source: e });
    }
  }

  private async enqueue(c: Client, s: EnqueueSpec): Promise<void> {
    await c.query(
      `INSERT INTO notifications (id, dedupe_key, channel, template_key, recipient_user_id, recipient_address, data, max_attempts,
                                  source_message_id, source_type, correlation_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (dedupe_key, channel) DO NOTHING`,
      [uuidv7(), s.dedupeKey, s.channel, s.templateKey, s.recipientUserId ?? null, s.recipientAddress ?? null, s.data,
        this.config.maxAttempts, s.source.messageId, s.source.messageType, s.source.correlationId],
    );
  }

  // ======================================================================= delivery (worker)

  /**
   * Claims due notifications (SKIP LOCKED: several instances never take the same row), each with a
   * lease. A row whose worker died mid-send becomes due again when its lease expires: delivery is
   * at-least-once, and the stable Message-ID lets mail systems recognise a repeat.
   */
  async deliverDue(limit = 10): Promise<number> {
    const { rows } = await this.db.query(
      `UPDATE notifications SET status = 'SENDING', attempts = attempts + 1,
              lease_until = now() + make_interval(secs => $2::double precision / 1000), updated_at = now()
        WHERE id IN (SELECT id FROM notifications
                      WHERE NOT in_memory_only
                        AND ((status = 'QUEUED' AND next_attempt_at <= now()) OR (status = 'SENDING' AND lease_until < now()))
                      ORDER BY next_attempt_at LIMIT $1 FOR UPDATE SKIP LOCKED)
      RETURNING *`,
      [limit, this.config.leaseMs],
    );
    // RETURNING does not keep the subquery's order: oldest-due first.
    rows.sort((a, b) => (a.next_attempt_at as Date).getTime() - (b.next_attempt_at as Date).getTime());
    for (const row of rows) {
      const n = toNotification(row);
      try {
        await this.deliverOne(n);
      } catch (err) {
        this.logger.error({ err, notificationId: n.id }, "delivery bookkeeping failed; the lease will expire and it is retried");
      }
    }
    return rows.length;
  }

  private async deliverOne(n: Notification): Promise<void> {
    const template = getTemplate(n.templateKey);
    if (!template) return this.finish(n, "FAILED", { error: `unknown template ${n.templateKey}` });

    let address = n.recipientAddress;
    let fullName: string | null = (n.data.fullName as string | undefined) ?? null;
    if (!address && n.recipientUserId) {
      const r = (await this.db.query(`SELECT * FROM recipients WHERE user_id = $1`, [n.recipientUserId])).rows[0];
      const prefs = await this.preferencesOf(n.recipientUserId);
      if (!allowed(template.category, n.channel, prefs)) return this.finish(n, "SKIPPED", { reason: "OPTED_OUT" });
      if (n.channel === "sms") {
        if (!r?.phone) return this.finish(n, "SKIPPED", { reason: "NO_PHONE" });
        address = r.phone as string;
      } else {
        // Events from different topics are not ordered: an order email can arrive before the
        // UserRegistered that tells us the address. Retry; the directory usually catches up.
        if (!r?.email) return this.retryOrFail(n, "RECIPIENT_UNKNOWN: no email address for this user yet");
        address = r.email as string;
      }
      fullName = (r?.full_name as string | null) ?? fullName;
    }

    let rendered;
    try {
      rendered = render(n.templateKey, n.channel, n.data, { shopBaseUrl: this.config.shopBaseUrl, fullName });
    } catch (err) {
      if (err instanceof TemplateError) return this.finish(n, "FAILED", { error: err.message });
      throw err;
    }

    let providerMessageId: string;
    try {
      ({ providerMessageId } = await this.senders[n.channel].send({ notificationId: n.id, to: address!, ...rendered }));
    } catch (err) {
      if (err instanceof PermanentDeliveryError) return this.finish(n, "FAILED", { error: err.message });
      return this.retryOrFail(n, (err as Error).message);
    }
    // Outside the try: if recording success fails, the message WAS sent and must not be retried
    // as a failure (the lease expiry is the only, unavoidable, path to a repeat).
    await this.finish(n, "SENT", { providerMessageId });
  }

  private async retryOrFail(n: Notification, error: string): Promise<void> {
    if (n.attempts >= n.maxAttempts) {
      this.logger.error({ notificationId: n.id, templateKey: n.templateKey, attempts: n.attempts }, "notification failed after the last attempt");
      return this.finish(n, "FAILED", { error });
    }
    const delay = backoffMs(n.attempts, this.config.retryBaseMs, this.config.retryCapMs, this.random);
    await transaction(this.db, async (c) => {
      await c.query(
        `UPDATE notifications SET status = 'QUEUED', lease_until = NULL, last_error = $2,
                next_attempt_at = now() + make_interval(secs => $3::double precision / 1000), updated_at = now()
          WHERE id = $1`,
        [n.id, truncate(error), delay],
      );
      await c.query(`INSERT INTO delivery_attempts (notification_id, attempt, outcome, error) VALUES ($1, $2, 'FAILED', $3)`, [n.id, n.attempts, truncate(error)]);
    });
    this.logger.warn({ notificationId: n.id, attempt: n.attempts, retryInMs: delay }, "delivery failed; retry scheduled");
  }

  private async finish(n: Notification, status: "SENT" | "FAILED" | "SKIPPED", detail: { providerMessageId?: string; error?: string; reason?: string }) {
    await transaction(this.db, async (c) => {
      await c.query(
        `UPDATE notifications SET status = $2::notification_status, lease_until = NULL, provider_message_id = COALESCE($3, provider_message_id),
                last_error = COALESCE($4, last_error), skip_reason = $5,
                sent_at = CASE WHEN $2::notification_status = 'SENT' THEN now() ELSE sent_at END,
                attempts = GREATEST(attempts, $6), updated_at = now()
          WHERE id = $1`,
        [n.id, status, detail.providerMessageId ?? null, detail.error ? truncate(detail.error) : null, detail.reason ?? null, n.attempts],
      );
      await c.query(`INSERT INTO delivery_attempts (notification_id, attempt, outcome, error) VALUES ($1, $2, $3, $4)`, [
        n.id, n.attempts, status, detail.error ? truncate(detail.error) : (detail.reason ?? null),
      ]);
    });
  }

  // ======================================================================= secret-bearing (in request)

  /**
   * Password reset / email verification. The secret exists only in this request: it is rendered and
   * sent here, with a few quick retries, and is never stored, logged or queued. The row records
   * template, recipient and outcome only. A repeat with the same key after success sends nothing.
   */
  async sendTransactional(
    idempotencyKey: string,
    req: { recipient: { userId: string; email: string; fullName: string }; templateKey: string; secretData: { url: string } },
  ): Promise<{ notification: Notification; replayed: boolean }> {
    const template = getTemplate(req.templateKey);
    if (!template || template.category !== "security") throw new HttpProblem(422, "UNKNOWN_TEMPLATE", "Not a transactional template");
    const dedupeKey = `transactional:${idempotencyKey}`;

    // Claim the row: insert, or take over a failed one (or one whose sender died mid-request).
    const claimed = await transaction(this.db, async (c) => {
      await c.query(
        `INSERT INTO recipients (user_id, email, full_name) VALUES ($1, $2, $3)
         ON CONFLICT (user_id) DO UPDATE SET email = EXCLUDED.email, full_name = EXCLUDED.full_name, updated_at = now()`,
        [req.recipient.userId, req.recipient.email, req.recipient.fullName],
      );
      const inserted = await c.query(
        `INSERT INTO notifications (id, dedupe_key, channel, template_key, recipient_user_id, recipient_address, status, in_memory_only,
                                    max_attempts, lease_until, source_type)
         VALUES ($1, $2, 'email', $3, $4, $5, 'SENDING', true, $6, now() + interval '30 seconds', 'transactional')
         ON CONFLICT (dedupe_key, channel) DO NOTHING RETURNING *`,
        [uuidv7(), dedupeKey, req.templateKey, req.recipient.userId, req.recipient.email, this.config.transactionalRetryDelaysMs.length + 1],
      );
      if (inserted.rows[0]) return { n: toNotification(inserted.rows[0]), replayed: false };
      const existing = toNotification((await c.query(`SELECT * FROM notifications WHERE dedupe_key = $1 AND channel = 'email' FOR UPDATE`, [dedupeKey])).rows[0]!);
      if (existing.templateKey !== req.templateKey || existing.recipientUserId !== req.recipient.userId) {
        throw new HttpProblem(422, "IDEMPOTENCY_KEY_REUSED", "This idempotency key was used for a different message");
      }
      if (existing.status === "SENT") return { n: existing, replayed: true };
      if (existing.status === "SENDING") {
        const leased = (await c.query(`SELECT lease_until > now() AS busy FROM notifications WHERE id = $1`, [existing.id])).rows[0]!.busy;
        if (leased) throw new HttpProblem(409, "IN_PROGRESS", "This message is being sent");
      }
      const { rows } = await c.query(
        `UPDATE notifications SET status = 'SENDING', attempts = 0, lease_until = now() + interval '30 seconds', updated_at = now() WHERE id = $1 RETURNING *`,
        [existing.id],
      );
      return { n: toNotification(rows[0]!), replayed: false };
    });
    if (claimed.replayed) return { notification: claimed.n, replayed: true };

    const n = claimed.n;
    const rendered = render(req.templateKey, "email", { url: req.secretData.url }, { shopBaseUrl: this.config.shopBaseUrl, fullName: req.recipient.fullName });
    const delays = [0, ...this.config.transactionalRetryDelaysMs];
    for (let i = 0; i < delays.length; i++) {
      if (delays[i]! > 0) await this.sleep(delays[i]!);
      const attempt = { ...n, attempts: i + 1 };
      try {
        const { providerMessageId } = await this.senders.email.send({ notificationId: n.id, to: req.recipient.email, ...rendered });
        await this.finish(attempt, "SENT", { providerMessageId });
        return { notification: (await this.get(n.id))!, replayed: false };
      } catch (err) {
        const lastError = (err as Error).message;
        const permanent = err instanceof PermanentDeliveryError;
        if (permanent || i === delays.length - 1) {
          await this.finish(attempt, "FAILED", { error: lastError });
          break;
        }
        await this.db.query(`INSERT INTO delivery_attempts (notification_id, attempt, outcome, error) VALUES ($1, $2, 'FAILED', $3)`, [n.id, i + 1, truncate(lastError)]);
        await this.db.query(`UPDATE notifications SET attempts = $2, last_error = $3, updated_at = now() WHERE id = $1`, [n.id, i + 1, truncate(lastError)]);
      }
    }
    this.logger.error({ notificationId: n.id, templateKey: req.templateKey }, "transactional email could not be delivered");
    throw new HttpProblem(503, "DELIVERY_FAILED", "The message could not be delivered; try again later");
  }

  // ======================================================================= queries and admin

  async get(id: string): Promise<Notification | null> {
    const { rows } = await this.db.query(`SELECT * FROM notifications WHERE id = $1`, [id]);
    return rows[0] ? toNotification(rows[0]) : null;
  }

  async preferencesOf(userId: string): Promise<Preferences> {
    const p = (await this.db.query(`SELECT * FROM preferences WHERE user_id = $1`, [userId])).rows[0];
    const r = (await this.db.query(`SELECT phone FROM recipients WHERE user_id = $1`, [userId])).rows[0];
    return {
      email: { orderUpdates: p?.email_order_updates ?? true, marketing: p?.email_marketing ?? false },
      sms: { orderUpdates: p?.sms_order_updates ?? false, phone: (r?.phone as string | null) ?? null },
    };
  }

  async setPreferences(userId: string, prefs: Preferences): Promise<Preferences> {
    await transaction(this.db, async (c) => {
      await c.query(
        `INSERT INTO preferences (user_id, email_order_updates, email_marketing, sms_order_updates) VALUES ($1, $2, $3, $4)
         ON CONFLICT (user_id) DO UPDATE SET email_order_updates = $2, email_marketing = $3, sms_order_updates = $4, updated_at = now()`,
        [userId, prefs.email.orderUpdates, prefs.email.marketing, prefs.sms.orderUpdates],
      );
      // The phone lives in the directory; a row may not exist yet if UserRegistered is still in flight.
      await c.query(
        `INSERT INTO recipients (user_id, phone) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET phone = $2, updated_at = now()`,
        [userId, prefs.sms.phone],
      );
    });
    return this.preferencesOf(userId);
  }

  async history(userId: string, limit: number, cursor?: string): Promise<{ items: Notification[]; nextCursor: string | null }> {
    return this.page(`recipient_user_id = $1`, [userId], limit, cursor);
  }

  async list(f: { status?: NotificationStatus; channel?: Channel; templateKey?: string; limit: number; cursor?: string }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (f.status) where.push(`status = $${args.push(f.status)}`);
    if (f.channel) where.push(`channel = $${args.push(f.channel)}`);
    if (f.templateKey) where.push(`template_key = $${args.push(f.templateKey)}`);
    return this.page(where.join(" AND ") || "true", args, f.limit, f.cursor);
  }

  /** Keyset paging on the (time-ordered UUIDv7) id: newest first. */
  private async page(where: string, args: unknown[], limit: number, cursor?: string) {
    const params = [...args];
    const cursorSql = cursor ? ` AND id < $${params.push(cursor)}` : "";
    params.push(limit + 1);
    const { rows } = await this.db.query(`SELECT * FROM notifications WHERE ${where}${cursorSql} ORDER BY id DESC LIMIT $${params.length}`, params);
    const items = rows.slice(0, limit).map(toNotification);
    return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null };
  }

  /** Operator retry of a FAILED notification: a fresh round of attempts, picked up by the worker. */
  async retry(id: string): Promise<Notification> {
    const n = await this.get(id);
    if (!n) throw new HttpProblem(404, "NOT_FOUND", "Notification not found");
    if (n.inMemoryOnly) throw new HttpProblem(409, "NOT_RETRYABLE", "Secret-bearing messages cannot be re-sent from here; the user requests a new link");
    if (n.status === "QUEUED" || n.status === "SENDING") return n; // already on its way: retrying is a no-op
    if (n.status !== "FAILED") throw new HttpProblem(409, "NOT_RETRYABLE", `A ${n.status} notification cannot be retried`);
    await this.db.query(
      `UPDATE notifications SET status = 'QUEUED', next_attempt_at = now(), max_attempts = attempts + $2, updated_at = now() WHERE id = $1 AND status = 'FAILED'`,
      [id, this.config.maxAttempts],
    );
    return (await this.get(id))!;
  }

  async attemptsOf(id: string) {
    const { rows } = await this.db.query(`SELECT attempt, outcome, error, at FROM delivery_attempts WHERE notification_id = $1 ORDER BY id`, [id]);
    return rows as { attempt: number; outcome: string; error: string | null; at: Date }[];
  }
}

/** Security and admin messages ignore opt-outs; account messages (welcome) go by email always. */
export function allowed(category: Category, channel: Channel, p: Preferences): boolean {
  if (category === "security" || category === "admin") return true;
  if (category === "account") return channel === "email";
  if (category === "marketing") return channel === "email" && p.email.marketing;
  return channel === "email" ? p.email.orderUpdates : p.sms.orderUpdates;
}
