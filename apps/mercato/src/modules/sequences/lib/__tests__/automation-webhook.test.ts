import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  WEBHOOK_SIGNATURE_HEADER,
  WEBHOOK_TIMESTAMP_HEADER,
  revealWebhookSecretOnce,
  rotateWebhookSecret,
  sendAutomationWebhook,
  signWebhookPayload,
  verifyWebhookSignature,
  webhookSecretStatus,
} from '../automation-webhook'

/**
 * The automation "Webhook" action was unsigned. Every request now carries
 * X-Noli-Timestamp and X-Noli-Signature (HMAC-SHA256 over "<timestamp>.<body>")
 * keyed with the business's own secret, sealed at rest and shown once.
 * No real request leaves the test: fetch is injected.
 */

const scope = { organizationId: 'org-1', tenantId: 'ten-1' }
const other = { organizationId: 'org-2', tenantId: 'ten-2' }
const now = new Date('2026-09-30T12:00:00.000Z')

// A stand-in for the tenant key: sealed values are visibly not the secret.
const seal = jest.fn(async (tenantId: string, plain: string) => `sealed:${tenantId}:${Buffer.from(plain).toString('base64')}`)
const open = jest.fn(async (tenantId: string, stored: string) => {
  const [tag, owner, body] = stored.split(':')
  return tag === 'sealed' && owner === tenantId ? Buffer.from(body!, 'base64').toString('utf8') : null
})

function world() {
  return createFakeDb({ automation_webhook_secrets: [] }, { automation_webhook_secrets: [['tenant_id', 'organization_id']] })
}

function capture() {
  const calls: Array<{ url: string; headers: Record<string, string>; body: string; redirect: string }> = []
  const fetchImpl = jest.fn(async (url: string, init: { headers: Record<string, string>; body: string; redirect: string }) => {
    calls.push({ url, headers: init.headers, body: init.body, redirect: init.redirect })
    return { ok: true, status: 200 }
  })
  return { calls, fetchImpl }
}

const deps = (extra: Record<string, unknown> = {}) => ({ seal, open, now: () => now, assertTarget: async () => undefined, ...extra })

