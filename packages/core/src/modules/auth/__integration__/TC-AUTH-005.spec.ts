import { expect, test } from '@playwright/test';

/**
 * TC-AUTH-005: Password Reset Request
 * Source: .ai/qa/scenarios/TC-AUTH-005-password-reset-request.md
 */
test.describe('TC-AUTH-005: Password Reset Request', () => {
  test('should accept reset request and show generic confirmation', async ({ page }) => {
    const noliResetPage = await page.goto('/forgot-password');
    if (noliResetPage?.status() === 404) {
      await page.goto('/reset');
    }
    await expect(page.getByText(/reset (?:your )?password/i).first()).toBeVisible();

    await page.getByLabel('Email').fill('admin@acme.com');
    await page.getByRole('button', { name: /send reset link/i }).click();

    await expect(page.getByText(/if an account(?: with that email)? exists/i)).toBeVisible();
  });
});
