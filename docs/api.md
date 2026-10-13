# Notification Service API (v1)

Base URL (local): `http://localhost:4006`. Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.
Status: **documented, not yet implemented** (Phase 4). Implemented today: health endpoints only.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/notifications/preferences` | customer | n/a | Current user's channel preferences |
| PUT | `/api/v1/notifications/preferences` | customer | idempotent (PUT) | Update preferences |
| GET | `/api/v1/notifications/history` | customer | n/a | Current user's delivered notifications |
| GET | `/api/v1/admin/notifications` | admin | n/a | Delivery log, filter by status/channel/template |
| GET | `/api/v1/admin/notifications/dead-letters` | admin | n/a | Messages in this service's DLQs (peek) |
| POST | `/api/v1/admin/notifications/{id}/retry` | admin | idempotent | Re-queue a failed delivery |
| POST | `/internal/v1/notifications/transactional` | service token (auth-service only) | `Idempotency-Key` | Send secret-bearing messages (reset / verification links) |

## Preferences

```json
{ "email": { "marketing": false, "orderUpdates": true },
  "sms":   { "orderUpdates": false } }
```
Security and account messages (password reset, verification) ignore opt-outs.

## POST /internal/v1/notifications/transactional

```json
{ "recipient": { "userId": "uuid", "email": "asha@example.com" },
  "templateKey": "auth.password-reset",
  "data": { "fullName": "Asha Rao" },
  "secretData": { "resetUrl": "https://shop.example/reset-password?token=..." } }
```
`202 { "notificationId": "uuid" }`. `secretData` is used only in memory to render the message.
It is **never** written to the database, logs, queues, or delivery history. The stored record
keeps the template key, recipient, status and timestamps only.

## Delivery model

- `notifications` row per (message, channel), status `QUEUED → SENDING → SENT | FAILED | SKIPPED_BY_PREFERENCE`.
- Retries: exponential backoff with full jitter (base 30s, cap 1h, max 6 attempts), stored in
  `delivery_attempts`. After the last attempt the row is `FAILED` and an alarm metric fires.
- Provider idempotency: the notification ID is passed as the provider's idempotency/message ID
  where supported, so a retry after a timeout does not send two emails.
- Channels: email (SMTP via Mailpit locally, SES or a provider later), SMS (console adapter locally,
  provider later), push (optional, later).
