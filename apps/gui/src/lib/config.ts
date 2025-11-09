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

export const ssePath = (planId: string) => `${orchestratorBaseUrl}/plan/${encodeURIComponent(planId)}/events`;
export const approvalPath = (planId: string, stepId: string) =>
  `${orchestratorBaseUrl}/plan/${encodeURIComponent(planId)}/steps/${encodeURIComponent(stepId)}/approve`;
export const sessionPath = `${orchestratorBaseUrl}/auth/session`;
export const logoutPath = `${orchestratorBaseUrl}/auth/logout`;
export const oidcConfigPath = `${orchestratorBaseUrl}/auth/oidc/config`;
export const oidcAuthorizeUrl = (redirectUri: string) =>
  `${gatewayBaseUrl}/auth/oidc/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;
