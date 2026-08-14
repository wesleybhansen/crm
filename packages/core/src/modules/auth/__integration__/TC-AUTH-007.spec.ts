import { expect, test } from '@playwright/test';

/**
 * TC-AUTH-007: Password Reset with Expired Token
 * Source: .ai/qa/scenarios/TC-AUTH-007-password-reset-expired-token.md
 */
test.describe('TC-AUTH-007: Password Reset with Expired Token', () => {
  test('should reject invalid and expired reset tokens', async ({ page }) => {
    const noliResetPage = await page.goto('/reset-password?token=qa-expired-token');
    if (noliResetPage?.status() === 404) {
      await page.goto('/reset/qa-expired-token');
    }
    await page.getByLabel(/new password/i).fill('Valid1!Pass');
    let confirmPassword = page.getByLabel(/confirm password/i);
    if (await confirmPassword.isVisible().catch(() => false)) {
      await confirmPassword.fill('Valid1!Pass');
    }
    await page.getByRole('button', { name: /update password/i }).click();
    await expect(page.getByText(/invalid or expired (?:reset )?(?:link|token)/i)).toBeVisible();

    const noliMalformedPage = await page.goto('/reset-password?token=qa-malformed-token');
    if (noliMalformedPage?.status() === 404) {
      await page.goto('/reset/qa-malformed-token');
    }
    await page.getByLabel(/new password/i).fill('Valid1!Pass');
    confirmPassword = page.getByLabel(/confirm password/i);
    if (await confirmPassword.isVisible().catch(() => false)) {
      await confirmPassword.fill('Valid1!Pass');
    }
    await page.getByRole('button', { name: /update password/i }).click();
    await expect(page.getByText(/invalid or expired (?:reset )?(?:link|token)/i)).toBeVisible();
  });
});
