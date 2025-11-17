export const orchestratorBaseUrl = (() => {
  const fromEnv = import.meta.env.VITE_ORCHESTRATOR_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  return 'http://127.0.0.1:4000';
})();

const deriveOrigin = (value: string): string | undefined => {
  try {
    return new URL(value).origin;
  } catch {
    return undefined;
  }
};

export const gatewayBaseUrl = (() => {
  const fromEnv = import.meta.env.VITE_GATEWAY_URL as string | undefined;
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (orchestratorBaseUrl.endsWith(':4000')) {
    return orchestratorBaseUrl.replace(':4000', ':8080');
  }
  return orchestratorBaseUrl;
})();

export const orchestratorOrigin = deriveOrigin(orchestratorBaseUrl);
export const gatewayOrigin = deriveOrigin(gatewayBaseUrl);

export const defaultTenantId = (() => {
  const fromEnv = (import.meta.env.VITE_TENANT_ID as string | undefined)?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : null;
})();

export const ssePath = (planId: string) => `${orchestratorBaseUrl}/plan/${encodeURIComponent(planId)}/events`;
export const approvalPath = (planId: string, stepId: string) =>
  `${orchestratorBaseUrl}/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/approve`;
export const sessionPath = `${orchestratorBaseUrl}/auth/session`;
export const logoutPath = `${orchestratorBaseUrl}/auth/logout`;
export const oidcConfigPath = `${orchestratorBaseUrl}/auth/oidc/config`;
interface OidcAuthorizeOptions {
  tenantId?: string | null;
  clientApp?: string;
  sessionBinding?: string | null;
}

export const oidcAuthorizeUrl = (redirectUri: string, options?: OidcAuthorizeOptions) => {
  const params = new URLSearchParams();
  params.set('redirect_uri', redirectUri);
  const tenant = options?.tenantId ?? defaultTenantId;
  if (tenant) {
    params.set('tenant_id', tenant);
  }
  const clientApp = options?.clientApp ?? 'gui';
  if (clientApp) {
    params.set('client_app', clientApp);
  }
  const binding = options?.sessionBinding?.trim();
  if (binding) {
    params.set('session_binding', binding);
  }
  return `${gatewayBaseUrl}/auth/oidc/authorize?${params.toString()}`;
};
