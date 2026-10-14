import { type Request, type Response, Router } from "express";
import { HttpProblem } from "../lib/problem.js";
import { requireRole } from "../middleware/authenticate.js";
import { parse } from "../middleware/validate.js";
import type { DlqMonitor } from "../messaging/dlq-monitor.js";
import type { NotificationService } from "../notifications/notification-service.js";
import type { TokenVerifier } from "../security/token-verifier.js";
import { AdminListQuery, HistoryQuery, IdParam, PreferencesBody, TransactionalRequest, toAdminDto, toNotificationDto } from "./schemas.js";

function idempotencyKey(req: Request): string {
  const key = req.get("idempotency-key");
  if (!key || !/^[\x21-\x7e]{1,255}$/.test(key)) throw new HttpProblem(400, "IDEMPOTENCY_KEY_REQUIRED", "A valid Idempotency-Key header is required");
  return key;
}

const subject = (res: Response) => res.locals.principal!.subject;

export function notificationRouter(notifications: NotificationService, verifier: TokenVerifier, dlq: DlqMonitor | undefined): Router {
  const router = Router();
  const customer = requireRole(verifier, "customer", "admin");
  const admin = requireRole(verifier, "admin");

  router.get("/notifications/preferences", customer, async (_req, res) => {
    res.json({ preferences: await notifications.preferencesOf(subject(res)) });
  });

  router.put("/notifications/preferences", customer, async (req, res) => {
    res.json({ preferences: await notifications.setPreferences(subject(res), parse(PreferencesBody, req.body)) });
  });

  router.get("/notifications/history", customer, async (req, res) => {
    const q = parse(HistoryQuery, req.query);
    const { items, nextCursor } = await notifications.history(subject(res), q.limit, q.cursor);
    res.json({ data: items.map(toNotificationDto), page: { limit: q.limit, nextCursor } });
  });

  router.get("/admin/notifications", admin, async (req, res) => {
    const q = parse(AdminListQuery, req.query);
    const { items, nextCursor } = await notifications.list(q);
    res.json({ data: items.map(toAdminDto), page: { limit: q.limit, nextCursor } });
  });

  router.get("/admin/notifications/dead-letters", admin, async (_req, res) => {
    if (!dlq) throw new HttpProblem(503, "MESSAGING_DISABLED", "Messaging is disabled in this environment");
    res.json({ depths: await dlq.depths(), data: await dlq.peek() });
  });

  router.post("/admin/notifications/:id/retry", admin, async (req, res) => {
    const { id } = parse(IdParam, req.params);
    res.json({ notification: toAdminDto(await notifications.retry(id)) });
  });

  return router;
}

/**
 * Secret-bearing messages from Auth, by synchronous REST on purpose: a queue is durable and
 * replayable, which is wrong for one-time secrets. Only allow-listed service subjects may call.
 */
export function internalRouter(notifications: NotificationService, verifier: TokenVerifier, callers: string[]): Router {
  const router = Router();
  const service = requireRole(verifier, "service");
  router.post("/notifications/transactional", service, async (req, res) => {
    if (!callers.includes(subject(res))) throw new HttpProblem(403, "FORBIDDEN", "This service may not send transactional messages");
    const key = idempotencyKey(req);
    const body = parse(TransactionalRequest, req.body);
    const { notification, replayed } = await notifications.sendTransactional(key, body);
    if (replayed) res.setHeader("Idempotency-Replayed", "true");
    res.status(202).json({ notificationId: notification.id, status: notification.status });
  });
  return router;
}
