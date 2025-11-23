import { expect, test } from '@playwright/test';

test.describe.configure({ retries: process.env.CI ? 2 : 0 });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.clear());
});

test('sidebars resize via pointer drag and persist dimensions', async ({ page }) => {
  await page.goto('/');
  await page.waitForLoadState('networkidle');

  const leftSidebar = page.locator('aside[aria-label="File explorer"]');
  const rightSidebar = page.locator('aside[aria-label="Agent panel"]');
  const leftHandle = page.getByRole('separator', { name: 'File explorer resize handle' });
  const rightHandle = page.getByRole('separator', { name: 'Agent panel resize handle' });

  await leftHandle.waitFor({ state: 'visible' });
  await rightHandle.waitFor({ state: 'visible' });

  const dragHandle = async (handle: typeof leftHandle, deltaX: number, notFound: string) => {
    const element = await handle.elementHandle();
    if (!element) throw new Error(notFound);

    await element.evaluate((el, delta) => {
        const rect = el.getBoundingClientRect();
        const startX = rect.x + rect.width / 2;
        const startY = rect.y + rect.height / 2;
        const targetX = startX + delta;

        const eventInit: PointerEventInit = {
          bubbles: true,
          pointerId: 1,
          pointerType: 'mouse',
          clientX: startX,
          clientY: startY,
          button: 0,
          buttons: 1
        };

        el.dispatchEvent(new PointerEvent('pointerdown', eventInit));
        window.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, clientX: targetX }));
        window.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, clientX: targetX, buttons: 0 }));
      }, deltaX);
  };

  await expect(leftSidebar).toHaveAttribute('style', /width: 260px/);

  await dragHandle(leftHandle, 70, 'Left resize handle was not found');

  await expect(leftSidebar).toHaveAttribute('style', /width: 330px/);

  await dragHandle(rightHandle, -120, 'Right resize handle was not found');

  await expect(rightSidebar).toHaveAttribute('style', /width: 500px/);

  const persistedLayout = await page.evaluate(() => localStorage.getItem('oss.ide.layout'));
  if (!persistedLayout) throw new Error('Layout was not persisted');

  const parsed = JSON.parse(persistedLayout) as { leftWidth?: number; rightWidth?: number };
  expect(parsed.leftWidth).toBe(330);
  expect(parsed.rightWidth).toBe(500);
});
