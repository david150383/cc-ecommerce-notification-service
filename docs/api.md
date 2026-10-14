# Notification Service API (v1)

Base URL (local): `http://localhost:4006`. OpenAPI: `GET /openapi.json`, Swagger UI at `/docs/`
(committed copy: [openapi/openapi.json](../openapi/openapi.json), checked by a drift test).
Conventions: `ecommerce-infrastructure/docs/architecture/conventions.md`.

## Endpoints

| Method | Path | Auth | Idempotency | Purpose |
|---|---|---|---|---|
| GET | `/api/v1/notifications/preferences` | customer | n/a | My channel preferences (defaults when never set) |
| PUT | `/api/v1/notifications/preferences` | customer | idempotent (PUT) | Replace them; SMS needs an E.164 phone number |
| GET | `/api/v1/notifications/history` | customer | n/a | My notifications: template, channel, status, times (no addresses, no data) |
| GET | `/api/v1/admin/notifications` | admin | n/a | Delivery log; filter `status`, `channel`, `templateKey`; cursor paging |
| GET | `/api/v1/admin/notifications/dead-letters` | admin | n/a | DLQ depths + a peek (identifying envelope fields only; nothing consumed) |
| POST | `/api/v1/admin/notifications/{id}/retry` | admin | no-op if already queued | A fresh round of attempts for a `FAILED` notification |
| POST | `/internal/v1/notifications/transactional` | service token, aud `ecommerce-notification-service`, subject in `TRANSACTIONAL_CALLERS` (Auth) | `Idempotency-Key` **required** | Secret-bearing email, sent now |

## Preferences

```json
{ "email": { "orderUpdates": true, "marketing": false },
  "sms":   { "orderUpdates": false, "phone": null } }
```

| Category | Templates | Preferences |
|---|---|---|
| security | `auth.verify-email`, `auth.password-reset` | **ignored**: always sent |
| account | `account.welcome` | email only, always |
| order_updates | `order.confirmed`, `order.cancelled`, `order.shipped`, `order.delivered`, `payment.refunded` | `email.orderUpdates` / `sms.orderUpdates` (SMS is opt-in) |
| admin | `admin.low-stock` | none: sent to `ADMIN_ALERT_EMAILS` |

Preferences are evaluated **at send time**, so an opt-out applies to messages already queued.

## POST /internal/v1/notifications/transactional

```json
{ "recipient": { "userId": "uuid", "email": "asha@example.com", "fullName": "Asha Rao" },
  "templateKey": "auth.password-reset",
  "data": { "fullName": "Asha Rao" },
  "secretData": { "url": "https://shop.example/reset-password?token=..." } }
```

- `202 { "notificationId", "status": "SENT" }` once the mail server accepted it. Up to 3 attempts inside
  the request (0 s, 250 ms, 1 s); then `503 DELIVERY_FAILED` and the row is `FAILED`.
- `secretData` lives only in memory for this request. It is **never** written to the database, logs, queues or
  history; the row holds template, recipient and outcome. Tests scan the whole database and the log output for
  the token. The background worker never touches these rows (it could not render them) and an admin cannot
  re-send them: the user asks for a new link, or Auth retries with the same key (it still holds the secret).
- Same `Idempotency-Key` after success: `202` with `Idempotency-Replayed: true`, nothing re-sent. Same key for a
  different template or user: `422 IDEMPOTENCY_KEY_REUSED`. While another request holds it: `409 IN_PROGRESS`.

Why REST, not a queue: queues are durable and replayable, the wrong properties for one-time secrets.

## Delivery model

- One `notifications` row per (dedupe key, channel), e.g. `order-confirmed:<orderId>` × email/sms, so redelivered
  events and re-sent commands never produce a second message.
- Status `QUEUED → SENDING → SENT | FAILED | SKIPPED` (`OPTED_OUT`, `NO_PHONE`). Every attempt is recorded in
  `delivery_attempts`.
- The worker claims due rows with `FOR UPDATE SKIP LOCKED` and a lease (several instances never send the same
  row). A worker that dies mid-send: the lease expires and the row is retried, so delivery is **at-least-once**;
  the stable `Message-ID: <notificationId@…>` lets mail systems recognise a repeat.
- Recipient address and name are resolved **at send time** from the local directory. An order email that arrives
  before `UserRegistered` (topics are not ordered relative to each other) retries until the directory catches up.
- Retries: exponential backoff with full jitter, uniform in `[0, min(RETRY_CAP_MS, RETRY_BASE_MS · 2^(n-1))]`
  (defaults 30 s, 1 h, 6 attempts). SMTP 5xx and template errors fail at once. After the last attempt the row is
  `FAILED` and an error is logged; an admin can retry it.
- Channels: email over SMTP (Mailpit locally; production requires TLS), SMS via a console adapter that logs the
  masked number and length only. Push: not in v1 (a `NotificationRequested` for push goes to the DLQ).
- Templates are plain text: a name like `<script>` is shown literally, never interpreted.
