import { randomUUID } from "node:crypto";
import cors from "cors";
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";

import { loadConfig, type AppConfig } from "../config.js";
import { isTrustedProxyAddress } from "../http/clientIp.js";
import { respondWithUnexpectedError } from "../http/errors.js";
import { getMetricsContentType, getMetricsSnapshot } from "../observability/metrics.js";
import { getRequestContext, runWithContext, type RequestContext, updateContextIdentifiers } from "../observability/requestContext.js";
import { appLogger, normalizeError } from "../observability/logger.js";
import { getPolicyEnforcer } from "../policy/PolicyEnforcer.js";
import { SseQuotaManager } from "./SseQuotaManager.js";
import { getRequestIds } from "../http/helpers.js";
import { attachSession } from "../middleware/auth.js";
import { createSecurityHeadersMiddleware, determineCorsOptions } from "../middleware/security.js";
import type { ExtendedRequest } from "../http/types.js";
import { createRateLimitStore } from "../rateLimit/store.js";

// Controllers
import { PlanController } from "../controllers/PlanController.js";
import { ChatController } from "../controllers/ChatController.js";
import { SecretController } from "../controllers/SecretController.js";
import { AuthController } from "../controllers/AuthController.js";
import { RemoteFsController } from "../controllers/RemoteFsController.js";
import { CasesController } from "../controllers/CasesController.js";

function resolveConfig(config?: AppConfig): AppConfig {
  return config ?? loadConfig();
}

