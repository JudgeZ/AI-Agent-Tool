import { loadConfig, type NetworkEgressConfig } from "../config.js";
import { appLogger } from "../observability/logger.js";

type EgressMetadata = {
  action?: string;
  metadata?: Record<string, unknown>;
};

type NormalizedTarget = {
  hostname?: string;
  candidates: Set<string>;
};

const DEFAULT_PORTS: Record<string, string> = {
  "http:": "80",
  "https:": "443",
  "ws:": "80",
  "wss:": "443",
};

function tryParseUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    try {
      return new URL(`https://${value}`);
    } catch {
      return undefined;
    }
  }
}

function detectExplicitPort(value: string): string | undefined {
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  const withoutScheme = trimmed.replace(/^[a-z0-9+.-]+:\/\//, "");
  const hostSegment = withoutScheme.split("/")[0];
  if (!hostSegment) {
    return undefined;
  }

  if (hostSegment.startsWith("[") && hostSegment.includes("]")) {
    const closingIndex = hostSegment.indexOf("]");
    const remainder = hostSegment.slice(closingIndex + 1);
    if (remainder.startsWith(":")) {
      const portCandidate = remainder.slice(1);
      if (/^\d+$/.test(portCandidate)) {
        return portCandidate;
      }
    }
  }

  const colonIndex = hostSegment.lastIndexOf(":");
  if (colonIndex > 0) {
    const portCandidate = hostSegment.slice(colonIndex + 1);
    if (/^\d+$/.test(portCandidate)) {
      return portCandidate;
    }
  }

  return undefined;
}

function buildTargetCandidates(target: string): NormalizedTarget {
  const trimmed = target.trim();
  const normalized = trimmed.toLowerCase();
  const candidates = new Set<string>();
  if (normalized) {
    candidates.add(normalized);
  }

  const parsed = tryParseUrl(trimmed);
  if (parsed) {
    const hostname = parsed.hostname.toLowerCase();
    const parsedHost = parsed.host.toLowerCase();
    const explicitPort = detectExplicitPort(trimmed);
    const port = parsed.port || explicitPort || DEFAULT_PORTS[parsed.protocol];
    candidates.add(hostname);
    candidates.add(parsedHost);
    if (port) {
      candidates.add(`${hostname}:${port}`);
    }
    return { hostname, candidates };
  }

  const hostCandidate = normalized.split("/")[0];
  if (hostCandidate) {
    candidates.add(hostCandidate);
    const explicitPort = detectExplicitPort(hostCandidate);
    if (explicitPort) {
      const portSeparatorIndex = hostCandidate.lastIndexOf(`:${explicitPort}`);
      const withoutPort = portSeparatorIndex >= 0 ? hostCandidate.slice(0, portSeparatorIndex) : hostCandidate;
      candidates.add(`${withoutPort}:${explicitPort}`);
      if (withoutPort) {
        candidates.add(withoutPort);
      }
      return { hostname: withoutPort, candidates };
    }
    return { hostname: hostCandidate, candidates };
  }

  return { candidates };
}

function tryParseAllowEntry(entry: string): { hostname?: string; candidates: Set<string>; suffix?: string } {
  const normalized = entry.trim().toLowerCase();
  const candidates = new Set<string>();
  if (normalized) {
    candidates.add(normalized);
  }

  if (normalized === "*") {
    return { hostname: "*", candidates };
  }

  if (normalized.startsWith("*")) {
    const suffix = normalized.slice(1);
    return { candidates, suffix };
  }

  const parsed = tryParseUrl(normalized);
  if (parsed) {
    const hostname = parsed.hostname.toLowerCase();
    const parsedHost = parsed.host.toLowerCase();
    const explicitPort = detectExplicitPort(normalized);
    const port = parsed.port || explicitPort;
    if (port) {
      const hostWithPort = `${hostname}:${port}`;
      candidates.add(hostWithPort);
      if (parsedHost.includes(":")) {
        candidates.add(parsedHost);
      }
    } else {
      candidates.add(hostname);
      if (parsedHost !== hostname) {
        candidates.add(parsedHost);
      }
    }
    return { hostname, candidates };
  }

  const hostCandidate = normalized.split("/")[0];
  if (hostCandidate) {
    candidates.add(hostCandidate);
    const explicitPort = detectExplicitPort(hostCandidate);
    if (explicitPort) {
      const portSeparatorIndex = hostCandidate.lastIndexOf(`:${explicitPort}`);
      const withoutPort = portSeparatorIndex >= 0 ? hostCandidate.slice(0, portSeparatorIndex) : hostCandidate;
      candidates.add(`${withoutPort}:${explicitPort}`);
      return { hostname: withoutPort, candidates };
    }
  }
  return { hostname: hostCandidate, candidates };
}

function isAllowedTarget(target: NormalizedTarget, config: NetworkEgressConfig): boolean {
  for (const entry of config.allow) {
    const parsedEntry = tryParseAllowEntry(entry);
    for (const candidate of parsedEntry.candidates) {
      if (target.candidates.has(candidate)) {
        return true;
      }
    }
    if (parsedEntry.hostname === "*") {
      return true;
    }
    if (parsedEntry.suffix && target.hostname?.endsWith(parsedEntry.suffix)) {
      return true;
    }
  }
  return false;
}

export function ensureEgressAllowed(target: string, context: EgressMetadata = {}): void {
  if (!target || target.trim().length === 0) {
    throw new Error("egress target must be specified");
  }

  const egressConfig = loadConfig().network.egress;
  if (egressConfig.mode === "allow") {
    appLogger.debug?.({ event: "egress.guard", target, mode: egressConfig.mode, ...context }, "egress policy disabled");
    return;
  }

  const normalizedTarget = buildTargetCandidates(target);
  const allowed = isAllowedTarget(normalizedTarget, egressConfig);
  if (allowed) {
    appLogger.debug?.({ event: "egress.guard", target, mode: egressConfig.mode, ...context }, "egress allowed");
    return;
  }

  const logContext = {
    event: "egress.guard",
    target,
    hostname: normalizedTarget.hostname,
    mode: egressConfig.mode,
    allow: egressConfig.allow,
    ...context,
  };

  if (egressConfig.mode === "report-only") {
    appLogger.warn?.(logContext, "egress would be blocked by policy");
    return;
  }

  appLogger.error?.(logContext, "egress blocked by policy");
  throw new Error(`Egress to '${target}' is not permitted by network policy`);
}

