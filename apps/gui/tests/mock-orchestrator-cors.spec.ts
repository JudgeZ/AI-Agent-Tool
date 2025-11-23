import { expect, test } from '@playwright/test';

const orchestratorBaseUrl = 'http://127.0.0.1:4010';
const allowedOrigins = ['http://127.0.0.1:4173', 'http://localhost:4173'];

// These tests exercise the mock orchestrator's CORS handling to avoid regressions
// when the GUI dev/test servers use 127.0.0.1 instead of localhost.
test.describe('mock orchestrator CORS', () => {
  for (const origin of allowedOrigins) {
    test(`allows dev/test origin ${origin}`, async ({ request }) => {
      const response = await request.fetch(`${orchestratorBaseUrl}/plan/cors-check/events`, {
        method: 'OPTIONS',
        headers: {
          Origin: origin,
          'Access-Control-Request-Method': 'GET'
        }
      });

      expect(response.status()).toBe(204);
      expect(response.headers()['access-control-allow-origin']).toBe(origin);
    });
  }

  test('rejects disallowed origins', async ({ request }) => {
    const response = await request.fetch(`${orchestratorBaseUrl}/plan/cors-check/events`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://malicious.example',
        'Access-Control-Request-Method': 'GET'
      }
    });

    expect(response.status()).toBe(403);
  });
});
