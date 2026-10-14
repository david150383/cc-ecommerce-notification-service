# Notification Service: messages

Schemas: [`events/schemas/`](../events/schemas). Examples: [`events/examples/`](../events/examples).

## Consumed commands (owned here, SQS `notification-commands`)

| Command | Senders | Idempotency |
|---|---|---|
| `NotificationRequested` v1 | Saga, Order, Payment (none send it yet) | `idempotencyKey` required: one notification per (key, channel). Validated strictly against this service's schema. Unknown templates, `security` templates (secrets never travel through queues), unsupported channels → not deleted → DLQ |

## Consumed events (SQS `notification-inbox`, raw SNS delivery; schemas owned by the producers)

| Event | Producer | Result |
|---|---|---|
| `UserRegistered` | Auth | Upserts the **recipient directory** (userId → email, name); welcome email |
| `UserEmailVerified` | Auth | Updates the directory |
| `OrderConfirmed` | Order | `order.confirmed` (email + SMS if opted in) |
| `OrderCancelled` | Order | `order.cancelled`, with the reason in plain words |
| `OrderStatusChanged` | Order | `SHIPPED` / `DELIVERED` only; other transitions ignored |
| `PaymentFailed` | Payment | **Nothing**: the checkout is cancelled and `OrderCancelled` (reason `PAYMENT_FAILED`) tells the customer; two emails for one failure would be noise |
| `RefundSucceeded` | Payment | `payment.refunded` |
| `InventoryLowStock` | Inventory | `admin.low-stock` to each `ADMIN_ALERT_EMAILS` address |

Only the envelope is checked strictly (`messageId`, `messageKind: event`, `messageType`, `correlationId`, `payload`);
each payload is validated for the fields actually used, tolerating additions, so a producer adding a field never
breaks this consumer. A payload missing a used field can never succeed → DLQ. Event types not listed are
acknowledged and ignored.

Dedupe: `processed_messages` (per `messageId`) in the same transaction as the enqueue, plus the
(dedupe key, channel) constraint for the same fact arriving under a new message id.

**Recipient directory.** Events carry `customerId`, not addresses. This service keeps its own copy of contact
details from Auth's events (*event-carried state transfer*) and never queries the Auth database.

**Failures never block business flows.** No producer waits for a notification.

## Produced

None.
