# Notification Service: messages

Schemas: [`events/schemas/`](../events/schemas). Examples: [`events/examples/`](../events/examples).

## Consumed commands (owned here, SQS `notification-commands`)

| Command | Senders | Idempotency |
|---|---|---|
| `NotificationRequested` v1 | Saga, Order, Payment | `idempotencyKey` required. Unique `(idempotency_key, channel)` constraint |

## Consumed events (SQS `notification-inbox`, schemas owned by producers)

| Event | Producer | Resulting notification |
|---|---|---|
| `UserRegistered` | Auth | Welcome email. Also upserts the local **recipient directory** (userId → email, name) |
| `UserEmailVerified` | Auth | Updates recipient directory |
| `OrderConfirmed` | Order | Order confirmation |
| `OrderCancelled` | Order | Cancellation notice |
| `OrderStatusChanged` | Order | Shipped / delivered updates (other transitions ignored) |
| `PaymentFailed` | Payment | Payment failed, retry link |
| `RefundSucceeded` | Payment | Refund confirmation |
| `InventoryLowStock` | Inventory | Admin alert email |

**Recipient directory.** Events carry `customerId`, not email addresses. This service keeps its
own copy of contact details, built from `UserRegistered`/`UserEmailVerified`. This is
*event-carried state transfer*: Notification never queries the Auth database.

**Failures never block business flows.** No producer waits for a notification. Delivery
problems stay inside this service (retries, then DLQ + alarm).

## Produced

None in v1.
