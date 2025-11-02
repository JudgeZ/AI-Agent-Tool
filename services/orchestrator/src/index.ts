import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import express, { type Express, type NextFunction, type Request, type Response } from "express";
import cors from "cors";
import morgan from "morgan";
import rateLimit from "express-rate-limit";

import { createPlan } from "./plan/planner.js";
import {
  getLatestPlanStepEvent,
  getPlanHistory,
  publishPlanStepEvent,
  subscribeToPlanSteps,
  type PlanStepEvent
} from "./plan/events.js";
import { routeChat } from "./providers/ProviderRegistry.js";
import { ensureTracing, withSpan } from "./observability/tracing.js";
import {
  initializePlanQueueRuntime,
  resolvePlanStepApproval,
  submitPlanSteps
} from "./queue/PlanQueueRuntime.js";
import { authorize as oauthAuthorize, callback as oauthCallback } from "./auth/OAuthController.js";
import { loadConfig, type AppConfig } from "./config.js";
import { getPolicyEnforcer, PolicyViolationError, type PolicyDecision } from "./policy/PolicyEnforcer.js";

initializePlanQueueRuntime().catch(error => {
  // eslint-disable-next-line no-console
  console.error("Failed to initialize queue runtime", error);
});

function formatSse(event: PlanStepEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event)}\n\n`;
}

function extractAgent(req: Request): string | undefined {
  const headerAgent = req.header("x-agent");
  if (typeof headerAgent === "string" && headerAgent.trim().length > 0) {
    return headerAgent.trim();
  }
  const bodyAgent = req.body && typeof req.body.agent === "string" ? req.body.agent.trim() : undefined;
  return bodyAgent && bodyAgent.length > 0 ? bodyAgent : undefined;
}

function ensureAllowed(action: string, decision: PolicyDecision): void {
  if (!decision.allow) {
    throw new PolicyViolationError(`${action} denied by capability policy`, decision.deny);
  }
}

export function createServer(appConfig?: AppConfig): Express {
  const config = appConfig ?? loadConfig();
  void ensureTracing(config.observability.tracing).catch(error => {
    // eslint-disable-next-line no-console
    console.error("Failed to configure tracing", error);
  });
  const app = express();
  const policy = getPolicyEnforcer();

  app.use(cors());
  app.use(express.json({ limit: "1mb" }));
  app.use(morgan("dev"));

  const planLimiter = rateLimit({
    windowMs: config.server.rateLimits.plan.windowMs,
    limit: config.server.rateLimits.plan.maxRequests,
    standardHeaders: true,
    legacyHeaders: false
  });
  const chatLimiter = rateLimit({
    windowMs: config.server.rateLimits.chat.windowMs,
    limit: config.server.rateLimits.chat.maxRequests,
    standardHeaders: true,
    legacyHeaders: false
  });

  app.get("/healthz", (_req: Request, res: Response) => {
    res.status(200).json({ status: "ok" });
  });

  app.get("/auth/:provider/authorize", oauthAuthorize);
  app.post("/auth/:provider/callback", oauthCallback);

  app.post("/plan", planLimiter, async (req: Request, res: Response, next: NextFunction) => {
    const goal = typeof req.body?.goal === "string" ? req.body.goal.trim() : "";
    if (!goal) {
      res.status(400).json({ error: "goal is required" });
      return;
    }

    try {
      const result = await withSpan(
        "http.post.plan",
        async span => {
          await ensureAllowed(
            "plan.create",
            await policy.enforceHttpAction({
              action: "http.post.plan",
              requiredCapabilities: ["plan.create"],
              agent: extractAgent(req),
              traceId: span.context.traceId
            })
          );
          const plan = createPlan(goal);
          span.setAttribute("plan.id", plan.id);
          span.setAttribute("plan.steps", plan.steps.length);
          await submitPlanSteps(plan, span.context.traceId);
          return { plan, traceId: span.context.traceId };
        },
        { route: "/plan" }
      );
      res.status(201).json(result);
    } catch (error) {
      next(error);
    }
  });

  app.get("/plan/:id/events", (req: Request, res: Response) => {
    const { id } = req.params;
    if (req.headers.accept?.includes("text/event-stream")) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders?.();

      let replayingHistory = true;
      const buffered: PlanStepEvent[] = [];

      const writeEvent = (event: PlanStepEvent) => {
        res.write(formatSse(event));
      };

      const unsubscribe = subscribeToPlanSteps(id, event => {
        if (replayingHistory) {
          buffered.push(event);
          return;
        }
        writeEvent(event);
      });

      const history = getPlanHistory(id);
      history.forEach(writeEvent);

      replayingHistory = false;
      buffered.splice(0).forEach(writeEvent);

      const keepAliveInterval = config.server.sseKeepAliveMs;
      const keepAlive = setInterval(() => {
        res.write(": keep-alive\n\n");
      }, keepAliveInterval);

      req.on("close", () => {
        clearInterval(keepAlive);
        unsubscribe();
        res.end();
      });
    } else {
      const events = getPlanHistory(id);
      res.json({ events });
    }
  });

  app.post("/plan/:planId/steps/:stepId/approve", planLimiter, async (req: Request, res: Response, next: NextFunction) => {
    const { planId, stepId } = req.params;
    const latest = getLatestPlanStepEvent(planId, stepId);
    if (!latest) {
      res.status(404).json({ error: "Step not found" });
      return;
    }

    if (latest.step.state !== "waiting_approval") {
      res.status(409).json({ error: "Step is not awaiting approval" });
      return;
    }

    const decision: "approved" | "rejected" = req.body?.decision === "reject" ? "rejected" : "approved";
    const rationale = typeof req.body?.rationale === "string" ? req.body.rationale.trim() : "";
    const summary = rationale ? `${latest.step.summary ?? ""}${latest.step.summary ? " " : ""}(${decision}: ${rationale})` : latest.step.summary;

    try {
      await ensureAllowed(
        "plan.approve",
        await policy.enforceHttpAction({
          action: "http.post.plan.approve",
          requiredCapabilities: ["plan.approve"],
          agent: extractAgent(req),
          traceId: latest.traceId
        })
      );
      await resolvePlanStepApproval({ planId, stepId, decision, summary });
      res.status(204).end();
    } catch (error) {
      next(error);
    }
  });

  app.post("/chat", chatLimiter, async (req: Request, res: Response, next: NextFunction) => {
    const { messages, model } = req.body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: "messages array is required" });
      return;
    }

    try {
      const result = await withSpan(
        "http.post.chat",
        async span => {
          await ensureAllowed(
            "chat.invoke",
            await policy.enforceHttpAction({
              action: "http.post.chat",
              requiredCapabilities: ["chat.invoke"],
              agent: extractAgent(req),
              traceId: span.context.traceId
            })
          );
          span.setAttribute("chat.message_count", messages.length);
          if (typeof model === "string") {
            span.setAttribute("chat.model", model);
          }
          const response = await routeChat({ messages, model });
          return { response, traceId: span.context.traceId };
        },
        { route: "/chat" }
      );
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const status = error instanceof Error && "status" in error ? Number((error as { status: number }).status) : 500;
    const message = error instanceof Error ? error.message : "Internal Server Error";
    res.status(Number.isFinite(status) ? status : 500).json({ error: message });
  });

  return app;
}

export function createHttpServer(app: Express, config: AppConfig): http.Server | https.Server {
  if (config.server.tls.enabled) {
    const { keyPath, certPath, caPaths, requestClientCert } = config.server.tls;
    if (!keyPath || !certPath) {
      throw new Error("TLS is enabled but keyPath or certPath is undefined");
    }
    const options: https.ServerOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      requestCert: requestClientCert,
      rejectUnauthorized: requestClientCert
    };
    if (caPaths.length > 0) {
      options.ca = caPaths.map(caPath => fs.readFileSync(caPath));
    }
    return https.createServer(options, app);
  }
  return http.createServer(app);
}

if (process.env.NODE_ENV !== "test") {
  const port = Number(process.env.PORT) || 4000;
  const config = loadConfig();
  const app = createServer(config);
  const server = createHttpServer(app, config);
  server.listen(port, () => {
    const protocol = config.server.tls.enabled ? "https" : "http";
    // eslint-disable-next-line no-console
    console.info(`orchestrator listening on ${protocol}://localhost:${port}`);
  });
}
