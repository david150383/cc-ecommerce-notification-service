import { z } from "../lib/zod.js";
import type { Notification, Preferences } from "../notifications/notification-service.js";

export const PreferencesBody = z
  .object({
    email: z.object({ orderUpdates: z.boolean(), marketing: z.boolean() }).strict(),
    sms: z
      .object({
        orderUpdates: z.boolean(),
        phone: z.string().regex(/^\+[1-9]\d{7,14}$/, "E.164, e.g. +919800000001").nullable(),
      })
      .strict(),
  })
  .strict()
  .refine((p) => !p.sms.orderUpdates || p.sms.phone !== null, { message: "SMS updates need a phone number", path: ["sms", "phone"] })
  .openapi("Preferences", { description: "Security messages (verification, password reset) are always sent, whatever these say." });

export const TransactionalRequest = z
  .object({
    recipient: z.object({ userId: z.uuid(), email: z.email().max(320), fullName: z.string().min(1).max(200) }).strict(),
    templateKey: z.enum(["auth.verify-email", "auth.password-reset"]),
    data: z.object({ fullName: z.string().max(200).optional() }).strict().optional(),
    secretData: z
      .object({ url: z.url().max(2_000) })
      .strict()
      .openapi({ description: "Used in memory to render the message. Never stored, logged or queued." }),
  })
  .strict()
  .openapi("TransactionalRequest");

const status = z.enum(["QUEUED", "SENDING", "SENT", "FAILED", "SKIPPED"]);
const cursorPage = { limit: z.coerce.number().int().min(1).max(100).default(20), cursor: z.uuid().optional() };

export const HistoryQuery = z.object(cursorPage).strict();
export const AdminListQuery = z
  .object({ ...cursorPage, status: status.optional(), channel: z.enum(["email", "sms"]).optional(), templateKey: z.string().max(100).optional() })
  .strict();
export const IdParam = z.object({ id: z.uuid() });

export const NotificationDto = z
  .object({
    id: z.uuid(),
    channel: z.enum(["email", "sms"]),
    templateKey: z.string(),
    status,
    skipReason: z.string().nullable(),
    attempts: z.number().int(),
    createdAt: z.iso.datetime(),
    sentAt: z.iso.datetime().nullable(),
  })
  .openapi("Notification");

export const AdminNotificationDto = NotificationDto.extend({
  recipientUserId: z.uuid().nullable(),
  maxAttempts: z.number().int(),
  nextAttemptAt: z.iso.datetime(),
  lastError: z.string().nullable(),
  sourceType: z.string().nullable(),
}).openapi("AdminNotification");

export const DeadLetterDto = z
  .object({
    queue: z.string(),
    sqsMessageId: z.string(),
    receiveCount: z.number().int(),
    sentAt: z.string().nullable(),
    messageId: z.string().nullable(),
    messageType: z.string().nullable(),
    correlationId: z.string().nullable(),
  })
  .openapi("DeadLetter");

export function toNotificationDto(n: Notification): z.infer<typeof NotificationDto> {
  return {
    id: n.id,
    channel: n.channel,
    templateKey: n.templateKey,
    status: n.status,
    skipReason: n.skipReason,
    attempts: n.attempts,
    createdAt: n.createdAt.toISOString(),
    sentAt: n.sentAt?.toISOString() ?? null,
  };
}

/** Admin view: adds delivery internals. Never the address or template data (personal data). */
export function toAdminDto(n: Notification): z.infer<typeof AdminNotificationDto> {
  return {
    ...toNotificationDto(n),
    recipientUserId: n.recipientUserId,
    maxAttempts: n.maxAttempts,
    nextAttemptAt: n.nextAttemptAt.toISOString(),
    lastError: n.lastError,
    sourceType: n.sourceType,
  };
}

export const toPreferencesDto = (p: Preferences) => p;
