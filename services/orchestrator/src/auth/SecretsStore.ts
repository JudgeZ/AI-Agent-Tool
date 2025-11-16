import { existsSync, readFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { Agent, type Dispatcher } from "undici";

import { LocalKeystore } from "./LocalKeystore.js";
import { resolveEnv } from "../utils/env.js";
import { ensureEgressAllowed } from "../network/EgressGuard.js";

export interface SecretsStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

type LocalStoreOptions = {
  filePath?: string;
  passphrase?: string;
};

type VaultStoreOptions = {
  url?: string;
  token?: string;
  namespace?: string;
  tenantNamespaceTemplate?: string;
  kvMountPath?: string;
  caCert?: string;
  rejectUnauthorized?: boolean;
  authMethod?: string;
  role?: string;
  authMountPath?: string;
  kubernetesToken?: string;
  kubernetesTokenPath?: string;
  dispatcher?: Dispatcher;
};

export class LocalFileStore implements SecretsStore {
  private cache: Map<string, string> = new Map();
  private ready: Promise<void>;
  private readonly filePath: string;
  private readonly passphrase: string;
  private persistChain: Promise<void> = Promise.resolve();
  private readonly keystore: LocalKeystore;

  constructor(options?: LocalStoreOptions) {
    const defaultPath = path.join(
      process.cwd(),
      "config",
      "secrets",
      "local",
      "secrets.json",
    );
    const resolvedPath =
      resolveEnv("LOCAL_SECRETS_PATH", defaultPath) ?? defaultPath;
    this.filePath = options?.filePath ?? resolvedPath;
    this.passphrase =
      options?.passphrase ?? resolveEnv("LOCAL_SECRETS_PASSPHRASE") ?? "";
    this.keystore = new LocalKeystore(this.filePath, this.passphrase);
    this.ready = this.initialize();
  }

  async get(key: string): Promise<string | undefined> {
    await this.ready;
    return this.cache.get(key);
  }

  async set(key: string, value: string): Promise<void> {
    await this.ready;
    this.cache.set(key, value);
    await this.enqueuePersist();
  }

  async delete(key: string): Promise<void> {
    await this.ready;
    this.cache.delete(key);
    await this.enqueuePersist();
  }

  private async initialize() {
    if (!this.passphrase) {
      throw new Error(
        "LocalFileStore requires LOCAL_SECRETS_PASSPHRASE to be set",
      );
    }
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const existing = await this.keystore.read();
    this.cache = new Map(Object.entries(existing));
  }

  private enqueuePersist(): Promise<void> {
    const run = this.persistChain.then(() => this.persist());
    this.persistChain = run.catch(() => {});
    return run;
  }

  private async persist() {
    const entries = Object.fromEntries(this.cache.entries());
    await this.keystore.write(entries);
  }
}

const DEFAULT_KUBERNETES_TOKEN_PATH =
  "/var/run/secrets/kubernetes.io/serviceaccount/token";
const MIN_TOKEN_RENEW_BUFFER_SECONDS = 30;

type KubernetesAuthConfig = {
  method: "kubernetes";
  mountPath: string;
  role: string;
  tokenPath?: string;
  token?: string;
};

type VaultAuthConfig = KubernetesAuthConfig;

function parseBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }
  if (
    trimmed === "true" ||
    trimmed === "1" ||
    trimmed === "yes" ||
    trimmed === "on"
  ) {
    return true;
  }
  if (
    trimmed === "false" ||
    trimmed === "0" ||
    trimmed === "no" ||
    trimmed === "off"
  ) {
    return false;
  }
  return undefined;
}

function trimSlashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === "/") {
    start += 1;
  }
  while (end > start && value[end - 1] === "/") {
    end -= 1;
  }
  return value.slice(start, end);
}

function resolveCaCertificate(source: string | undefined): string | undefined {
  if (!source) {
    return undefined;
  }
  const candidate = source.trim();
  if (!candidate) {
    return undefined;
  }
  if (candidate.includes("-----BEGIN")) {
    return candidate;
  }
  if (existsSync(candidate)) {
    return readFileSync(candidate, "utf-8");
  }
  return candidate;
}

