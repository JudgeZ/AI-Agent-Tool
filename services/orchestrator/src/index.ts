import fs from "node:fs";
import http from "node:http";
import https from "node:https";

import type { Express } from "express";

import { loadConfig, type AppConfig } from "./config.js";
import { initializePlanQueueRuntime } from "./queue/PlanQueueRuntime.js";
import { appLogger, normalizeError } from "./observability/logger.js";
import { createServer as createAppServer } from "./server/app.js";
import { SLOMonitor } from "./monitoring/SLOMonitor.js";
import { setupCollaborationServer } from "./collaboration/index.js";
import { setupTerminalServer } from "./sandbox/terminalServer.js";
import { isUpgradeHandled } from "./server/upgradeMarkers.js";

// Global singleton for monitoring
export const sloMonitor = new SLOMonitor();

export { createServer } from "./server/app.js";
export {
  createRequestIdentity,
  buildRateLimitKey,
  type RequestIdentity,
} from "./http/requestIdentity.js";

export function createHttpServer(
  app: Express,
  config: AppConfig,
): http.Server | https.Server {
  if (config.server.tls.enabled) {
    const { keyPath, certPath, caPaths, requestClientCert } = config.server.tls;
    if (!keyPath || !certPath) {
      throw new Error("TLS is enabled but keyPath or certPath is undefined");
    }
    const options: https.ServerOptions = {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(certPath),
      requestCert: requestClientCert,
      rejectUnauthorized: requestClientCert,
    };
    if (caPaths.length > 0) {
      options.ca = caPaths.map((caPath) => fs.readFileSync(caPath));
    }
    return https.createServer(options, app);
  }
  return http.createServer(app);
}

if (process.env.NODE_ENV !== "test") {
  bootstrapOrchestrator().catch((error) => {
    appLogger.error(
      { err: normalizeError(error) },
      "orchestrator startup failed",
    );
    process.exit(1);
  });
}

/**
 * Bootstraps and starts the orchestrator HTTP(S) server using the provided or loaded configuration.
 *
 * @param appConfig - Optional application configuration to use instead of loading the default config
 * @returns The started `http.Server` or `https.Server` instance
 * @throws Rethrows any error that occurs while initializing the plan queue runtime
 */
export async function bootstrapOrchestrator(
  appConfig?: AppConfig,
): Promise<http.Server | https.Server> {
  const port = Number(process.env.PORT) || 4000;
  const config = appConfig ?? loadConfig();
  try {
    await initializePlanQueueRuntime();
  } catch (error) {
    appLogger.error(
      { err: normalizeError(error) },
      "Failed to initialize queue runtime",
    );
    throw error;
  }
  const app = createAppServer(config);
  const server = createHttpServer(app, config);
  await setupCollaborationServer(server, config);
  setupTerminalServer(server, config);
  server.on("upgrade", (request, socket) => {
    if (!isUpgradeHandled(request)) {
      socket.destroy();
    }
  });
  server.listen(port, () => {
    const protocol = config.server.tls.enabled ? "https" : "http";
    appLogger.info(
      { protocol, port },
      "orchestrator listening on endpoint",
    );
  });
  return server;
}