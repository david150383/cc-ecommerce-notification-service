import { OpenApiGeneratorV31, OpenAPIRegistry, type RouteConfig } from "@asteasolutions/zod-to-openapi";
import { AdminListQuery, AdminNotificationDto, DeadLetterDto, HistoryQuery, NotificationDto, PreferencesBody, TransactionalRequest } from "../api/schemas.js";
import { z } from "../lib/zod.js";

// Built from the SAME zod schemas that validate requests; a test compares it with openapi/openapi.json.
const Problem = z.object({ type: z.string(), title: z.string(), status: z.number().int(), code: z.string(), instance: z.string() }).catchall(z.unknown()).openapi("Problem");
const json = <T extends z.ZodType>(schema: T, description: string) => ({ description, content: { "application/json": { schema } } });
const problem = (description: string) => ({ description, content: { "application/problem+json": { schema: Problem } } });
const body = <T extends z.ZodType>(schema: T) => ({ body: { content: { "application/json": { schema } } } });
const page = z.object({ limit: z.number().int(), nextCursor: z.string().nullable() });

export function buildOpenApiDocument() {
  const registry = new OpenAPIRegistry();
  const bearer = registry.registerComponent("securitySchemes", "bearerAuth", { type: "http", scheme: "bearer", bearerFormat: "JWT" });
  const secured = [{ [bearer.name]: [] }];
  const prefs = json(z.object({ preferences: PreferencesBody }), "Preferences");
  const paths: RouteConfig[] = [
    { method: "get", path: "/api/v1/notifications/preferences", tags: ["preferences"], security: secured, summary: "My channel preferences", responses: { 200: prefs } },
    {
      method: "put", path: "/api/v1/notifications/preferences", tags: ["preferences"], security: secured, summary: "Replace my channel preferences",
      request: body(PreferencesBody), responses: { 200: prefs, 400: problem("VALIDATION_FAILED") },
    },
    {
      method: "get", path: "/api/v1/notifications/history", tags: ["preferences"], security: secured, summary: "My notifications, newest first",
      request: { query: HistoryQuery }, responses: { 200: json(z.object({ data: z.array(NotificationDto), page }), "History") },
    },
    {
      method: "get", path: "/api/v1/admin/notifications", tags: ["admin"], security: secured, summary: "Delivery log (admin)",
      request: { query: AdminListQuery }, responses: { 200: json(z.object({ data: z.array(AdminNotificationDto), page }), "Notifications") },
    },
    {
      method: "get", path: "/api/v1/admin/notifications/dead-letters", tags: ["admin"], security: secured, summary: "Peek at this service's DLQs (admin)",
      responses: { 200: json(z.object({ depths: z.record(z.string(), z.number().int()), data: z.array(DeadLetterDto) }), "Dead letters"), 503: problem("MESSAGING_DISABLED") },
    },
    {
      method: "post", path: "/api/v1/admin/notifications/{id}/retry", tags: ["admin"], security: secured, summary: "Re-queue a FAILED notification (admin)",
      request: { params: z.object({ id: z.uuid() }) },
      responses: { 200: json(z.object({ notification: AdminNotificationDto }), "Queued"), 404: problem("NOT_FOUND"), 409: problem("NOT_RETRYABLE") },
    },
    {
      method: "post", path: "/internal/v1/notifications/transactional", tags: ["internal"], security: secured,
      summary: "Send a secret-bearing message now (service token from Auth only)",
      request: { ...body(TransactionalRequest), headers: z.object({ "idempotency-key": z.string().min(1).max(255) }) },
      responses: {
        202: json(z.object({ notificationId: z.uuid(), status: z.enum(["SENT"]) }), "Sent (or already sent: Idempotency-Replayed)"),
        403: problem("FORBIDDEN"), 409: problem("IN_PROGRESS"), 422: problem("IDEMPOTENCY_KEY_REUSED"), 503: problem("DELIVERY_FAILED"),
      },
    },
  ];
  paths.forEach((p) => registry.registerPath(p));
  return new OpenApiGeneratorV31(registry.definitions).generateDocument({
    openapi: "3.1.0",
    info: { title: "Notification Service", version: "1.0.0", description: "Email/SMS notifications, preferences, delivery log. Semantics: docs/api.md" },
    servers: [{ url: "http://localhost:4006" }],
  });
}
