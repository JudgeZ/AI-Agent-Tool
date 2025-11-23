import { expect, test } from '@playwright/test';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test('sidebars resize via pointer drag and persist dimensions', async ({ page }) => {
  await page.goto('/');

  const leftSidebar = page.locator('aside[aria-label="File explorer"]');
  const rightSidebar = page.locator('aside[aria-label="Agent panel"]');
  const leftHandle = page.getByRole('separator', { name: 'File explorer resize handle' });
  const rightHandle = page.getByRole('separator', { name: 'Agent panel resize handle' });

  await expect(leftSidebar).toHaveAttribute('style', /width: 260px/);

  const leftBox = await leftHandle.boundingBox();
  if (!leftBox) throw new Error('Left resize handle was not found');

  await page.mouse.move(leftBox.x + leftBox.width / 2, leftBox.y + leftBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(leftBox.x + leftBox.width / 2 + 70, leftBox.y + leftBox.height / 2);
  await page.mouse.up();

  await expect(leftSidebar).toHaveAttribute('style', /width: 330px/);

  const rightBox = await rightHandle.boundingBox();
  if (!rightBox) throw new Error('Right resize handle was not found');

  await page.mouse.move(rightBox.x + rightBox.width / 2, rightBox.y + rightBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(rightBox.x + rightBox.width / 2 - 120, rightBox.y + rightBox.height / 2);
  await page.mouse.up();

  await expect(rightSidebar).toHaveAttribute('style', /width: 500px/);

  const persistedLayout = await page.evaluate(() => localStorage.getItem('oss.ide.layout'));
  if (!persistedLayout) throw new Error('Layout was not persisted');

  const parsed = JSON.parse(persistedLayout) as { leftWidth?: number; rightWidth?: number };
  expect(parsed.leftWidth).toBe(330);
  expect(parsed.rightWidth).toBe(500);
});
