import { Writable } from "node:stream";
import { type CryptoKey, exportJWK, generateKeyPair, type JSONWebKeySet, SignJWT } from "jose";
import { pino } from "pino";
import { v7 as uuidv7 } from "uuid";
import { createApp } from "../src/app.js";
import { type ChannelSender, type OutgoingMessage, PermanentDeliveryError } from "../src/channels/channels.js";
import { loadEnv } from "../src/config/env.js";
import { createPool, type Pool } from "../src/db/pool.js";
import { REDACT_PATHS } from "../src/lib/logger.js";
import type { DlqMonitor } from "../src/messaging/dlq-monitor.js";
import type { InboundMessage } from "../src/messaging/message-consumer.js";
import { type DeliveryConfig, NotificationService } from "../src/notifications/notification-service.js";
import type { ReadinessCheck } from "../src/routes/health.js";
import { TokenVerifier } from "../src/security/token-verifier.js";
import { TEST_DATABASE_URL } from "./global-setup.js";

/** Records what would have been sent; can be told to fail the next N sends. */
export class FakeSender implements ChannelSender {
  readonly sent: OutgoingMessage[] = [];
  private failures: ("transient" | "permanent")[] = [];

  failNext(n: number, kind: "transient" | "permanent" = "transient") {
    this.failures.push(...Array.from({ length: n }, () => kind));
  }

  async send(m: OutgoingMessage) {
    const f = this.failures.shift();
    if (f === "permanent") throw new PermanentDeliveryError("SMTP 550 mailbox unavailable");
    if (f === "transient") throw new Error("connect ECONNREFUSED 127.0.0.1:1025");
    this.sent.push(m);
    return { providerMessageId: `<${m.notificationId}@test>` };
  }
}

let keys: Promise<{ privateKey: CryptoKey; jwks: JSONWebKeySet }> | undefined;
function testKeys() {
  keys ??= generateKeyPair("RS256").then(async ({ privateKey, publicKey }) => ({
    privateKey,
    jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: "test-key", alg: "RS256", use: "sig" }] },
  }));
  return keys;
}

export async function auth(roles: string[], sub = uuidv7()) {
  const { privateKey } = await testKeys();
  const token = await new SignJWT({ roles })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuer("ecommerce-auth-service")
    .setAudience(roles.includes("service") ? "ecommerce-notification-service" : "ecommerce-api")
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime("15m")
    .sign(privateKey);
  return { Authorization: `Bearer ${token}` };
}

let pool: Pool | undefined;
export function testPool(): Pool {
  pool ??= createPool(TEST_DATABASE_URL, 20);
  return pool;
}

export async function resetDatabase(): Promise<void> {
  await testPool().query("TRUNCATE notifications, delivery_attempts, processed_messages, recipients, preferences CASCADE");
}

/** A logger that keeps every line (at debug level), using the service's real redaction config. */
function capturingLogger(lines: string[]) {
  return pino(
    { level: "debug", redact: { paths: REDACT_PATHS, censor: "[REDACTED]" } },
    new Writable({ write: (chunk, _e, cb) => (lines.push(String(chunk)), cb()) }),
  );
}

export const DELIVERY: DeliveryConfig = {
  maxAttempts: 3,
  retryBaseMs: 1_000,
  retryCapMs: 60_000,
  leaseMs: 60_000,
  shopBaseUrl: "http://localhost:5173",
  adminAlertEmails: ["ops@shop.local"],
  transactionalRetryDelaysMs: [1, 1],
};

export async function buildTestContext(opts: { overrides?: Record<string, string>; readinessChecks?: ReadinessCheck[]; dlq?: DlqMonitor; delivery?: Partial<DeliveryConfig> } = {}) {
  const env = loadEnv({ NODE_ENV: "test", LOG_LEVEL: "silent", DATABASE_URL: TEST_DATABASE_URL, ...opts.overrides });
  const logLines: string[] = [];
  const logger = capturingLogger(logLines);
  const email = new FakeSender();
  const sms = new FakeSender();
  // random() = 1 makes backoff deterministic: the full ceiling.
  const notifications = new NotificationService(testPool(), { email, sms }, { ...DELIVERY, ...opts.delivery }, logger, () => 1, async () => undefined);
  const verifier = new TokenVerifier(
    { jwksUrl: "http://unused.invalid/jwks", issuer: "ecommerce-auth-service", audiences: ["ecommerce-api", "ecommerce-notification-service"] },
    (await testKeys()).jwks,
  );
  const app = createApp({ env, logger, notifications, verifier, dlq: opts.dlq, readinessChecks: opts.readinessChecks ?? [] });
  return { app, env, logger, logLines, notifications, email, sms, db: testPool() };
}

/** For tests that only need the HTTP shell (health, errors, headers). */
export async function buildTestApp(readinessChecks: ReadinessCheck[] = []) {
  return (await buildTestContext({ readinessChecks })).app;
}

export const newId = () => uuidv7();

export function event(messageType: string, payload: Record<string, unknown>, messageId = uuidv7()): InboundMessage {
  return { messageId, messageType, correlationId: uuidv7(), payload };
}

/** Makes every queued notification due now (instead of waiting out the backoff). */
export async function makeDue(): Promise<void> {
  await testPool().query(`UPDATE notifications SET next_attempt_at = now() WHERE status = 'QUEUED'`);
}

export async function rows() {
  const { rows } = await testPool().query(`SELECT * FROM notifications ORDER BY created_at, channel`);
  return rows as Record<string, unknown>[];
}
