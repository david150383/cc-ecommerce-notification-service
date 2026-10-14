# ecommerce-notification-service

Notifications for the e-commerce platform: email/SMS delivery driven by SQS (commands and SNS-fanned events), templates, preferences, durable delivery records, exponential-backoff retries and dead-letter monitoring. Failures here never block orders or payments.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, PostgreSQL 17 (`pg`, node-pg-migrate SQL migrations), AWS SDK v3 (SQS), Nodemailer (SMTP), jose 6, Zod 4 |
| Port | 4006 |
| Database | `notification_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 4: features | ✅ SQS consumers (events + commands) with dedupe, recipient directory, templates, preferences, durable delivery with backoff + jitter, email (SMTP/Mailpit) and console SMS, in-request secret-bearing mail for Auth, DLQ monitor and admin API. See [docs/api.md](docs/api.md) |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4006/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone Postgres on 5446 + Mailpit on 1025/8025), or in
`ecommerce-infrastructure` (whole platform: Postgres 5432, Floci 4566, Mailpit). `npm run db:migrate` applies
`migrations/`. `npm test` needs Postgres and Floci. Sent mail: http://localhost:8025.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Vitest + Supertest (in-process) and message-schema validation |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build && npm start` | Compile to `dist/` and run |
| `npm run db:migrate` / `db:rollback` | Apply / revert SQL migrations |
| `npm run openapi:export` | Regenerate `openapi/openapi.json` |
| `docker build --target runtime` / `--target migrate` | Production image / one-off migration job (non-root, multi-stage) |

## Layout

```
src/app.ts            createApp(): Express app without listen(), used by tests
src/server.ts         entry point: listen + graceful shutdown on SIGTERM/SIGINT
src/config/env.ts     validated environment
src/lib/              logger (redaction), RFC 9457 problem details
src/middleware/       correlation/request IDs, error handling
src/routes/health.ts  /health/live, /health/ready
src/api/              routes, request/response schemas
src/notifications/    NotificationService: ingest, delivery worker, secret-bearing path, admin
src/templates/        plain-text templates, categories, exact money formatting
src/channels/         SMTP email, console SMS
src/messaging/        SQS consumer, parsers (strict commands, tolerant events), DLQ monitor, workers
migrations/           SQL migrations
events/schemas        JSON Schemas for messages this service owns
events/examples       one valid example per schema
```