describe('signed automation webhooks', () => {
  beforeEach(() => { seal.mockClear(); open.mockClear() })

  it('signs every request so the receiver can verify it, and the owner’s headers cannot override the signature', async () => {
    const knex = world()
    const { calls, fetchImpl } = capture()
    const result = await sendAutomationWebhook(knex as never, scope, {
      url: 'https://hooks.example.test/noli',
      headers: { 'X-Api-Key': 'receiver-key', 'x-noli-signature': 'forged', 'Content-Type': 'text/plain' },
      event: 'deal_won',
      data: { dealId: 'deal-1' },
    }, deps({ fetchImpl }))
    expect(result).toEqual({ success: true, detail: 'Webhook delivered: 200' })

    const [call] = calls
    expect(call!.redirect).toBe('manual')
    expect(call!.headers['X-Api-Key']).toBe('receiver-key')
    expect(call!.headers['x-noli-signature']).toBeUndefined()
    expect(call!.headers['Content-Type']).toBe('application/json')
    expect(call!.headers[WEBHOOK_TIMESTAMP_HEADER]).toBe(String(now.getTime() / 1000))

    // The receiver's check, with the secret the owner sees once.
    const secret = await revealWebhookSecretOnce(knex as never, scope, deps())
    expect(secret).toMatch(/^whsec_/)
    expect(call!.headers[WEBHOOK_SIGNATURE_HEADER]).toBe(`sha256=${signWebhookPayload(secret!, call!.headers[WEBHOOK_TIMESTAMP_HEADER]!, call!.body)}`)
    expect(verifyWebhookSignature(secret!, call!.headers[WEBHOOK_TIMESTAMP_HEADER]!, call!.body, call!.headers[WEBHOOK_SIGNATURE_HEADER]!, { now })).toBe(true)
    expect(verifyWebhookSignature(secret!, call!.headers[WEBHOOK_TIMESTAMP_HEADER]!, call!.body.replace('deal-1', 'deal-2'), call!.headers[WEBHOOK_SIGNATURE_HEADER]!, { now })).toBe(false)
    expect(verifyWebhookSignature(secret!, call!.headers[WEBHOOK_TIMESTAMP_HEADER]!, call!.body, call!.headers[WEBHOOK_SIGNATURE_HEADER]!, { now: new Date(now.getTime() + 10 * 60 * 1000) })).toBe(false)
    expect(JSON.parse(call!.body)).toMatchObject({ event: 'deal_won', data: { dealId: 'deal-1' } })
  })

  it('stores the secret sealed, one per business, and shows it only once', async () => {
    const knex = world()
    const { fetchImpl } = capture()
    await sendAutomationWebhook(knex as never, scope, { url: 'https://hooks.example.test/a', event: 'x', data: {} }, deps({ fetchImpl }))
    await sendAutomationWebhook(knex as never, scope, { url: 'https://hooks.example.test/a', event: 'x', data: {} }, deps({ fetchImpl }))
    await sendAutomationWebhook(knex as never, other, { url: 'https://hooks.example.test/b', event: 'x', data: {} }, deps({ fetchImpl }))

    const rows = knex.db.tables.automation_webhook_secrets
    expect(rows).toHaveLength(2)
    for (const row of rows) expect(String(row.secret)).toMatch(/^sealed:/)
    await expect(webhookSecretStatus(knex as never, scope)).resolves.toMatchObject({ exists: true, revealed: false })

    const shown = await revealWebhookSecretOnce(knex as never, scope, deps())
    expect(shown).toMatch(/^whsec_/)
    await expect(revealWebhookSecretOnce(knex as never, scope, deps())).resolves.toBeNull()
    await expect(webhookSecretStatus(knex as never, scope)).resolves.toMatchObject({ exists: true, revealed: true })
    // The other business's secret is its own.
    const otherSecret = await revealWebhookSecretOnce(knex as never, other, deps())
    expect(otherSecret).not.toBe(shown)
  })

  it('replacing the secret returns a new one and the old one stops verifying', async () => {
    const knex = world()
    const first = await rotateWebhookSecret(knex as never, scope, deps())
    const second = await rotateWebhookSecret(knex as never, scope, deps())
    expect(second).not.toBe(first)
    expect(knex.db.tables.automation_webhook_secrets).toHaveLength(1)

    const { calls, fetchImpl } = capture()
    await sendAutomationWebhook(knex as never, scope, { url: 'https://hooks.example.test/a', event: 'x', data: {} }, deps({ fetchImpl }))
    const [call] = calls
    const ts = call!.headers[WEBHOOK_TIMESTAMP_HEADER]!
    expect(verifyWebhookSignature(second, ts, call!.body, call!.headers[WEBHOOK_SIGNATURE_HEADER]!, { now })).toBe(true)
    expect(verifyWebhookSignature(first, ts, call!.body, call!.headers[WEBHOOK_SIGNATURE_HEADER]!, { now })).toBe(false)
  })

  it('never sends unsigned: an unreadable secret stops the send', async () => {
    const knex = world()
    const { calls, fetchImpl } = capture()
    await rotateWebhookSecret(knex as never, scope, deps())
    const result = await sendAutomationWebhook(knex as never, scope, { url: 'https://hooks.example.test/a', event: 'x', data: {} }, deps({ fetchImpl, open: async () => null }))
    expect(result.success).toBe(false)
    expect(result.detail).toMatch(/signing secret could not be read/)
    expect(calls).toHaveLength(0)
  })

  it('refuses private and internal targets', async () => {
    const knex = world()
    const { calls, fetchImpl } = capture()
    for (const url of ['http://localhost:3000/api/internal/outbound-events/drain', 'http://127.0.0.1/x', 'http://169.254.169.254/latest/meta-data', 'http://10.0.0.5/x', 'ftp://example.test/x']) {
      const result = await sendAutomationWebhook(knex as never, scope, { url, event: 'x', data: {} }, { seal, open, now: () => now, fetchImpl })
      expect(result.success).toBe(false)
      expect(result.detail).toMatch(/^Webhook not sent/)
    }
    expect(calls).toHaveLength(0)
  })
})
