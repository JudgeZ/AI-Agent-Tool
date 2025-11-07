import { expect, test } from '@playwright/test';

const planId = 'plan-550e8400-e29b-41d4-a716-446655440000';

test('timeline renders orchestrator events and captures approval flow', async ({ page }) => {
  await page.goto(`/?plan=${planId}`);

  await expect(page.getByLabel('Plan ID')).toHaveValue(planId);

  const stepOne = page.getByTestId('step-s1');
  await expect(stepOne).toContainText('Index repository', { timeout: 10_000 });
  await expect(stepOne).toContainText('completed');

  const approvalModal = page.getByRole('dialog', { name: 'Approval required' });
  await expect(approvalModal).toContainText('Apply workspace edits');
  await expect(approvalModal).toContainText('src/example.ts');
  await approvalModal.getByLabel('Rationale (optional)').fill('Ship it');
  await approvalModal.getByRole('button', { name: 'Approve' }).click();

  await expect(approvalModal).toBeHidden({ timeout: 5_000 });

  const stepTwo = page.getByTestId('step-s2');
  await expect(stepTwo).toContainText('Apply repository changes');
  await expect(stepTwo).toContainText('repo.write');
  await expect(stepTwo).toContainText('approval required');
  await expect(stepTwo).toContainText('approved', { timeout: 10_000 });
  await expect(stepTwo).toContainText('completed', { timeout: 10_000 });
  await expect(stepTwo.locator('.history')).toContainText('12:00:00 AM', { timeout: 10_000 });

  const stepThree = page.getByTestId('step-s3');
  await expect(stepThree).toContainText('Run smoke tests', { timeout: 10_000 });
  await expect(stepThree).toContainText('completed', { timeout: 10_000 });
});
