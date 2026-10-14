import { createApp } from "./app.js";
import { ConsoleSmsSender, SmtpEmailSender } from "./channels/channels.js";
import { loadEnv } from "./config/env.js";
import { createPool } from "./db/pool.js";
import { createLogger } from "./lib/logger.js";
import { createSqs } from "./messaging/aws.js";
import { DlqMonitor } from "./messaging/dlq-monitor.js";
import { createWorkers } from "./messaging/runner.js";
import { NotificationService } from "./notifications/notification-service.js";
import { TokenVerifier } from "./security/token-verifier.js";

const env = loadEnv();
const logger = createLogger(env.LOG_LEVEL);
const db = createPool(env.DATABASE_URL);
const sqs = createSqs(env);

const email = new SmtpEmailSender(
  { host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE, user: env.SMTP_USER, password: env.SMTP_PASSWORD },
  env.EMAIL_FROM,
);
const notifications = new NotificationService(
  db,
  { email, sms: new ConsoleSmsSender(logger) },
  {
    maxAttempts: env.MAX_ATTEMPTS,
    retryBaseMs: env.RETRY_BASE_MS,
    retryCapMs: env.RETRY_CAP_MS,
    leaseMs: env.DELIVERY_LEASE_MS,
    shopBaseUrl: env.SHOP_BASE_URL,
    adminAlertEmails: env.ADMIN_ALERT_EMAILS,
    transactionalRetryDelaysMs: [250, 1_000],
  },
  logger,
);
const dlq = env.MESSAGING_ENABLED ? new DlqMonitor(sqs, env.DLQ_NAMES, logger) : undefined;
const workers = createWorkers(env, sqs, notifications, dlq, logger);

let shuttingDown = false;

const app = createApp({
  env,
  logger,
  notifications,
  dlq,
  verifier: new TokenVerifier({ jwksUrl: env.JWKS_URL, issuer: env.JWT_ISSUER, audiences: [env.JWT_AUDIENCE, env.JWT_SERVICE_AUDIENCE] }),
  readinessChecks: [
    {
      // Report "not ready" as soon as shutdown starts, so the load balancer
      // stops sending new requests while in-flight ones finish.
      name: "accepting-traffic",
      check: async () => {
        if (shuttingDown) throw new Error("shutting down");
      },
    },
    { name: "database", check: async () => void (await db.query("SELECT 1")) },
    // Not SMTP: a mail outage must not take the service out of rotation (messages queue and retry).
  ],
});

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT }, "server listening");
  workers.start();
});

function shutdown(signal: NodeJS.Signals): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "shutdown started");

  server.close((err) => {
    void workers
      .stop()
      .then(() => db.end())
      .finally(() => {
        if (err) {
          logger.error({ err }, "error while closing server");
          process.exit(1);
        }
        logger.info("shutdown complete");
        process.exit(0);
      });
  });
  server.closeIdleConnections();

  setTimeout(() => {
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, "forced shutdown after timeout");
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS).unref();
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
