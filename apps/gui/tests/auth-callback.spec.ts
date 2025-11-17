import { expect, test } from '@playwright/test';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

test('auth callback success message is shown and binding ignored by UI', async ({ page }) => {
  await page.goto('/auth/callback?status=success&session_binding=bind-123');
  await expect(page.locator('h1')).toHaveText(/Authentication successful/i);
  await expect(page.locator('p')).toContainText('You can return to the application window');
});

test('auth callback failure shows error reason when provided', async ({ page }) => {
  await page.goto('/auth/callback?status=error&error=Access%20denied&session_binding=bind-abc');
  await expect(page.locator('h1')).toHaveText(/Authentication failed/i);
  await expect(page.locator('p')).toContainText('Access denied');
});
