# ecommerce-notification-service

Notifications for the e-commerce platform: email/SMS delivery driven by SQS (commands and SNS-fanned events), templates, preferences, durable delivery records, exponential-backoff retries and dead-letter monitoring. Failures here never block orders or payments.

| | |
|---|---|
| Stack | Node.js 24, Express 5, TypeScript 5.9, PostgreSQL 17, AWS SDK v3 (SNS/SQS) *(Phase 4)* |
| Port | 4006 |
| Database | `notification_db` (PostgreSQL), owned exclusively by this service |
| API docs | [docs/api.md](docs/api.md) |
| Messages | [docs/events.md](docs/events.md), [events/schemas](events/schemas) |

## Status

| Phase | Done |
|---|---|
| 1: skeleton | ✅ app factory, zod-validated config, pino logging with secret redaction, correlation IDs, RFC 9457 errors, health/readiness, graceful shutdown, Dockerfile, CI, message schemas with validated examples |
| 4: features | ⏳ see [docs/api.md](docs/api.md) |

## Run locally

```bash
cp .env.example .env
npm install
npm run dev            # http://localhost:4006/health/live
npm test
```

Dependencies: `docker compose up -d` here (standalone), or in `ecommerce-infrastructure` (whole platform).

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Watch mode with `.env` |
| `npm test` | Vitest + Supertest (in-process) and message-schema validation |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build && npm start` | Compile to `dist/` and run |
| `docker build -t ecommerce-notification-service .` | Production image (non-root, multi-stage) |

## Layout

```
src/app.ts            createApp(): Express app without listen(), used by tests
src/server.ts         entry point: listen + graceful shutdown on SIGTERM/SIGINT
src/config/env.ts     validated environment
src/lib/              logger (redaction), RFC 9457 problem details
src/middleware/       correlation/request IDs, error handling
src/routes/health.ts  /health/live, /health/ready
events/schemas        JSON Schemas for messages this service owns
events/examples       one valid example per schema
```
