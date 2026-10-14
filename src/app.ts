import cors from "cors";
import express, { type Express } from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import swaggerUi from "swagger-ui-express";
import { internalRouter, notificationRouter } from "./api/routes.js";
import type { Env } from "./config/env.js";
import type { Logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestContext } from "./middleware/request-context.js";
import type { DlqMonitor } from "./messaging/dlq-monitor.js";
import type { NotificationService } from "./notifications/notification-service.js";
import { buildOpenApiDocument } from "./openapi/document.js";
import { healthRouter, type ReadinessCheck } from "./routes/health.js";
import type { TokenVerifier } from "./security/token-verifier.js";

export interface AppDependencies {
  env: Env;
  logger: Logger;
  notifications: NotificationService;
  verifier: TokenVerifier;
  /** Absent when messaging is disabled. */
  dlq?: DlqMonitor | undefined;
  readinessChecks?: ReadinessCheck[];
}

// Builds the Express app without starting a server, so tests can drive it
// in-process with Supertest.
export function createApp({ env, logger, notifications, verifier, dlq, readinessChecks = [] }: AppDependencies): Express {
  const app = express();

  app.disable("x-powered-by");
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ALLOWED_ORIGINS, credentials: true, exposedHeaders: ["X-Correlation-Id", "X-Request-Id", "Idempotency-Replayed"] }));
  app.use(requestContext);
  app.use(
    pinoHttp({
      logger,
      genReqId: (_req, res) => res.locals.requestId as string,
      customProps: (_req, res) => ({ correlationId: res.locals.correlationId as string }),
      autoLogging: { ignore: (req) => req.url?.startsWith("/health") ?? false },
      // Log only what is useful for tracing; headers can carry credentials and are noisy.
      serializers: {
        req: (req: { id: string; method: string; url: string }) => ({ id: req.id, method: req.method, url: req.url }),
        res: (res: { statusCode: number }) => ({ statusCode: res.statusCode }),
      },
    }),
  );
  app.use(express.json({ limit: "100kb" }));

  app.use(healthRouter(readinessChecks));
  const openApi = buildOpenApiDocument();
  app.get("/openapi.json", (_req, res) => {
    res.json(openApi);
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(openApi));
  app.use("/api/v1", notificationRouter(notifications, verifier, dlq));
  app.use("/internal/v1", internalRouter(notifications, verifier, env.TRANSACTIONAL_CALLERS));

  app.use(notFoundHandler);
  app.use(errorHandler(logger));
  return app;
}
