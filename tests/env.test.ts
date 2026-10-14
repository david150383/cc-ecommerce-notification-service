import { describe, expect, it } from "vitest";
import { loadEnv } from "../src/config/env.js";

const required = { DATABASE_URL: "postgresql://u:p@localhost:5432/notification_db" };

describe("loadEnv", () => {
  it("applies defaults", () => {
    const env = loadEnv(required);
    expect(env.PORT).toBe(4006);
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["http://localhost:5173"]);
    expect(env.TRANSACTIONAL_CALLERS).toEqual(["ecommerce-auth-service"]);
    expect(env.ADMIN_ALERT_EMAILS).toEqual([]);
    expect(env.MAX_ATTEMPTS).toBe(6);
  });

  it("parses comma-separated lists; an empty variable means unset", () => {
    const env = loadEnv({ ...required, CORS_ALLOWED_ORIGINS: "https://a.example, https://b.example", ADMIN_ALERT_EMAILS: "", SMTP_USER: "" });
    expect(env.CORS_ALLOWED_ORIGINS).toEqual(["https://a.example", "https://b.example"]);
    expect(env.ADMIN_ALERT_EMAILS).toEqual([]);
    expect(env.SMTP_USER).toBeUndefined();
  });

  it("rejects invalid configuration at startup", () => {
    expect(() => loadEnv({ ...required, PORT: "not-a-port" })).toThrow(/Invalid environment configuration/);
    expect(() => loadEnv({})).toThrow(/DATABASE_URL/);
    expect(() => loadEnv({ ...required, RETRY_BASE_MS: "10", RETRY_CAP_MS: "5" })).toThrow(/RETRY_BASE_MS/);
  });

  it("refuses plaintext SMTP in production", () => {
    expect(() => loadEnv({ ...required, NODE_ENV: "production" })).toThrow(/TLS/);
    expect(loadEnv({ ...required, NODE_ENV: "production", SMTP_PORT: "587" }).SMTP_PORT).toBe(587);
  });
});
