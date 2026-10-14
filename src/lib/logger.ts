import { pino } from "pino";

export const SERVICE_NAME = "ecommerce-notification-service";

// Secrets must never reach the logs, so redaction happens here at the logger
// level instead of relying on every call site to remember.
export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "*.password",
  "*.newPassword",
  "*.token",
  "*.accessToken",
  "*.refreshToken",
  "*.resetToken",
  "*.secret",
  "*.cardNumber",
  "*.cvv",
  // Secret-bearing message parts (reset / verification links) and rendered bodies.
  "*.secretData",
  "*.secretUrl",
  "*.text",
  "*.html",
  "*.smtpPassword",
];

export function createLogger(level: string) {
  return pino({
    level,
    base: { service: SERVICE_NAME },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: { paths: REDACT_PATHS, censor: "[REDACTED]" },
  });
}

export type Logger = ReturnType<typeof createLogger>;