export function createServer(config?: AppConfig): Express {
  const appConfig = resolveConfig(config);
  const app = express();
  const policy = getPolicyEnforcer();
  
  const rateLimiter = createRateLimitStore(appConfig.server.rateLimits.backend);
  const quotaManager = new SseQuotaManager(appConfig.server.sseQuotas);

  const planController = new PlanController(appConfig, policy, rateLimiter, quotaManager);
  const chatController = new ChatController(appConfig, rateLimiter, policy);
  const secretController = new SecretController(appConfig, policy, rateLimiter);
  const authController = new AuthController(appConfig, rateLimiter);
  const remoteFsController = new RemoteFsController(appConfig, rateLimiter);
  const casesController = new CasesController(appConfig, policy, rateLimiter);

  if (appConfig.server.trustedProxyCidrs.length > 0) {
    app.set("trust proxy", (ip: string) =>
      isTrustedProxyAddress(ip, appConfig.server.trustedProxyCidrs),
    );
  }

  app.use((req: Request, res: Response, next: NextFunction) => {
    const headerRequestId = req.header("x-request-id")?.trim();
    const headerTraceId = req.header("x-trace-id")?.trim();
    const requestId =
      headerRequestId && headerRequestId.length > 0
        ? headerRequestId
        : randomUUID();
    const traceId =
      headerTraceId && headerTraceId.length > 0 ? headerTraceId : randomUUID();
    res.locals.requestId = requestId;
    res.locals.traceId = traceId;
    res.setHeader("x-request-id", requestId);
    res.setHeader("x-trace-id", traceId);
    const context: RequestContext = { requestId, traceId };
    runWithContext(context, () => {
      return new Promise<void>((resolve) => {
        let completed = false;
        const complete = () => {
          if (completed) {
            return;
          }
          completed = true;
          res.off("finish", complete);
          res.off("close", complete);
          resolve();
        };

        res.once("finish", complete);
        res.once("close", complete);

        const wrappedNext: NextFunction = (err?: unknown) => {
          if (err !== undefined) {
            complete();
          }
          return next(err);
        };

        try {
          wrappedNext();
        } catch (error) {
          complete();
          throw error;
        }
      });
    });
  });

  app.use(createSecurityHeadersMiddleware(appConfig));

  app.use(cors(determineCorsOptions(appConfig)));
  app.use(express.json({ limit: appConfig.server.requestLimits.jsonBytes }));
  app.use(
    express.urlencoded({
      extended: true,
      limit: appConfig.server.requestLimits.urlEncodedBytes,
    }),
  );

  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = Date.now();
    res.on("finish", () => {
      const duration = Date.now() - start;
      const { requestId, traceId } = getRequestIds(res);
      appLogger.info(
        {
          event: "http.request",
          method: req.method,
          path: req.originalUrl,
          status: res.statusCode,
          durationMs: duration,
          requestId,
          traceId,
        },
        "handled http request",
      );
    });
    next();
  });

  app.use((req: Request, _res: Response, next: NextFunction) => {
    attachSession(req as ExtendedRequest, appConfig);
    next();
  });

  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/readyz", (_req, res) => {
    const { requestId, traceId } = getRequestIds(res);
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptimeSeconds: process.uptime(),
      requestId,
      traceId,
      details: {
        queue: { status: "ok" },
      },
    });
  });

  app.get("/metrics", async (_req, res) => {
    try {
      const snapshot = await getMetricsSnapshot();
      res.setHeader("Content-Type", getMetricsContentType());
      res.send(snapshot);
    } catch (error) {
      appLogger.error(
        { err: normalizeError(error) },
        "failed to collect metrics",
      );
      respondWithUnexpectedError(res, error);
    }
  });

  app.get("/slo/status", async (_req, res) => {
    try {
      const { sloMonitor } = await import("../index.js");
      const summary = await sloMonitor.getSummary();
      res.json(summary);
    } catch (error) {
       appLogger.error(
        { err: normalizeError(error) },
        "failed to collect slo status",
      );
      respondWithUnexpectedError(res, error);
    }
  });

  app.post("/plan", (req, res) => planController.createPlan(req as ExtendedRequest, res));
  app.get("/plan/:id/events", (req, res) => planController.getPlanEvents(req as ExtendedRequest, res));
  app.post("/plan/:id/steps/:stepId/approve", (req, res) => planController.approveStep(req as ExtendedRequest, res));
  app.post("/plan/:id/steps/:stepId/reject", (req, res) => planController.rejectStep(req as ExtendedRequest, res));

  app.post("/chat", (req, res) => chatController.chat(req as ExtendedRequest, res));

  app.post("/secrets/:key/rotate", (req, res) => secretController.rotateSecret(req as ExtendedRequest, res));
  app.post("/secrets/:key/promote", (req, res) => secretController.promoteSecret(req as ExtendedRequest, res));
  app.get("/secrets/:key/versions", (req, res) => secretController.getSecretVersions(req as ExtendedRequest, res));

  app.get("/remote-fs/list", (req, res) => remoteFsController.list(req as ExtendedRequest, res));
  app.get("/remote-fs/read", (req, res) => remoteFsController.read(req as ExtendedRequest, res));
  app.post("/remote-fs/write", (req, res) => remoteFsController.write(req as ExtendedRequest, res));

  app.post("/cases", (req, res) => casesController.createCase(req as ExtendedRequest, res));
  app.get("/cases", (req, res) => casesController.listCases(req as ExtendedRequest, res));
  app.post("/cases/:id/tasks", (req, res) => casesController.createTask(req as ExtendedRequest, res));
  app.post("/cases/:id/artifacts", (req, res) => casesController.attachArtifact(req as ExtendedRequest, res));
  app.get("/workflows", (req, res) => casesController.listWorkflows(req as ExtendedRequest, res));

  app.get("/auth/oauth/:provider/authorize", (req, res) => authController.oauthAuthorize(req as ExtendedRequest, res));
  app.post("/auth/oauth/:provider/callback", (req, res) => authController.oauthCallback(req as ExtendedRequest, res));
  app.get("/auth/oidc/config", (req, res) => authController.getOidcConfig(req as ExtendedRequest, res));
  app.post("/auth/oidc/callback", (req, res) => authController.oidcCallback(req as ExtendedRequest, res));
  app.get("/auth/session", (req, res) => authController.getOidcSession(req as ExtendedRequest, res));
  app.delete("/auth/session", (req, res) => authController.oidcLogout(req as ExtendedRequest, res));

  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    appLogger.error({ err: normalizeError(err) }, "unhandled error");
    respondWithUnexpectedError(res, err);
  });

  return app;
}
