import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import type { Knex } from 'knex'
import { isBlockedIpAddress } from '@open-mercato/shared/lib/network/blocked-ip'
import { openSecretForTenant, sealSecretForTenant } from '@open-mercato/shared/lib/encryption/secretColumns'

/*
 * The automation "Webhook" action, signed. It used to POST the event with no
 * signature, so a receiver could not tell a Noli request from anyone else's.
 *
 * Every request now carries:
 *   X-Noli-Timestamp: <unix seconds>
 *   X-Noli-Signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>">
 * keyed with the business's own signing secret. The secret is one per
 * business (automation_webhook_secrets, one row per tenant + organization),
 * stored sealed with the tenant's key like the other CRM credentials, and
 * shown to the owner once (the webhook step in the automation builder:
 * create, show once, replace). A business that sends a webhook before ever
 * opening that panel gets a secret made on the spot, still unshown, so the
 * owner can reveal it once later; no request is ever sent unsigned.
 *
 * Customer-supplied targets must resolve to public addresses (same rule as
 * the core webhooks module), and redirects are not followed, so the action
 * cannot be pointed at the box's own internal endpoints.
 *
 * Relative imports and packages only: automation actions run in the workers.
 */

export const WEBHOOK_TIMESTAMP_HEADER = 'X-Noli-Timestamp'
export const WEBHOOK_SIGNATURE_HEADER = 'X-Noli-Signature'
export const WEBHOOK_SECRETS_TABLE = 'automation_webhook_secrets'
const SECRET_PREFIX = 'whsec_'
const TIMEOUT_MS = 10_000

type Scope = { organizationId: string; tenantId: string }
export type WebhookActionResult = { success: boolean; skipped?: boolean; detail: string }

export type WebhookDeps = {
  fetchImpl?: (url: string, init: { method: string; headers: Record<string, string>; body: string; redirect: 'manual'; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>
  assertTarget?: (url: string) => Promise<void>
  seal?: (tenantId: string, plain: string) => Promise<string | null>
  open?: (tenantId: string, stored: string) => Promise<string | null>
  now?: () => Date
}

export function generateWebhookSecret(): string {
  return `${SECRET_PREFIX}${randomBytes(32).toString('base64url')}`
}

/** hex HMAC-SHA256 of "<timestamp>.<body>" keyed with the secret. */
export function signWebhookPayload(secret: string, timestamp: string, body: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')
}

/**
 * What a receiver does, here for tests and as the reference for the help text:
 * recompute, compare in constant time, and refuse stale timestamps.
 */
export function verifyWebhookSignature(
  secret: string,
  timestamp: string,
  body: string,
  signatureHeader: string,
  opts: { now?: Date; toleranceSeconds?: number } = {},
): boolean {
  const ts = Number(timestamp)
  if (!Number.isFinite(ts)) return false
  const nowSeconds = Math.floor((opts.now ?? new Date()).getTime() / 1000)
  if (Math.abs(nowSeconds - ts) > (opts.toleranceSeconds ?? 300)) return false
  const expected = Buffer.from(`sha256=${signWebhookPayload(secret, timestamp, body)}`, 'utf8')
  const got = Buffer.from(signatureHeader ?? '', 'utf8')
  return got.length === expected.length && timingSafeEqual(got, expected)
}

async function assertPublicTarget(rawUrl: string): Promise<void> {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('the webhook URL is not a valid URL') }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error('the webhook URL must start with https:// or http://')
  if (process.env.WEBHOOK_ALLOW_PRIVATE_TARGETS === '1') return
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal') || host.endsWith('.local')) {
    throw new Error('the webhook URL must be a public address')
  }
  const addresses = isIP(host) ? [{ address: host }] : await lookup(host, { all: true })
  for (const { address } of addresses) {
    if (isBlockedIpAddress(address)) throw new Error('the webhook URL must be a public address')
  }
}

const defaultSeal = (tenantId: string, plain: string) => sealSecretForTenant(null, tenantId, plain)
const defaultOpen = (tenantId: string, stored: string) => openSecretForTenant(null, tenantId, stored)

export type WebhookSecretStatus = { exists: boolean; createdAt: string | null; revealed: boolean }

async function loadSecretRow(knex: Knex, scope: Scope) {
  return knex(WEBHOOK_SECRETS_TABLE)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .first('id', 'secret', 'created_at', 'revealed_at')
}

/** Whether the business has a signing secret, when it was made, and whether it was already shown. Never the secret. */
export async function webhookSecretStatus(knex: Knex, scope: Scope): Promise<WebhookSecretStatus> {
  const row = await loadSecretRow(knex, scope)
  if (!row) return { exists: false, createdAt: null, revealed: false }
  return {
    exists: true,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    revealed: row.revealed_at != null,
  }
}

/**
 * Make a new secret (replacing any old one, which stops working at once) and
 * return it: the only time it is shown, so it is marked revealed.
 */
