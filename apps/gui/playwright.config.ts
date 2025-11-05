import type { PlaywrightTestConfig } from '@playwright/test';

const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const isCI = Boolean(env.CI);

const config: PlaywrightTestConfig = {
  testDir: './tests',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    headless: true
  },
  webServer: [
    {
      command: 'npm run mock:orchestrator',
      port: 4010,
      reuseExistingServer: !isCI,
      stdout: 'pipe',
      stderr: 'pipe'
    },
    {
      command: 'npm run dev:test',
      port: 4173,
      reuseExistingServer: !isCI,
      timeout: 120_000
    }
  ]
};

export default config;
