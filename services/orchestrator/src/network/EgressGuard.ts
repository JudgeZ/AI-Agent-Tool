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
    const hostWithPort = parsed.port ? `${hostname}:${parsed.port}` : undefined;
    candidates.add(hostname);
    const parsedHost = parsed.host.toLowerCase();
    candidates.add(parsedHost);
    if (hostWithPort) {
      candidates.add(hostWithPort);
    }
    return { hostname, candidates };
  }

  const hostCandidate = normalized.split("/")[0];
  if (hostCandidate) {
    candidates.add(hostCandidate);
    const colonIndex = hostCandidate.lastIndexOf(":");
    if (colonIndex > 0 && /^\d+$/.test(hostCandidate.slice(colonIndex + 1))) {
      const withoutPort = hostCandidate.slice(0, colonIndex);
      candidates.add(withoutPort);
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
    const hostWithPort = parsed.port ? `${hostname}:${parsed.port}` : undefined;
    candidates.add(hostname);
    candidates.add(parsedHost);
    if (hostWithPort) {
      candidates.add(hostWithPort);
    }
    return { hostname, candidates };
  }

  const hostCandidate = normalized.split("/")[0];
  if (hostCandidate) {
    candidates.add(hostCandidate);
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

