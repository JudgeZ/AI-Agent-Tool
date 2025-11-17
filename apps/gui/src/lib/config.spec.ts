import { beforeEach, describe, expect, it, vi } from 'vitest';

describe('config', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it('uses defaults when environment variables are missing', async () => {
    const config = await import('./config');
    expect(config.orchestratorBaseUrl).toBe('http://127.0.0.1:4000');
    expect(config.gatewayBaseUrl).toBe('http://127.0.0.1:8080');
  });

  it('trims trailing slashes from environment overrides', async () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://example.test/root/');
    vi.stubEnv('VITE_GATEWAY_URL', 'https://gateway.test/');

    const config = await import('./config');
    expect(config.orchestratorBaseUrl).toBe('https://example.test/root');
    expect(config.gatewayBaseUrl).toBe('https://gateway.test');
  });

  it('derives gateway URL from orchestrator when not provided', async () => {
    vi.stubEnv('VITE_ORCHESTRATOR_URL', 'https://example.test:4000/');

    const config = await import('./config');
    expect(config.gatewayBaseUrl).toBe('https://example.test:8080');
  });

  it('encodes identifiers in generated URLs', async () => {
    const config = await import('./config');
    expect(config.ssePath('plan with spaces')).toBe(
      'http://127.0.0.1:4000/plan/plan%20with%20spaces/events'
    );
    expect(config.approvalPath('plan/with/slash', 'step+with+plus')).toBe(
      'http://127.0.0.1:4000/plan/plan%2Fwith%2Fslash/steps/step%2Bwith%2Bplus/approve'
    );
    const authorizeUrl = config.oidcAuthorizeUrl('https://app.example.test/auth?next=/plan/1');
    expect(authorizeUrl).toBe(
      'http://127.0.0.1:8080/auth/oidc/authorize?redirect_uri=https%3A%2F%2Fapp.example.test%2Fauth%3Fnext%3D%2Fplan%2F1&client_app=gui'
    );
  });

  it('throws when session binding is only whitespace', async () => {
    const config = await import('./config');
    expect(() =>
      config.oidcAuthorizeUrl('https://app.example.test/auth', {
        sessionBinding: '  '
      })
    ).toThrowError('sessionBinding must not be only whitespace');
  });
});