export async function rotateWebhookSecret(knex: Knex, scope: Scope, deps: WebhookDeps = {}): Promise<string> {
  const now = deps.now ? deps.now() : new Date()
  const secret = generateWebhookSecret()
  const sealed = await (deps.seal ?? defaultSeal)(scope.tenantId, secret)
  if (!sealed) throw new Error('Could not store the signing secret')
  const updated = await knex(WEBHOOK_SECRETS_TABLE)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .update({ secret: sealed, created_at: now, revealed_at: now, updated_at: now })
  if (!updated) {
    await knex(WEBHOOK_SECRETS_TABLE).insert({
      id: randomUUID(),
      organization_id: scope.organizationId,
      tenant_id: scope.tenantId,
      secret: sealed,
      created_at: now,
      revealed_at: now,
      updated_at: now,
    })
  }
  return secret
}

/**
 * Show a secret that exists but was never shown (made on the spot by a
 * webhook send). Exactly once: the reveal is a compare-and-set on
 * revealed_at, so a second click, or a second tab, gets null.
 */
export async function revealWebhookSecretOnce(knex: Knex, scope: Scope, deps: WebhookDeps = {}): Promise<string | null> {
  const now = deps.now ? deps.now() : new Date()
  const row = await loadSecretRow(knex, scope)
  if (!row || row.revealed_at != null) return null
  const claimed = await knex(WEBHOOK_SECRETS_TABLE)
    .where('id', row.id)
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereNull('revealed_at')
    .update({ revealed_at: now, updated_at: now })
  if (!claimed) return null
  return (deps.open ?? defaultOpen)(scope.tenantId, row.secret)
}

/** The business's signing secret for a send, made (unshown) when it has none. Null when it cannot be read. */
export async function signingSecretForSend(knex: Knex, scope: Scope, deps: WebhookDeps = {}): Promise<string | null> {
  let row = await loadSecretRow(knex, scope)
  if (!row) {
    const now = deps.now ? deps.now() : new Date()
    const sealed = await (deps.seal ?? defaultSeal)(scope.tenantId, generateWebhookSecret())
    if (!sealed) return null
    await knex(WEBHOOK_SECRETS_TABLE)
      .insert({
        id: randomUUID(),
        organization_id: scope.organizationId,
        tenant_id: scope.tenantId,
        secret: sealed,
        created_at: now,
        revealed_at: null,
        updated_at: now,
      })
      .onConflict(['tenant_id', 'organization_id'])
      .ignore()
    // Two sends racing: whichever row won is the secret both sign with.
    row = await loadSecretRow(knex, scope)
    if (!row) return null
  }
  return (deps.open ?? defaultOpen)(scope.tenantId, row.secret)
}

/** POST one signed automation event to the configured URL. */
export async function sendAutomationWebhook(
  knex: Knex,
  scope: Scope,
  input: { url: unknown; headers?: unknown; event: string; data: Record<string, unknown> },
  deps: WebhookDeps = {},
): Promise<WebhookActionResult> {
  const url = typeof input.url === 'string' ? input.url.trim() : ''
  if (!url) return { success: false, detail: 'Webhook URL required' }
  try {
    await (deps.assertTarget ?? assertPublicTarget)(url)
  } catch (err) {
    return { success: false, detail: `Webhook not sent: ${err instanceof Error ? err.message : 'invalid URL'}` }
  }

  const secret = await signingSecretForSend(knex, scope, deps).catch((err) => {
    console.error('[automation-webhook] signing secret unavailable', { organizationId: scope.organizationId, error: err instanceof Error ? err.message : String(err) })
    return null
  })
  if (!secret) {
    return { success: false, detail: 'Webhook not sent: the signing secret could not be read. Replace it in the Webhook step of this automation, then update your receiver.' }
  }

  const now = deps.now ? deps.now() : new Date()
  const timestamp = String(Math.floor(now.getTime() / 1000))
  const body = JSON.stringify({ event: input.event, timestamp: now.toISOString(), data: input.data })
  // The owner's own headers (e.g. an API key their receiver wants), minus any
  // that would replace ours: the signature and timestamp cannot be overridden.
  const reserved = new Set(['content-type', 'user-agent', WEBHOOK_TIMESTAMP_HEADER.toLowerCase(), WEBHOOK_SIGNATURE_HEADER.toLowerCase()])
  const headers: Record<string, string> = {}
  if (input.headers && typeof input.headers === 'object' && !Array.isArray(input.headers)) {
    for (const [key, value] of Object.entries(input.headers as Record<string, unknown>)) {
      if (typeof value === 'string' && /^[A-Za-z0-9-]+$/.test(key) && !reserved.has(key.toLowerCase())) headers[key] = value
    }
  }
  headers['Content-Type'] = 'application/json'
  headers['User-Agent'] = 'Noli-Automations/1'
  headers[WEBHOOK_TIMESTAMP_HEADER] = timestamp
  headers[WEBHOOK_SIGNATURE_HEADER] = `sha256=${signWebhookPayload(secret, timestamp, body)}`

  const fetchImpl = deps.fetchImpl ?? ((target, init) => fetch(target, init))
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body,
      redirect: 'manual',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
    })
    return { success: res.ok, detail: `Webhook ${res.ok ? 'delivered' : 'failed'}: ${res.status}` }
  } catch (err) {
    return { success: false, detail: `Webhook error: ${err instanceof Error ? err.message : 'Unknown'}` }
  }
}
