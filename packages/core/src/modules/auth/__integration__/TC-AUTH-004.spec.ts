import { expect, test } from '@playwright/test';
import { login } from '@open-mercato/core/modules/core/__integration__/helpers/auth';

/**
 * TC-AUTH-004: User Logout
 * Source: .ai/qa/scenarios/TC-AUTH-004-user-logout.md
 */
test.describe('TC-AUTH-004: User Logout', () => {
  test('should clear session and redirect to login', async ({ page }) => {
    await login(page, 'admin');
    // A freshly-issued session can race client-side auth hydration and bounce
    // back to /login?redirect=… once. That is environment timing, not the
    // behaviour under test, so retry the login instead of failing on it —
    // this test's job is to verify LOGOUT clears the session.
    try {
      await expect(page).toHaveURL(/\/backend(?:\/.*)?$/, { timeout: 5_000 });
    } catch {
      await login(page, 'admin');
      await expect(page).toHaveURL(/\/backend(?:\/.*)?$/);
    }

    const menuButton = page.getByRole('button', { name: /admin@acme.com/i });
    await menuButton.waitFor({ state: 'visible' });
    await menuButton.click();
    await page.getByRole('menuitem', { name: /logout/i }).click({ force: true });
    await page.waitForTimeout(500);

    const cookies = await page.context().cookies();
    const authCookie = cookies.find((cookie) => cookie.name === 'auth_token');
    expect(authCookie).toBeUndefined();
  });
});
