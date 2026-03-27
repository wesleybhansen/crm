import { test, expect, type Page } from '@playwright/test'

const TENANT_ID = 'c82f1772-c4a5-4f9d-9dde-ec598bf94dc1'
const LOGIN_URL = `/login?tenant=${TENANT_ID}`
const EMAIL = 'wesley.b.hansen@gmail.com'
const PASSWORD = 'TestPass123!'

// Increase timeout for slow dev server first-compile
test.setTimeout(120000)

// Helper: login and wait for redirect
async function login(page: Page) {
  await page.goto(LOGIN_URL)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)

  const emailInput = page.locator('input[name="email"], input[type="email"]').first()
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first()
  await emailInput.fill(EMAIL)
  await passwordInput.fill(PASSWORD)

  const submitBtn = page.locator('button[type="submit"]').first()
  await submitBtn.click()
  await page.waitForURL(/backend/, { timeout: 15000 })
  await page.waitForTimeout(1000)
}

// ============================================================================
// LOGIN TESTS
// ============================================================================
test('login page loads with email field', async ({ page }) => {
  await page.goto(LOGIN_URL)
  await page.waitForLoadState('domcontentloaded')
  const emailInput = page.locator('input[name="email"], input[type="email"]').first()
  await expect(emailInput).toBeVisible({ timeout: 15000 })
})

test('login with valid credentials redirects to backend', async ({ page }) => {
  await login(page)
  expect(page.url()).toContain('/backend')
})

test('login with invalid credentials stays on login page', async ({ page }) => {
  await page.goto(LOGIN_URL)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(2000)
  const emailInput = page.locator('input[name="email"], input[type="email"]').first()
  const passwordInput = page.locator('input[name="password"], input[type="password"]').first()
  await emailInput.fill('wrong@example.com')
  await passwordInput.fill('wrongpass')
  await page.locator('button[type="submit"]').first().click()
  await page.waitForTimeout(3000)
  expect(page.url()).toContain('/login')
})

// ============================================================================
// PAGE LOAD SMOKE TESTS — does each page return HTML without 500 errors?
// ============================================================================
const pagesToTest = [
  '/backend/welcome',
  '/backend/dashboards',
  '/backend/contacts',
  '/backend/customers/deals/pipeline',
  '/backend/payments',
  '/backend/calendar',
  '/backend/automation-rules',
  '/backend/landing-pages',
  '/backend/funnels',
  '/backend/inbox',
  '/backend/email',
  '/backend/courses',
  '/backend/sequences',
  '/backend/surveys',
  '/backend/chat',
  '/backend/affiliates',
  '/backend/settings-simple',
]

for (const url of pagesToTest) {
  test(`page ${url} loads without 500`, async ({ page }) => {
    await login(page)
    const response = await page.goto(url)
    expect(response?.status()).toBeLessThan(500)
    await page.waitForLoadState('domcontentloaded')
    const bodyText = await page.locator('body').innerText()
    expect(bodyText).not.toContain('Internal Server Error')
    expect(bodyText).not.toContain('Module not found')
  })
}

// ============================================================================
// API ENDPOINT SMOKE TESTS
// ============================================================================
const apisToTest = [
  '/api/business-profile',
  '/api/auth/me',
  '/api/email/connections',
  '/api/twilio/connections',
  '/api/stripe/connections',
  '/api/sequences',
  '/api/campaigns',
  '/api/surveys',
  '/api/engagement',
  '/api/automation-rules',
  '/api/webhooks',
  '/api/funnels',
  '/api/affiliates',
  '/api/email/health',
  '/api/reminders',
  '/api/contacts/sources',
  '/api/contacts/duplicates',
  '/api/task-templates',
  '/api/email/templates',
  '/api/response-templates',
  '/api/sequences/recipes',
]

for (const url of apisToTest) {
  test(`API ${url} returns 200`, async ({ page }) => {
    await login(page)
    const response = await page.request.get(url)
    const status = response.status()
    expect(status).toBe(200)
    const data = await response.json()
    expect(data.ok).toBe(true)
  })
}
