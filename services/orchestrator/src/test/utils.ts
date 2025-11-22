import { loadConfig } from "../config.js";
import { sessionStore } from "../auth/SessionStore.js";

export function createOidcEnabledConfig() {
  const baseConfig = loadConfig();
  return {
    ...baseConfig,
    auth: {
      ...baseConfig.auth,
      oidc: {
        ...baseConfig.auth.oidc,
        enabled: true
      }
    }
  };
}

export function createSessionForUser(
  config: ReturnType<typeof createOidcEnabledConfig>,
  options: {
    userId: string;
    tenantId?: string;
    email?: string;
    name?: string;
    roles?: string[];
    scopes?: string[];
  }
) {
  return sessionStore.createSession(
    {
      subject: options.userId,
      email: options.email,
      name: options.name,
      tenantId: options.tenantId,
      roles: options.roles ?? [],
      scopes: options.scopes ?? [],
      claims: {},
    },
    config.auth.oidc.session.ttlSeconds
  );
}

