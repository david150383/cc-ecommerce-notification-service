import { z } from "zod";

const bool = z.enum(["true", "false"]).transform((v) => v === "true");
/** Comma-separated list; the default is given as the raw string. */
const list = (fallback = "") =>
  z
    .string()
    .default(fallback)
    .transform((value) =>
      value
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean),
    );

// All configuration comes from environment variables and is validated once at
// startup. The process refuses to boot with invalid config, rather than failing
// later on the first request that touches it.
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
    PORT: z.coerce.number().int().min(1).max(65535).default(4006),
    LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).default("info"),
    CORS_ALLOWED_ORIGINS: list("http://localhost:5173"),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),

    DATABASE_URL: z.string().startsWith("postgresql://"),

    // Incoming tokens.
    JWKS_URL: z.url().default("http://localhost:4001/.well-known/jwks.json"),
    JWT_ISSUER: z.string().default("ecommerce-auth-service"),
    JWT_AUDIENCE: z.string().default("ecommerce-api"),
    JWT_SERVICE_AUDIENCE: z.string().default("ecommerce-notification-service"),
    /// Service-token subjects allowed to send secret-bearing (transactional) messages.
    TRANSACTIONAL_CALLERS: list("ecommerce-auth-service"),

    // Channels.
    SMTP_HOST: z.string().default("localhost"),
    SMTP_PORT: z.coerce.number().int().min(1).max(65535).default(1025),
    SMTP_SECURE: bool.default(false),
    SMTP_USER: z.string().optional(),
    SMTP_PASSWORD: z.string().optional(),
    EMAIL_FROM: z.string().default("Shop <no-reply@shop.local>"),
    SMS_PROVIDER: z.enum(["console"]).default("console"),
    /// Where admin alerts (e.g. low stock) go.
    ADMIN_ALERT_EMAILS: list(),
    SHOP_BASE_URL: z.url().default("http://localhost:5173"),

    // Delivery: exponential backoff with full jitter.
    DELIVERY_INTERVAL_MS: z.coerce.number().int().min(0).default(1_000),
    MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(6),
    RETRY_BASE_MS: z.coerce.number().int().min(1).default(30_000),
    RETRY_CAP_MS: z.coerce.number().int().min(1).default(3_600_000),
    DELIVERY_LEASE_MS: z.coerce.number().int().min(1_000).default(60_000),

    // Messaging.
    MESSAGING_ENABLED: bool.default(false),
    AWS_REGION: z.string().default("us-east-1"),
    AWS_ENDPOINT_URL: z.url().optional(),
    COMMANDS_QUEUE_NAME: z.string().default("local-ecommerce-notification-commands"),
    INBOX_QUEUE_NAME: z.string().default("local-ecommerce-notification-inbox"),
    /// This service's DLQs, watched by the DLQ monitor and shown on the admin API.
    DLQ_NAMES: list("local-ecommerce-notification-commands-dlq,local-ecommerce-notification-inbox-dlq"),
    DLQ_CHECK_INTERVAL_MS: z.coerce.number().int().min(0).default(60_000),
    CONSUMER_WAIT_TIME_SECONDS: z.coerce.number().int().min(0).max(20).default(20),
  })
  .refine((e) => e.RETRY_BASE_MS <= e.RETRY_CAP_MS, { message: "RETRY_BASE_MS must not exceed RETRY_CAP_MS", path: ["RETRY_BASE_MS"] })
  .refine((e) => e.NODE_ENV !== "production" || e.SMTP_SECURE || e.SMTP_PORT === 587, {
    message: "production SMTP must use TLS (SMTP_SECURE=true or STARTTLS on 587)",
    path: ["SMTP_SECURE"],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  // An empty variable means "not set" (Compose passes `KEY: ${KEY:-}` through as "").
  const result = EnvSchema.safeParse(Object.fromEntries(Object.entries(source).filter(([, v]) => v !== "")));
  if (!result.success) {
    throw new Error(`Invalid environment configuration:\n${z.prettifyError(result.error)}`);
  }
  return result.data;
}
