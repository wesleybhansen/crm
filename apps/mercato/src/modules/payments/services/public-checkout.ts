// ORM-SKIP: checkout_offers, landing_page_checkouts, products, courses and stripe_connections are raw-knex tables
/**
 * Public checkout on the business's own Stripe account (2026-09-25).
 *
 * Two public entry points share one core:
 *  - an OFFER (checkout_offers row): POST /api/payments/public/offers/{id}/checkout.
 *    Marketing pages (AMS, pages.noliai.com and the business's custom
 *    domains) sell through offers; the page names the offer and where to send
 *    the buyer back, nothing else.
 *  - a CRM landing page (transition): POST /api/landing_pages/public/{slug}/checkout
 *    for pages built with the CRM wizard; the page's saved config names the
 *    product.
 *
 * Rules, for both:
 *  - The price, currency, billing mode and seller come from server-side rows
 *    (the offer or page, and that organization's own product or course).
 *    Nothing in the request can choose a price, another product, or another
 *    business.
 *  - The Checkout Session is created ON THE BUSINESS'S OWN connected Stripe
 *    account (stripe_connections, Stripe-Account header). The money goes to
 *    the business; Noli's platform account is never charged against and takes
 *    no application fee. The connected account must be able to take charges.
 *  - Every session gets a landing_page_checkouts row. The Stripe webhook claims
 *    that row atomically before recording the payment, so retries and
 *    concurrent redeliveries record the payment once, and only when the event
 *    comes from the account the session was created on.
 *  - A double click reuses one session: the page sends a per-attempt request
 *    id, which derives the checkout id and the Stripe idempotency key.
 *  - Callers run sandboxed in an opaque origin (or on another site), so both
 *    endpoints answer CORS without credentials (src/lib/public-surface.ts).
 *
 * Imports are relative or package-only: the Stripe webhook imports this file.
 */
import crypto from 'node:crypto'
import type { Knex } from 'knex'

export const NOT_SET_UP_MESSAGE = "This page isn't set up to take payments yet"
export const WRONG_PRODUCT_MESSAGE = "That product isn't sold on this page"
export const BAD_RETURN_URL_MESSAGE = "This page isn't allowed to take payments for this offer"
const UNAVAILABLE_MESSAGE = 'Checkout is unavailable right now. Please try again in a moment.'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value)
}

export function normalizeBuyerEmail(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const email = value.trim().toLowerCase()
  if (!email || email.length > 254 || !EMAIL_RE.test(email)) return null
  return email
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max)
}

// ---------------------------------------------------------------------------
// Hosts a buyer may be sent back to after paying for an offer.
// ---------------------------------------------------------------------------

/** The platform host marketing pages are served from (PUBLIC_PAGES_HOST, default pages.noliai.com). */
export function platformPagesHosts(env: Record<string, string | undefined> = process.env): string[] {
  const raw = env.PUBLIC_PAGES_HOST || 'pages.noliai.com'
  return raw.split(',').map((h) => h.trim().toLowerCase()).filter(Boolean)
}

/** A bare, lower-case host name, or null when the value is not one. */
export function normalizeHost(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  let value = raw.trim().toLowerCase()
  if (!value) return null
  value = value.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0].split('#')[0].replace(/:\d+$/, '')
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(value)) return null
  return value
}

/** Hosts owned by Noli that a business may not list, except the platform pages host. */
export function isReservedHost(host: string, env: Record<string, string | undefined> = process.env): boolean {
  if (platformPagesHosts(env).includes(host)) return false
  if (host === 'localhost' || host === '127.0.0.1') return true
  if (host === 'noliai.com' || host.endsWith('.noliai.com')) return true
  if (host === 'thelaunchpadincubator.com' || host.endsWith('.thelaunchpadincubator.com')) return true
  try {
    if (env.APP_URL && new URL(env.APP_URL).hostname.toLowerCase() === host) return true
  } catch {}
  return false
}

/**
 * The https return URL, when its host is one the offer allows; else null.
 * Exact host match: no wildcards, no credentials in the URL.
 */
export function allowedReturnUrl(raw: unknown, hosts: string[]): URL | null {
  if (typeof raw !== 'string' || raw.length > 2000) return null
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  return hosts.map((h) => h.toLowerCase()).includes(host) ? url : null
}

