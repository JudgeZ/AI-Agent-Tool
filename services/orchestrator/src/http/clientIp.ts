import type { Request } from "express";
import ipaddr from "ipaddr.js";

type IpAddress = ipaddr.IPv4 | ipaddr.IPv6;

function parseIpAddress(raw: string | undefined): IpAddress | undefined {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed.includes("%") ? trimmed.split("%", 1)[0] : trimmed;
  try {
    const parsed = ipaddr.parse(sanitized);
    if (parsed.kind() === "ipv6" && (parsed as ipaddr.IPv6).isIPv4MappedAddress()) {
      return (parsed as ipaddr.IPv6).toIPv4Address();
    }
    return parsed;
  } catch {
    return undefined;
  }
}

function formatIpAddress(address: IpAddress): string {
  return address.toString();
}

type TrustedCidr = {
  network: IpAddress;
  prefixLength: number;
};

function parseTrustedEntry(entry: string): TrustedCidr | undefined {
  const trimmed = entry.trim();
  if (!trimmed) {
    return undefined;
  }
  const sanitized = trimmed.includes("%") ? trimmed.split("%", 1)[0] : trimmed;
  try {
    if (!sanitized.includes("/")) {
      const address = parseIpAddress(sanitized);
      if (!address) {
        return undefined;
      }
      return {
        network: address,
        prefixLength: address.kind() === "ipv6" ? 128 : 32,
      };
    }
    const [network, prefixLength] = ipaddr.parseCIDR(sanitized);
    const normalized =
      network.kind() === "ipv6" && (network as ipaddr.IPv6).isIPv4MappedAddress()
        ? (network as ipaddr.IPv6).toIPv4Address()
        : network;
    const maxPrefix = normalized.kind() === "ipv6" ? 128 : 32;
    const boundedPrefix = Math.max(0, Math.min(prefixLength, maxPrefix));
    return {
      network: normalized as IpAddress,
      prefixLength: boundedPrefix,
    };
  } catch {
    return undefined;
  }
}

function isTrustedProxy(remote: IpAddress, trustedCidrs: readonly string[]): boolean {
  if (trustedCidrs.length === 0) {
    return false;
  }
  for (const entry of trustedCidrs) {
    const parsed = parseTrustedEntry(entry);
    if (!parsed) {
      continue;
    }
    if (remote.kind() !== parsed.network.kind()) {
      continue;
    }
    if (remote.match([parsed.network, parsed.prefixLength])) {
      return true;
    }
  }
  return false;
}

function resolveRemoteAddress(req: Request): { address: IpAddress; formatted: string } | undefined {
  const candidates = [req.socket?.remoteAddress, req.ip];
  for (const candidate of candidates) {
    const parsed = parseIpAddress(candidate);
    if (parsed) {
      return {
        address: parsed,
        formatted: formatIpAddress(parsed),
      };
    }
  }
  return undefined;
}

function readForwardedHeader(req: Request): string | undefined {
  if (typeof req.header === "function") {
    const value = req.header("x-forwarded-for");
    if (typeof value === "string") {
      return value;
    }
  }
  const headers = req.headers as Record<string, unknown> | undefined;
  if (!headers) {
    return undefined;
  }
  const direct = headers["x-forwarded-for"] ?? headers["X-Forwarded-For"];
  return typeof direct === "string" ? direct : undefined;
}

export function resolveClientIp(req: Request, trustedProxyCidrs: readonly string[]): string {
  const remote = resolveRemoteAddress(req);
  if (!remote) {
    return "unknown";
  }

  if (!isTrustedProxy(remote.address, trustedProxyCidrs)) {
    return remote.formatted;
  }

  const forwarded = readForwardedHeader(req);
  if (!forwarded) {
    return remote.formatted;
  }

  const entries = forwarded
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const parsed = parseIpAddress(entries[i]);
    if (!parsed) {
      continue;
    }
    if (isTrustedProxy(parsed, trustedProxyCidrs)) {
      continue;
    }
    return formatIpAddress(parsed);
  }

  return remote.formatted;
}