function toSecretPath(key: string): string {
  const segments: string[] = [];
  let current = "";
  for (const char of key) {
    if (char === ":" || char === "/") {
      if (current.length > 0) {
        segments.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  const encoded = segments
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .map((segment) => encodeURIComponent(segment));
  if (encoded.length === 0) {
    throw new Error("Secret keys must contain at least one valid segment");
  }
  return encoded.join("/");
}

function readFileContent(filePath: string): string {
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    if (!content) {
      throw new Error(`File at ${filePath} is empty`);
    }
    return content;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to read file at ${filePath}: ${message}`);
  }
}

function computeRenewalDeadline(
  leaseDurationSeconds: number | undefined,
): number | undefined {
  if (
    !leaseDurationSeconds ||
    !Number.isFinite(leaseDurationSeconds) ||
    leaseDurationSeconds <= 0
  ) {
    return undefined;
  }
  const bufferSeconds = Math.min(
    MIN_TOKEN_RENEW_BUFFER_SECONDS,
    Math.max(5, Math.floor(leaseDurationSeconds * 0.1)),
  );
  const effectiveSeconds = Math.max(5, leaseDurationSeconds - bufferSeconds);
  return Date.now() + effectiveSeconds * 1000;
}

type SecretDescriptor = {
  path: string;
  tenantId?: string;
};

function splitKeySegments(key: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (const char of key) {
    if (char === ":" || char === "/") {
      if (current.length > 0) {
        segments.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) {
    segments.push(current);
  }
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function toSecretDescriptor(key: string): SecretDescriptor {
  const segments = splitKeySegments(key);
  if (segments.length === 0) {
    throw new Error("Secret keys must contain at least one valid segment");
  }
  let tenantId: string | undefined;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (segments[i].toLowerCase() === "tenant") {
      tenantId = segments[i + 1];
      break;
    }
  }
  const encoded = segments.map((segment) => encodeURIComponent(segment));
  return { path: encoded.join("/"), tenantId };
}

const TENANT_NAMESPACE_SEGMENT_PATTERN = /^[A-Za-z0-9._-]+$/;

function sanitizeNamespaceSegment(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return undefined;
  }
  if (
    !TENANT_NAMESPACE_SEGMENT_PATTERN.test(trimmed) ||
    trimmed === "." ||
    trimmed === ".." ||
    trimmed.includes("..")
  ) {
    return undefined;
  }
  return trimmed;
}

function combineNamespaces(base?: string, tenant?: string): string | undefined {
  const normalizedBase = base ? trimSlashes(base) : undefined;
  const normalizedTenant = tenant ? trimSlashes(tenant) : undefined;
  if (normalizedBase && normalizedTenant) {
    return `${normalizedBase}/${normalizedTenant}`;
  }
  return normalizedTenant ?? normalizedBase;
}

const MAX_VAULT_ERROR_SNIPPET = 256;
const MAX_VAULT_ERROR_CAPTURE_BYTES = 4096;

function extractVaultErrorDetail(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const candidate = payload as Record<string, unknown>;
  const errors = candidate.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const firstError = errors.find((item) => typeof item === "string");
    if (typeof firstError === "string" && firstError.trim()) {
      return firstError.trim();
    }
  }
  const error = candidate.error;
  if (typeof error === "string" && error.trim()) {
    return error.trim();
  }
  if (
    typeof candidate.data === "object" &&
    candidate.data !== null &&
    typeof (candidate.data as Record<string, unknown>).error === "string"
  ) {
    const nested = (candidate.data as Record<string, unknown>).error;
    if (typeof nested === "string" && nested.trim()) {
      return nested.trim();
    }
  }
  return undefined;
}

async function readVaultErrorMessage(
  response: Response,
): Promise<string | undefined> {
  if (response.bodyUsed) {
    return undefined;
  }
  try {
    const snippet = await readVaultErrorSnippet(response);
    if (!snippet) {
      return undefined;
    }
    const trimmed = snippet.trim();
    if (!trimmed) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      const detail = extractVaultErrorDetail(parsed);
      if (detail) {
        return detail;
      }
    } catch {
      // fall back to the raw body snippet below
    }
    return trimmed.length > MAX_VAULT_ERROR_SNIPPET
      ? `${trimmed.slice(0, MAX_VAULT_ERROR_SNIPPET)}…`
      : trimmed;
  } catch {
    return undefined;
  }
}

async function readVaultErrorSnippet(
  response: Response,
): Promise<string | undefined> {
  try {
    const clone = response.clone();
    if (!clone.body) {
      return await clone.text();
    }
    const reader = clone.body.getReader();
    const decoder = new TextDecoder();
    let result = "";
    let total = 0;
    while (total < MAX_VAULT_ERROR_CAPTURE_BYTES) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        result += decoder.decode(value, { stream: true });
        if (total >= MAX_VAULT_ERROR_CAPTURE_BYTES) {
          break;
        }
      }
    }
    result += decoder.decode();
    await reader.cancel().catch(() => {});
    return result;
  } catch {
    return undefined;
  }
}

export class VaultStore implements SecretsStore {
  private readonly baseUrl: URL;
  private token?: string;
  private readonly namespace?: string;
  private readonly tenantNamespaceTemplate?: string;
  private readonly mountPath: string;
  private readonly dispatcher?: Dispatcher;
  private readonly authConfig?: VaultAuthConfig;
  private readonly managedToken: boolean;
  private tokenExpiresAt?: number;
  private loginPromise: Promise<void> | null = null;

  constructor(options: VaultStoreOptions = {}) {
    const url = (options.url ?? resolveEnv("VAULT_ADDR") ?? "").trim();
    if (!url) {
      throw new Error("VaultStore requires VAULT_ADDR to be set");
    }
    this.baseUrl = new URL(url);

    const rawToken = options.token ?? resolveEnv("VAULT_TOKEN");
    const trimmedToken = rawToken?.trim();
    const namespace = (
      options.namespace ?? resolveEnv("VAULT_NAMESPACE")
    )?.trim();
    this.namespace = namespace && namespace.length > 0 ? namespace : undefined;

    const tenantNamespaceTemplate =
      options.tenantNamespaceTemplate ??
      resolveEnv("VAULT_TENANT_NAMESPACE_TEMPLATE");
    this.tenantNamespaceTemplate = tenantNamespaceTemplate
      ?.trim()
      ?.length
      ? tenantNamespaceTemplate.trim()
      : undefined;

    const mountCandidate =
      options.kvMountPath ?? resolveEnv("VAULT_KV_MOUNT", "secret") ?? "secret";
    const normalizedMount = trimSlashes(mountCandidate);
    this.mountPath = normalizedMount.length > 0 ? normalizedMount : "secret";

    const caCert = resolveCaCertificate(
      options.caCert ?? resolveEnv("VAULT_CA_CERT"),
    );
    const rejectUnauthorized =
      options.rejectUnauthorized ??
      parseBoolean(resolveEnv("VAULT_TLS_REJECT_UNAUTHORIZED"));

    if (options.dispatcher) {
      this.dispatcher = options.dispatcher;
    } else if (caCert || rejectUnauthorized !== undefined) {
      const agentOptions: ConstructorParameters<typeof Agent>[0] = {};
      agentOptions.connect = {};
      if (caCert) {
        agentOptions.connect.ca = caCert;
      }
      if (rejectUnauthorized !== undefined) {
        agentOptions.connect.rejectUnauthorized = rejectUnauthorized;
      }
      this.dispatcher = new Agent(agentOptions);
    }

    const authMethod = (options.authMethod ?? resolveEnv("VAULT_AUTH_METHOD"))
      ?.trim()
      ?.toLowerCase();
    let authConfig: VaultAuthConfig | undefined;

    if (!trimmedToken) {
      if (authMethod === "kubernetes") {
        const role = (options.role ?? resolveEnv("VAULT_ROLE"))?.trim();
        if (!role) {
          throw new Error(
            "VaultStore requires VAULT_ROLE when using kubernetes auth",
          );
        }
        const mount = trimSlashes(
          options.authMountPath ??
            resolveEnv("VAULT_AUTH_MOUNT", "kubernetes") ??
            "kubernetes",
        );
        const mountPath = mount.length > 0 ? mount : "kubernetes";
        const inlineToken = (
          options.kubernetesToken ?? resolveEnv("VAULT_K8S_TOKEN")
        )?.trim();
        const tokenPath =
          options.kubernetesTokenPath ??
          resolveEnv("VAULT_K8S_TOKEN_PATH", DEFAULT_KUBERNETES_TOKEN_PATH) ??
          DEFAULT_KUBERNETES_TOKEN_PATH;
        authConfig = {
          method: "kubernetes",
          mountPath,
          role,
          token:
            inlineToken && inlineToken.length > 0 ? inlineToken : undefined,
          tokenPath: tokenPath?.trim() || undefined,
        };
      } else if (authMethod) {
        throw new Error(
          `VaultStore auth method '${authMethod}' is not supported`,
        );
      }
    }

    this.authConfig = authConfig;
    this.managedToken = authConfig !== undefined;

    if (!this.managedToken) {
      if (!trimmedToken) {
        throw new Error(
          "VaultStore requires VAULT_TOKEN or supported auth configuration",
        );
      }
      this.token = trimmedToken;
    }
  }

  private buildUrl(path: string): string {
    return new URL(path, this.baseUrl).toString();
  }

  private createBaseHeaders(
    init?: HeadersInit,
    namespaceOverride?: string,
  ): Headers {
    const headers = new Headers(init);
    const namespaceHeader = namespaceOverride ?? this.namespace;
    if (namespaceHeader) {
      headers.set("X-Vault-Namespace", namespaceHeader);
    }
    return headers;
  }

  private resolveNamespaceForTenant(tenantId?: string): string | undefined {
    if (!tenantId || !this.tenantNamespaceTemplate) {
      return this.namespace;
    }
    const safeTenant = sanitizeNamespaceSegment(tenantId);
    if (!safeTenant) {
      return this.namespace;
    }
    const tenantNamespace = this.tenantNamespaceTemplate.replace(
      /\{tenant\}/g,
      safeTenant,
    );
    return combineNamespaces(this.namespace, tenantNamespace);
  }

  private async send(path: string, init: RequestInit = {}): Promise<Response> {
    const requestInit: RequestInit & { dispatcher?: Dispatcher } = {
      ...init,
      dispatcher: this.dispatcher,
    };
    const targetUrl = this.buildUrl(path);
    ensureEgressAllowed(targetUrl, { action: "vault.request" });
    return fetch(targetUrl, requestInit);
  }

  private invalidateToken(): void {
    this.token = undefined;
    this.tokenExpiresAt = undefined;
  }

  private updateToken(token: string, leaseDuration?: number): void {
    this.token = token.trim();
    this.tokenExpiresAt = computeRenewalDeadline(leaseDuration);
  }

  private shouldRefreshToken(): boolean {
    if (!this.token) {
      return true;
    }
    if (this.tokenExpiresAt === undefined) {
      return false;
    }
    return Date.now() >= this.tokenExpiresAt;
  }

  private async ensureToken(force = false): Promise<void> {
    if (!this.managedToken) {
      if (!this.token) {
        throw new Error(
          "VaultStore requires VAULT_TOKEN or supported auth configuration",
        );
      }
      return;
    }
    const needsAuthentication = force || this.shouldRefreshToken();
    if (!needsAuthentication) {
      return;
    }
    if (!this.loginPromise) {
      this.loginPromise = this.authenticate().finally(() => {
        this.loginPromise = null;
      });
    }
    await this.loginPromise;
  }

  private async authenticate(): Promise<void> {
    if (!this.authConfig) {
      throw new Error("Vault authentication configuration is missing");
    }
    switch (this.authConfig.method) {
      case "kubernetes":
        await this.loginWithKubernetes(this.authConfig);
        break;
      default:
        throw new Error(
          `VaultStore auth method '${this.authConfig.method}' is not supported`,
        );
    }
  }

  private resolveKubernetesJwt(config: KubernetesAuthConfig): string {
    if (config.token && config.token.trim().length > 0) {
      return config.token.trim();
    }
    const tokenPath = config.tokenPath ?? DEFAULT_KUBERNETES_TOKEN_PATH;
    return readFileContent(tokenPath);
  }

  private async loginWithKubernetes(
    config: KubernetesAuthConfig,
  ): Promise<void> {
    const jwt = this.resolveKubernetesJwt(config);
    if (!jwt) {
      throw new Error("Vault Kubernetes auth requires a non-empty JWT");
    }
    const mountPath = trimSlashes(config.mountPath) || "kubernetes";
    const headers = this.createBaseHeaders({
      "Content-Type": "application/json",
    });
    const body = JSON.stringify({ role: config.role, jwt });
    const response = await this.send(`/v1/auth/${mountPath}/login`, {
      method: "POST",
      headers,
      body,
    });
    if (!response.ok) {
      throw new Error(
        `Vault authentication failed with status ${response.status}`,
      );
    }
    const payload = (await response.json()) as {
      auth?: { client_token?: string; lease_duration?: number };
    };
    const clientToken = payload.auth?.client_token?.trim();
    if (!clientToken) {
      throw new Error("Vault authentication response missing client_token");
    }
    this.updateToken(clientToken, payload.auth?.lease_duration);
  }

  private async request(
    path: string,
    init: RequestInit = {},
    tenantId?: string,
    retry = true,
  ): Promise<Response> {
    await this.ensureToken();
    if (!this.token) {
      throw new Error("Vault authentication did not yield a token");
    }
    const namespaceHeader = this.resolveNamespaceForTenant(tenantId);
    const headers = this.createBaseHeaders(init.headers, namespaceHeader);
    headers.set("X-Vault-Token", this.token);
    const response = await this.send(path, {
      ...init,
      headers,
    });
    if (
      (response.status === 401 || response.status === 403) &&
      this.managedToken &&
      retry
    ) {
      this.invalidateToken();
      return this.request(path, init, tenantId, false);
    }
    return response;
  }

  private async toVaultError(response: Response): Promise<Error> {
    const detail = await readVaultErrorMessage(response);
    const base = `Vault request failed with status ${response.status}`;
    if (detail) {
      return new Error(`${base}: ${detail}`);
    }
    return new Error(base);
  }

  async get(key: string): Promise<string | undefined> {
    const descriptor = toSecretDescriptor(key);
    const response = await this.request(
      `/v1/${this.mountPath}/data/${descriptor.path}`,
      undefined,
      descriptor.tenantId,
    );
    if (response.status === 404) {
      return undefined;
    }
    if (!response.ok) {
      throw await this.toVaultError(response);
    }
    const payload = (await response.json()) as {
      data?: { data?: Record<string, unknown> };
    };
    const rawValue = payload?.data?.data?.value;
    return typeof rawValue === "string" ? rawValue : undefined;
  }

  async set(key: string, value: string): Promise<void> {
    const descriptor = toSecretDescriptor(key);
    const response = await this.request(
      `/v1/${this.mountPath}/data/${descriptor.path}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ data: { value } }),
      },
      descriptor.tenantId,
    );
    if (!response.ok) {
      throw await this.toVaultError(response);
    }
  }

  async delete(key: string): Promise<void> {
    const descriptor = toSecretDescriptor(key);
    const response = await this.request(
      `/v1/${this.mountPath}/metadata/${descriptor.path}`,
      {
        method: "DELETE",
      },
      descriptor.tenantId,
    );
    if (response.status === 404) {
      return;
    }
    if (!response.ok) {
      throw await this.toVaultError(response);
    }
  }
}