/** Append Stripe's session placeholder without URL-encoding its braces. */
function withQuery(url: URL, key: string, rawValue: string): string {
  const base = url.toString()
  const hashIndex = base.indexOf('#')
  const main = hashIndex === -1 ? base : base.slice(0, hashIndex)
  const hash = hashIndex === -1 ? '' : base.slice(hashIndex)
  return `${main}${main.includes('?') ? '&' : '?'}${key}=${rawValue}${hash}`
}

// ---------------------------------------------------------------------------
// Rate limiting (per instance, sliding window). The dispatcher also applies a
// per-IP limit from each route's metadata; these add per-page / per-offer caps.
// ---------------------------------------------------------------------------

export type WindowLimit = { max: number; windowMs: number }

export class SlidingWindowLimiter {
  private hits = new Map<string, number[]>()
  constructor(private readonly limit: WindowLimit, private readonly now: () => number = Date.now) {}

  /** Records a hit and returns true when the key is over its limit. */
  hit(key: string): boolean {
    const now = this.now()
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < this.limit.windowMs)
    recent.push(now)
    this.hits.set(key, recent)
    if (this.hits.size > 5000) {
      for (const [k, v] of this.hits) {
        if (v.every((t) => now - t >= this.limit.windowMs)) this.hits.delete(k)
      }
    }
    return recent.length > this.limit.max
  }

  reset(): void {
    this.hits.clear()
  }
}

/** One visitor: 10 checkout starts per 10 minutes on any one page or offer. */
export const perIpTargetLimiter = new SlidingWindowLimiter({ max: 10, windowMs: 10 * 60 * 1000 })
/** One page or offer, all visitors: 120 checkout starts per 10 minutes. */
export const perTargetLimiter = new SlidingWindowLimiter({ max: 120, windowMs: 10 * 60 * 1000 })

export function resetCheckoutLimiters(): void {
  perIpTargetLimiter.reset()
  perTargetLimiter.reset()
}

// ---------------------------------------------------------------------------
// Stripe
// ---------------------------------------------------------------------------

export type StripeLike = {
  checkout: { sessions: { create: (params: any, options?: any) => Promise<{ id: string; url: string | null }> } }
  accounts: { retrieve: (id: string) => Promise<{ id: string; charges_enabled?: boolean }> }
}

export async function platformStripe(): Promise<StripeLike | null> {
  const key = process.env.STRIPE_SECRET_KEY
  if (!key) return null
  const Stripe = (await import('stripe')).default
  return new Stripe(key) as unknown as StripeLike
}

const chargesCache = new Map<string, { ok: boolean; at: number }>()
export function clearChargesEnabledCache(): void {
  chargesCache.clear()
}

/** True when the connected account can take charges. Cached 5 min (ok) / 30 s (not ok). */
export async function accountCanCharge(stripe: StripeLike, accountId: string, now: () => number = Date.now): Promise<boolean> {
  const cached = chargesCache.get(accountId)
  if (cached && now() - cached.at < (cached.ok ? 5 * 60 * 1000 : 30 * 1000)) return cached.ok
  let ok = false
  try {
    const account = await stripe.accounts.retrieve(accountId)
    ok = account?.charges_enabled === true
  } catch (err) {
    console.warn('[payments.public-checkout] could not read connected account', accountId, err instanceof Error ? err.message : err)
    ok = false
  }
  chargesCache.set(accountId, { ok, at: now() })
  return ok
}

/** The organization's active connected Stripe account id, or null. */
export async function connectedAccountFor(knex: Knex, organizationId: string): Promise<string | null> {
  const conn = await knex('stripe_connections')
    .where('organization_id', organizationId)
    .where('is_active', true)
    .first()
  const id = conn?.stripe_account_id
  return typeof id === 'string' && id.startsWith('acct_') ? id : null
}

// ---------------------------------------------------------------------------
// What is sold: a product or course of the seller's own organization.
// ---------------------------------------------------------------------------

export type CheckoutItem = {
  kind: 'product' | 'course'
  id: string
  name: string
  description: string | null
  unitAmount: number
  currency: string
  recurring: { interval: 'day' | 'week' | 'month' | 'year' } | null
  trialDays: number | null
  collectPhone: boolean
}

type Owner = { organization_id: string; tenant_id: string }
const INTERVALS = new Set(['day', 'week', 'month', 'year'])

