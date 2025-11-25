import { logger } from "./logger";

export interface GatewayConfig {
  baseUrl: string;
  apiKey?: string;
  timeoutMs: number;
}

const DEFAULT_GATEWAY_URL = "http://localhost:8080";
const DEFAULT_TIMEOUT_MS = 30_000;

function parseGatewayUrl(rawBaseUrl: string): string {
  let baseUrl: string;
  const errorMessage =
    "Invalid gateway URL. Set GATEWAY_URL or AIDT_GATEWAY_URL to a valid HTTP(S) URL.";
  try {
    const parsed = new URL(rawBaseUrl);
    if (!parsed.hostname) {
      throw new Error(errorMessage);
    }
    if (parsed.username || parsed.password) {
      throw new Error("Invalid gateway URL. Credentials in URLs are not supported.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Invalid gateway URL. Gateway URL must use http or https.");
    }
    baseUrl = parsed.toString().replace(/\/$/, "");
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Invalid gateway URL")) {
      throw error;
    }
    throw new Error(errorMessage);
  }
  return baseUrl;
}

function resolveTimeout(rawTimeout?: string): number {
  if (!rawTimeout) return DEFAULT_TIMEOUT_MS;
  const parsed = Number.parseInt(rawTimeout, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid gateway timeout: ${rawTimeout}. Provide a positive integer number of milliseconds.`,
    );
  }
  return parsed;
}

export function resolveGatewayConfig(options?: { requireApiKey?: boolean }): GatewayConfig {
  const baseUrl = parseGatewayUrl(
    process.env.AIDT_GATEWAY_URL ?? process.env.GATEWAY_URL ?? DEFAULT_GATEWAY_URL,
  );
  const apiKey =
    process.env.API_KEY ??
    process.env.AIDT_API_KEY ??
    process.env.AIDT_AUTH_TOKEN ??
    process.env.AUTH_TOKEN;
  const timeoutMs = resolveTimeout(
    process.env.AIDT_GATEWAY_TIMEOUT_MS ?? process.env.GATEWAY_TIMEOUT_MS,
  );
  if (options?.requireApiKey !== false && !apiKey) {
    throw new Error(
      "API key is required. Set API_KEY or AIDT_API_KEY with a valid gateway token.",
    );
  }
  return { baseUrl, apiKey, timeoutMs };
}

function assertRelativePath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) {
    throw new Error("Gateway request path is required.");
  }

  if (/^[a-zA-Z][a-zA-Z\d+\-.]*:/.test(trimmed) || trimmed.startsWith("//")) {
    throw new Error("Gateway request path must be relative.");
  }

  return trimmed;
}

export function joinUrl(baseUrl: string, pathname: string): string {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const relativePath = assertRelativePath(pathname);
  const normalizedPath = relativePath.startsWith("/") ? relativePath.slice(1) : relativePath;
  return new URL(normalizedPath, normalizedBase).toString();
}

export async function readErrorMessage(response: Response): Promise<string | undefined> {
  const contentType = response.headers.get("content-type") ?? "";
  const bodyText = await response.text();
  if (!bodyText) {
    return undefined;
  }

  if (contentType.includes("application/json")) {
    try {
      const parsed = JSON.parse(bodyText);
      if (typeof parsed === "string") return parsed;
      if (parsed && typeof parsed === "object") {
        const candidateMessages: string[] = [];

        const topLevel = parsed as Record<string, unknown>;
        if (typeof topLevel.message === "string" && topLevel.message.trim()) {
          candidateMessages.push(topLevel.message.trim());
        }

        const topLevelError = topLevel.error;
        if (typeof topLevelError === "string" && topLevelError.trim()) {
          candidateMessages.push(topLevelError.trim());
        } else if (topLevelError && typeof topLevelError === "object") {
          const nested = topLevelError as Record<string, unknown>;
          if (typeof nested.message === "string" && nested.message.trim()) {
            candidateMessages.push(nested.message.trim());
          }
        }

        if (candidateMessages.length > 0) {
          return candidateMessages[0];
        }

        if (Array.isArray(topLevel.errors) && topLevel.errors.length > 0) {
          return topLevel.errors.map((err) => String(err)).join(", ");
        }
      }
    } catch {
      // fall through to return plain text
    }
  }

  return bodyText.trim() || undefined;
}

export class GatewayHttpError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly requestId?: string,
  ) {
    super(message);
    this.name = "GatewayHttpError";
  }
}

function buildHeaders(config: GatewayConfig): Record<string, string> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (config.apiKey) {
    headers.authorization = `Bearer ${config.apiKey}`;
  }
  return headers;
}

async function handleError(response: Response): Promise<never> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const message = await readErrorMessage(response);
  const withRequestId = (text: string): string =>
    requestId ? `${text} (request id ${requestId})` : text;

  if (response.status >= 300 && response.status < 400) {
    throw new GatewayHttpError(
      withRequestId(
        "Gateway responded with a redirect, which is blocked to protect credentials.",
      ),
      response.status,
      requestId,
    );
  }

  switch (response.status) {
    case 400:
    case 422:
      throw new GatewayHttpError(
        withRequestId(message ?? "Gateway rejected input with validation error."),
        response.status,
        requestId,
      );
    case 401:
    case 403:
      throw new GatewayHttpError(
        withRequestId(
          message
            ? `Authentication failed: ${message}`
            : "Authentication failed. Provide a valid API key via API_KEY.",
        ),
        response.status,
        requestId,
      );
    case 404:
      throw new GatewayHttpError(
        withRequestId(message ?? "Gateway endpoint not found. Verify your gateway URL."),
        response.status,
        requestId,
      );
    case 429:
      throw new GatewayHttpError(
        withRequestId(
          message
            ? `Gateway rate limited the request: ${message}`
            : "Gateway rate limited the request. Please retry shortly.",
        ),
        response.status,
        requestId,
      );
    default: {
      const statusText = response.statusText || `HTTP ${response.status}`;
      const detail = message ? `: ${message}` : ".";
      throw new GatewayHttpError(
        withRequestId(`Gateway request failed - ${statusText}${detail}`),
        response.status,
        requestId,
      );
    }
  }
}

interface RequestOptions {
  pathname: string;
  config: GatewayConfig;
  init: RequestInit;
}

async function requestJson<T>({ pathname, config, init }: RequestOptions): Promise<T> {
  const url = joinUrl(config.baseUrl, pathname);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(url, {
      ...init,
      redirect: "manual",
      headers: { ...buildHeaders(config), ...(init.headers ?? {}) },
      signal: controller.signal,
    });
    if (!response.ok) {
      return handleError(response);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Gateway request timed out after ${config.timeoutMs}ms. Adjust AIDT_GATEWAY_TIMEOUT_MS if needed.`,
      );
    }
    if (error instanceof GatewayHttpError) {
      throw error;
    }
    if (error instanceof Error) {
      throw new Error(`Gateway request failed: ${error.message}`);
    }
    logger.error({ err: error }, "Gateway request failed with unknown error");
    throw new Error("Gateway request failed due to an unknown error");
  } finally {
    clearTimeout(timeout);
  }
}

export async function postJson<T>(
  pathname: string,
  body: unknown,
  config: GatewayConfig,
): Promise<T> {
  return requestJson<T>({
    pathname,
    config,
    init: { method: "POST", body: JSON.stringify(body) },
  });
}

export async function getJson<T>(pathname: string, config: GatewayConfig): Promise<T> {
  return requestJson<T>({
    pathname,
    config,
    init: { method: "GET" },
  });
}
