import { test, expect } from '@playwright/test'

const BASE = 'https://names.divine.video'

test.describe('Landing page', () => {
  test('loads with Register tab active by default', async ({ page }) => {
    await page.goto(BASE)
    // Search for an available name to make the form appear
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    // Register tab should be active (has divine color)
    const registerTab = page.locator('#tab-register')
    await expect(registerTab).toBeVisible()
    await expect(registerTab).toHaveClass(/text-divine/)

    // Register panel should be visible
    const registerPanel = page.locator('#panel-register')
    await expect(registerPanel).toBeVisible()

    // Sign In panel should be hidden
    const signinPanel = page.locator('#panel-signin')
    await expect(signinPanel).toBeHidden()
  })

  test('Register tab has email and invite code inputs', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    await expect(page.locator('#reserve-email-input')).toBeVisible()
    await expect(page.locator('#reserve-invite-input')).toBeVisible()
    await expect(page.locator('#reserve-submit-btn')).toBeVisible()
    await expect(page.locator('#reserve-submit-btn')).toHaveText('Claim Name')
  })

  test('Sign In tab shows all three auth methods', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    // Click Sign In tab
    await page.locator('#tab-signin').click()

    const signinPanel = page.locator('#panel-signin')
    await expect(signinPanel).toBeVisible()

    // 1. Divine email login (first) - email + password fields
    await expect(page.locator('#keycast-email')).toBeVisible()
    await expect(page.locator('#keycast-password')).toBeVisible()
    await expect(page.locator('#keycast-login-btn')).toBeVisible()

    // 2. Bunker connect (middle)
    await expect(page.locator('#bunker-url-input')).toBeVisible()
    await expect(page.locator('#bunker-connect-btn')).toBeVisible()

    // 3. Nostr extension (last)
    await expect(page.locator('#nostr-login-btn')).toBeVisible()
    await expect(page.locator('#nostr-login-btn')).toContainText('Nostr Extension')
  })

  test('name search works - available name', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('zzztestuniquename999')
    // Wait for debounce + API response
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })
    // Claim form should appear
    await expect(page.locator('#reserve-form')).toBeVisible()
    await expect(page.locator('#reserve-heading')).toContainText('Claim @')
  })

  test('name search works - taken name', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('rabble')
    await expect(page.locator('#check-result')).toContainText('reserved', { timeout: 5000 })
    // Claim form should NOT appear
    await expect(page.locator('#reserve-form')).toBeHidden()
  })

  test('register with invalid invite code shows error', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    await page.locator('#reserve-email-input').fill('test@example.com')
    await page.locator('#reserve-invite-input').fill('bad-code-123')
    await page.locator('#reserve-submit-btn').click()

    await expect(page.locator('#reserve-result')).toContainText('Invalid invite code', { timeout: 5000 })
  })

  test('keycast login with wrong credentials shows error', async ({ page }) => {
    await page.goto(BASE)
    // Need a name available first for the form to show
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    // Switch to Sign In tab
    await page.locator('#tab-signin').click()

    await page.locator('#keycast-email').fill('fake@example.com')
    await page.locator('#keycast-password').fill('wrongpassword')
    await page.locator('#keycast-login-btn').click()

    // Should show error from login.divine.video
    await expect(page.locator('#keycast-login-error')).not.toBeEmpty({ timeout: 10000 })
  })

  test('nostr extension button shows no-extension message when unavailable', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    await page.locator('#tab-signin').click()
    await page.locator('#nostr-login-btn').click()

    // No window.nostr in Playwright, so should show the no-extension message
    await expect(page.locator('#nostr-no-extension')).toBeVisible()
  })

  test('bunker connect with invalid URL shows error', async ({ page }) => {
    await page.goto(BASE)
    await page.locator('#name-input').fill('zzztestuniquename999')
    await expect(page.locator('#check-result')).toContainText('is available', { timeout: 5000 })

    await page.locator('#tab-signin').click()
    await page.locator('#bunker-url-input').fill('not-a-bunker-url')
    await page.locator('#bunker-connect-btn').click()

    await expect(page.locator('#bunker-error')).toContainText('must start with bunker://', { timeout: 5000 })
  })
})