export async function loadItem(knex: Knex, owner: Owner, kind: 'product' | 'course', id: unknown): Promise<CheckoutItem | null> {
  if (!isUuid(id)) return null
  if (kind === 'course') {
    const course = await knex('courses')
      .where('id', id)
      .where('organization_id', owner.organization_id)
      .where('tenant_id', owner.tenant_id)
      .where('is_published', true)
      .whereNull('deleted_at')
      .first()
    if (!course || course.is_free) return null
    const amount = Math.round(Number(course.price) * 100)
    if (!Number.isFinite(amount) || amount <= 0) return null
    return {
      kind: 'course', id: course.id, name: String(course.title || 'Course'),
      description: course.description ? String(course.description).slice(0, 500) : null,
      unitAmount: amount, currency: String(course.currency || 'usd').toLowerCase(),
      recurring: null, trialDays: null, collectPhone: false,
    }
  }
  const product = await knex('products')
    .where('id', id)
    .where('organization_id', owner.organization_id)
    .where('tenant_id', owner.tenant_id)
    .where('is_active', true)
    .whereNull('deleted_at')
    .first()
  if (!product) return null
  const amount = Math.round(Number(product.price) * 100)
  if (!Number.isFinite(amount) || amount <= 0) return null
  const recurring = product.billing_type === 'recurring'
    ? { interval: (INTERVALS.has(product.recurring_interval) ? product.recurring_interval : 'month') as 'day' | 'week' | 'month' | 'year' }
    : null
  const trial = Number(product.trial_days)
  return {
    kind: 'product', id: product.id, name: String(product.name || 'Product'),
    description: product.description ? String(product.description).slice(0, 500) : null,
    unitAmount: amount, currency: String(product.currency || 'usd').toLowerCase(),
    recurring, trialDays: recurring && Number.isInteger(trial) && trial > 0 ? trial : null,
    collectPhone: product.collect_phone === true,
  }
}

export function itemMode(item: CheckoutItem): 'payment' | 'subscription' {
  return item.recurring ? 'subscription' : 'payment'
}

// ---------------------------------------------------------------------------
// Core: one Checkout Session on the seller's account, one tracking row.
// ---------------------------------------------------------------------------

export type CheckoutFailure = { ok: false; error: string }
export type CheckoutResult = { status: number; body: { ok: true; url: string } | CheckoutFailure }

export type CheckoutDeps = {
  knex: Knex
  stripe: StripeLike | null
  appUrl: string
}

function fail(status: number, error: string): CheckoutResult {
  return { status, body: { ok: false, error } }
}

