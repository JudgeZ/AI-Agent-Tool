import type { Request, Response, NextFunction } from "express";
import type { CorsOptions } from "cors";
import type { AppConfig } from "../config.js";

type SecurityHeaderConfig = AppConfig["server"]["securityHeaders"][keyof AppConfig["server"]["securityHeaders"]];

function applySecurityHeader(
  res: Response,
  name: string,
  config: SecurityHeaderConfig,
) {
  if (!config.enabled) {
    res.removeHeader(name);
    return;
  }
  res.setHeader(name, config.value);
}

function isSecureRequest(req: Request): boolean {
  if (req.secure || req.protocol === "https") {
    return true;
  }

  const forwardedProto = req.headers["x-forwarded-proto"];
  if (forwardedProto === undefined) {
    return false;
  }

  const values = Array.isArray(forwardedProto)
    ? forwardedProto
    : forwardedProto.split(",");
  return values.some(
    (value) => value.trim().toLowerCase() === "https",
  );
}

export function createSecurityHeadersMiddleware(config: AppConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    const headers = config.server.securityHeaders;
    applySecurityHeader(
      res,
      "Content-Security-Policy",
      headers.contentSecurityPolicy,
    );
    const hsts = headers.strictTransportSecurity;
    if (
      hsts.enabled &&
      (!hsts.requireTls || config.server.tls.enabled || isSecureRequest(req))
    ) {
      res.setHeader(
        "Strict-Transport-Security",
        hsts.value,
      );
    } else {
      res.removeHeader("Strict-Transport-Security");
    }
    applySecurityHeader(res, "X-Frame-Options", headers.xFrameOptions);
    applySecurityHeader(
      res,
      "X-Content-Type-Options",
      headers.xContentTypeOptions,
    );
    applySecurityHeader(res, "Referrer-Policy", headers.referrerPolicy);
    applySecurityHeader(res, "Permissions-Policy", headers.permissionsPolicy);
    applySecurityHeader(
      res,
      "Cross-Origin-Opener-Policy",
      headers.crossOriginOpenerPolicy,
    );
    applySecurityHeader(
      res,
      "Cross-Origin-Resource-Policy",
      headers.crossOriginResourcePolicy,
    );
    applySecurityHeader(
      res,
      "Cross-Origin-Embedder-Policy",
      headers.crossOriginEmbedderPolicy,
    );
    applySecurityHeader(
      res,
      "X-DNS-Prefetch-Control",
      headers.xDnsPrefetchControl,
    );
    next();
  };
}

export function determineCorsOptions(config: AppConfig): CorsOptions {
  const allowedOrigins = new Set(
    (config.server.cors.allowedOrigins ?? [])
      .map((origin) => origin.trim())
      .filter(Boolean),
  );

  return {
    origin(origin, callback) {
      if (!origin) {
        callback(null, true);
        return;
      }
      callback(null, allowedOrigins.has(origin));
    },
    credentials: true,
  };
}