/** Deterministic UUID (v4 layout) from a hash, so a double click maps to one checkout. */
function uuidFromHash(hex: string): string {
  const h = hex.slice(0, 32).split('')
  h[12] = '4'
  h[16] = ((parseInt(h[16], 16) & 0x3) | 0x8).toString(16)
  const s = h.join('')
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

type SessionInput = {
  owner: Owner
  item: CheckoutItem
  source: 'offer' | 'landing_page'
  /** Stable identity of what is being bought from where (offer id or page id). */
  target: string
  offerId: string | null
  landingPageId: string | null
  pageRef: string | null
  email: string | null
  name: string
  requestId: unknown
  successUrl: string
  cancelUrl: string
  metadata: Record<string, string>
}

async function startSession(deps: CheckoutDeps, input: SessionInput): Promise<CheckoutResult> {
  const { knex } = deps
  const accountId = await connectedAccountFor(knex, input.owner.organization_id)
  if (!accountId || !deps.stripe) return fail(400, NOT_SET_UP_MESSAGE)
  if (!(await accountCanCharge(deps.stripe, accountId))) return fail(400, NOT_SET_UP_MESSAGE)

  const requestId = typeof input.requestId === 'string' && REQUEST_ID_RE.test(input.requestId) ? input.requestId : null
  const requestKey = crypto
    .createHash('sha256')
    .update([input.source, input.target, input.item.kind, input.item.id, accountId, input.email ?? '', input.successUrl, requestId ?? crypto.randomUUID()].join('|'))
    .digest('hex')
  const checkoutId = uuidFromHash(requestKey)

  const existing = await knex('landing_page_checkouts').where('id', checkoutId).first()
  if (existing?.checkout_url && existing.status === 'pending') return { status: 200, body: { ok: true, url: existing.checkout_url } }
  if (existing && existing.status !== 'pending') return fail(409, 'This order has already been placed')

  const item = input.item
  const metadata: Record<string, string> = {
    ...input.metadata,
    type: item.kind === 'course' ? 'course' : input.source,
    source: input.source,
    landingPageCheckoutId: checkoutId,
    orgId: input.owner.organization_id,
    tenantId: input.owner.tenant_id,
    customerName: input.name,
    customerEmail: input.email ?? '',
  }
  if (input.offerId) metadata.offerId = input.offerId
  if (input.pageRef) metadata.pageRef = input.pageRef.slice(0, 200)
  if (item.kind === 'product') metadata.productId = item.id
  if (item.kind === 'course') {
    metadata.courseId = item.id
    metadata.studentEmail = input.email ?? ''
    metadata.studentName = input.name || (input.email ?? '')
  }

  const mode = itemMode(item)
  const params: Record<string, any> = {
    mode,
    line_items: [{
      price_data: {
        currency: item.currency,
        product_data: { name: item.name, ...(item.description ? { description: item.description } : {}) },
        unit_amount: item.unitAmount,
        ...(item.recurring ? { recurring: item.recurring } : {}),
      },
      quantity: 1,
    }],
    client_reference_id: checkoutId,
    metadata,
    success_url: input.successUrl,
    cancel_url: input.cancelUrl,
  }
  if (input.email) params.customer_email = input.email
  if (item.collectPhone) params.phone_number_collection = { enabled: true }
  if (item.recurring) {
    params.subscription_data = { metadata, ...(item.trialDays ? { trial_period_days: item.trialDays } : {}) }
  } else {
    params.payment_intent_data = { metadata }
  }

  let session: { id: string; url: string | null }
  try {
    session = await deps.stripe.checkout.sessions.create(params, {
      stripeAccount: accountId,
      idempotencyKey: `noli-checkout-${requestKey}`,
    })
  } catch (err) {
    console.error('[payments.public-checkout] Stripe session create failed', err instanceof Error ? err.message : err)
    return fail(502, UNAVAILABLE_MESSAGE)
  }
  if (!session?.url) return fail(502, UNAVAILABLE_MESSAGE)

  const now = new Date()
  await knex('landing_page_checkouts')
    .insert({
      id: checkoutId,
      tenant_id: input.owner.tenant_id,
      organization_id: input.owner.organization_id,
      source: input.source,
      offer_id: input.offerId,
      landing_page_id: input.landingPageId,
      page_ref: input.pageRef ? input.pageRef.slice(0, 500) : null,
      item_kind: item.kind,
      item_id: item.id,
      item_name: item.name,
      amount: item.unitAmount / 100,
      currency: item.currency,
      mode,
      stripe_account_id: accountId,
      stripe_checkout_session_id: session.id,
      checkout_url: session.url,
      status: 'pending',
      created_at: now,
      updated_at: now,
    })
    .onConflict('id')
    .ignore()

  return { status: 200, body: { ok: true, url: session.url } }
}

function bodyOf(raw: unknown): Record<string, unknown> {
  return (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>
}

function isBot(body: Record<string, unknown>): boolean {
  return Boolean(body._hp || body.company_website || body.honeypot)
}

function buyerOf(body: Record<string, unknown>, item: CheckoutItem): { email: string | null; name: string } | CheckoutResult {
  const email = normalizeBuyerEmail(body.email)
  if (body.email && !email) return fail(400, 'Please enter a valid email address')
  if (item.kind === 'course' && !email) return fail(400, 'Please enter your email address')
  return { email, name: cleanText(body.name, 200) }
}

// ---------------------------------------------------------------------------
// Entry point 1: an offer.
// ---------------------------------------------------------------------------

export type OfferRow = {
  id: string
  organization_id: string
  tenant_id: string
  product_id: string | null
  course_id: string | null
  mode: string
  success_url_hosts: string[] | string | null
  allowed_upsell_offer_ids?: string[] | string | null
  active: boolean
}

function pgArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String)
  if (typeof value === 'string' && value.startsWith('{') && value.endsWith('}')) {
    const inner = value.slice(1, -1)
    return inner ? inner.split(',').map((v) => v.replace(/^"|"$/g, '')) : []
  }
  return []
}

export function offerHosts(offer: Pick<OfferRow, 'success_url_hosts'>): string[] {
  return pgArray(offer.success_url_hosts).map((h) => h.toLowerCase())
}

export function offerUpsellIds(offer: Pick<OfferRow, 'allowed_upsell_offer_ids'>): string[] {
  return pgArray(offer.allowed_upsell_offer_ids)
}

export async function loadOfferItem(knex: Knex, offer: OfferRow): Promise<CheckoutItem | null> {
  if (offer.product_id && offer.course_id) return null
  if (offer.course_id) return loadItem(knex, offer, 'course', offer.course_id)
  if (offer.product_id) return loadItem(knex, offer, 'product', offer.product_id)
  return null
}

export async function createOfferCheckout(
  deps: CheckoutDeps,
  req: { offerId: string; ip: string; body: unknown },
): Promise<CheckoutResult> {
  const { knex } = deps
  const body = bodyOf(req.body)
  if (isBot(body)) return fail(400, 'Checkout unavailable')
  if (!isUuid(req.offerId)) return fail(404, 'Offer not found')

  if (perIpTargetLimiter.hit(`${req.ip}:offer:${req.offerId}`) || perTargetLimiter.hit(`offer:${req.offerId}`)) {
    return fail(429, 'Too many checkout attempts. Please wait a few minutes and try again.')
  }

  const offer: OfferRow | undefined = await knex('checkout_offers').where('id', req.offerId).first()
  if (!offer) return fail(404, 'Offer not found')
  if (!offer.active) return fail(400, NOT_SET_UP_MESSAGE)

  // The buyer is sent back only to a page host the offer allows.
  const returnUrl = allowedReturnUrl(body.returnUrl, offerHosts(offer))
  if (!returnUrl) return fail(400, BAD_RETURN_URL_MESSAGE)
  const cancelUrl = body.cancelUrl === undefined ? null : allowedReturnUrl(body.cancelUrl, offerHosts(offer))
  if (body.cancelUrl !== undefined && !cancelUrl) return fail(400, BAD_RETURN_URL_MESSAGE)

  const item = await loadOfferItem(knex, offer)
  if (!item) return fail(400, NOT_SET_UP_MESSAGE)
  if (offer.mode !== itemMode(item)) {
    console.warn('[payments.public-checkout] offer mode does not match its product', offer.id, offer.mode, itemMode(item))
    return fail(400, NOT_SET_UP_MESSAGE)
  }

  const buyer = buyerOf(body, item)
  if ('status' in buyer) return buyer
  const pageRef = cleanText(body.pageRef, 500) || null

  return startSession(deps, {
    owner: offer,
    item,
    source: 'offer',
    target: offer.id,
    offerId: offer.id,
    landingPageId: null,
    pageRef,
    email: buyer.email,
    name: buyer.name,
    requestId: body.requestId,
    successUrl: withQuery(returnUrl, 'checkout_session_id', '{CHECKOUT_SESSION_ID}'),
    cancelUrl: cancelUrl ? cancelUrl.toString() : withQuery(returnUrl, 'checkout', 'cancelled'),
    metadata: {},
  })
}

// ---------------------------------------------------------------------------
// Entry point 2 (transition): a CRM wizard landing page.
// ---------------------------------------------------------------------------

type PageRow = { id: string; slug: string; organization_id: string; tenant_id: string; config?: unknown }

export function configuredItemRef(page: PageRow): string | null {
  let config: any = page.config
  if (typeof config === 'string') {
    try { config = JSON.parse(config) } catch { config = null }
  }
  const ref = config && typeof config === 'object' ? config.productId : null
  return typeof ref === 'string' && ref.trim() ? ref.trim() : null
}

export function publicPageUrl(appUrl: string, slug: string): string {
  return `${appUrl}/api/landing_pages/public/${encodeURIComponent(slug)}`
}

export async function createLandingPageCheckout(
  deps: CheckoutDeps,
  req: { slug: string; ip: string; body: unknown },
): Promise<CheckoutResult> {
  const { knex } = deps
  const body = bodyOf(req.body)
  if (isBot(body)) return fail(400, 'Checkout unavailable')

  if (perIpTargetLimiter.hit(`${req.ip}:page:${req.slug}`) || perTargetLimiter.hit(`page:${req.slug}`)) {
    return fail(429, 'Too many checkout attempts. Please wait a few minutes and try again.')
  }

  const page: PageRow | undefined = await knex('landing_pages')
    .where('slug', req.slug)
    .where('status', 'published')
    .whereNull('deleted_at')
    .first()
  if (!page) return fail(404, 'Page not found')

  // "<uuid>" (product) or "course:<uuid>", from the page's saved config.
  const ref = configuredItemRef(page)
  if (!ref) return fail(400, NOT_SET_UP_MESSAGE)
  // The request may name the product (published pages send the id baked into
  // them), but it only ever selects; it must be the page's configured one.
  const requested = typeof body.productId === 'string' ? body.productId.trim() : ''
  if (requested && requested !== ref) return fail(400, WRONG_PRODUCT_MESSAGE)

  const item = ref.startsWith('course:')
    ? await loadItem(knex, page, 'course', ref.slice('course:'.length))
    : await loadItem(knex, page, 'product', ref)
  if (!item) return fail(400, NOT_SET_UP_MESSAGE)

  const buyer = buyerOf(body, item)
  if ('status' in buyer) return buyer

  const pageUrl = publicPageUrl(deps.appUrl, page.slug)
  return startSession(deps, {
    owner: page,
    item,
    source: 'landing_page',
    target: page.id,
    offerId: null,
    landingPageId: page.id,
    pageRef: page.slug,
    email: buyer.email,
    name: buyer.name,
    requestId: body.requestId,
    successUrl: `${pageUrl}/thank-you?session_id={CHECKOUT_SESSION_ID}`,
    cancelUrl: `${pageUrl}?checkout=cancelled`,
    metadata: { landingPageId: page.id, landingPageSlug: page.slug },
  })
}

// ---------------------------------------------------------------------------
// Webhook side: claim, complete, release.
// ---------------------------------------------------------------------------

export type ClaimVerdict =
  | { kind: 'claimed'; row: Record<string, any> }
  | { kind: 'duplicate'; row: Record<string, any> }
  | { kind: 'busy' }
  | { kind: 'reject'; reason: string }

/** A claim older than this is presumed dead (crashed delivery) and may be re-taken. */
export const CLAIM_STALE_MS = 5 * 60 * 1000

/**
 * Claim a checkout for recording a paid Stripe session. Only one delivery
 * wins; the event must come from the connected account the session was
 * created on, for the organization that owns the offer or page.
 */
export async function claimLandingPageCheckout(
  knex: Knex,
  input: { checkoutId: unknown; sessionId: string; connectedAccountId: string | null; metaOrgId: string | null },
  now: () => Date = () => new Date(),
): Promise<ClaimVerdict> {
  if (!isUuid(input.checkoutId)) return { kind: 'reject', reason: 'invalid checkout id' }
  const row = await knex('landing_page_checkouts').where('id', input.checkoutId).first()
  if (!row) return { kind: 'reject', reason: 'unknown checkout' }
  if (row.stripe_checkout_session_id !== input.sessionId) return { kind: 'reject', reason: 'session mismatch' }
  if (!input.connectedAccountId || input.connectedAccountId !== row.stripe_account_id) {
    return { kind: 'reject', reason: 'event is not from the business account the session was created on' }
  }
  if (input.metaOrgId && input.metaOrgId !== row.organization_id) return { kind: 'reject', reason: 'organization mismatch' }
  if (row.status === 'paid') return { kind: 'duplicate', row }

  const at = now()
  const staleBefore = new Date(at.getTime() - CLAIM_STALE_MS)
  const updated = await knex('landing_page_checkouts')
    .where('id', row.id)
    .where(function claimable(this: Knex.QueryBuilder) {
      this.where('status', 'pending').orWhere(function stale(this: Knex.QueryBuilder) {
        this.where('status', 'processing').where('claimed_at', '<', staleBefore)
      })
    })
    .update({ status: 'processing', claimed_at: at, updated_at: at })
  if (Number(updated) === 1) return { kind: 'claimed', row: { ...row, status: 'processing', claimed_at: at } }

  const again = await knex('landing_page_checkouts').where('id', row.id).first()
  if (again?.status === 'paid') return { kind: 'duplicate', row: again }
  return { kind: 'busy' }
}

export async function completeLandingPageCheckout(
  knex: Knex,
  checkoutId: string,
  result: { paymentRecordId: string | null; contactId: string | null },
): Promise<void> {
  const at = new Date()
  await knex('landing_page_checkouts')
    .where('id', checkoutId)
    .whereIn('status', ['pending', 'processing'])
    .update({
      status: 'paid',
      paid_at: at,
      updated_at: at,
      payment_record_id: result.paymentRecordId,
      contact_id: result.contactId,
    })
}

/** Hand a failed delivery's claim back so Stripe's retry can take it. */
export async function releaseLandingPageCheckout(knex: Knex, checkoutId: string): Promise<void> {
  await knex('landing_page_checkouts')
    .where('id', checkoutId)
    .where('status', 'processing')
    .update({ status: 'pending', claimed_at: null, updated_at: new Date() })
}
