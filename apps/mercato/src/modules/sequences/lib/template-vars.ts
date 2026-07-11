/* eslint-disable @typescript-eslint/no-explicit-any */
import { randomUUID } from 'crypto'

/**
 * Template variable substitution for automation + reputation emails.
 *
 * The seeded automation templates (src/lib/automation-templates.ts) use variables
 * like {{sender.review_url}}, {{sender.first_name}}, {{entity.customer_name}} that
 * the send paths historically never substituted (only {{firstName}} / {{reference}}),
 * so customers received literal template text. Every automation email send must go
 * through substituteTemplateVars() with a context built by buildSenderContext().
 *
 * Rules:
 * - Known variables are substituted from the context (with sensible fallbacks).
 * - ANY remaining {{...}} token is stripped to '' — we never send literal braces.
 * - Review-request emails (body references {{sender.review_url}}) must be SKIPPED
 *   by the caller when no review link is configured; use requiresReviewUrl() to
 *   detect them before substitution. A review request without a link is pointless.
 */

export type TemplateContactVars = {
  first_name?: string | null
  last_name?: string | null
  full_name?: string | null
  email?: string | null
}

export type TemplateSenderVars = {
  first_name?: string | null
  business_name?: string | null
  review_url?: string | null
  review_platform?: string | null
  booking_url?: string | null
}

export type TemplateVarContext = {
  contact?: TemplateContactVars
  sender?: TemplateSenderVars
  /** Passthrough for scheduled automations ({{reference}} = invoice number, deal title, ...) */
  reference?: string | null
  /** When true, substituted values are HTML-escaped (contact names come from
   * public forms/kiosk/inbound mail and land in an HTML email body). */
  html?: boolean
}

function htmlEscape(v: string): string {
  return v
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;')
}

const REVIEW_URL_TOKEN = /\{\{\s*sender\.review_url\s*\}\}/

/** True when any of the given texts references {{sender.review_url}} (pre-substitution). */
export function requiresReviewUrl(...texts: Array<string | null | undefined>): boolean {
  return texts.some((t) => typeof t === 'string' && REVIEW_URL_TOKEN.test(t))
}

/**
 * Substitute all known {{...}} variables and strip any unknown ones.
 */
export function substituteTemplateVars(text: string, ctx: TemplateVarContext): string {
  if (!text) return ''
  const contact = ctx.contact || {}
  const sender = ctx.sender || {}

  const fullName = (contact.full_name || '').trim()
  const firstName = (contact.first_name || '').trim() || fullName.split(/\s+/)[0] || 'there'
  const senderFirst = (sender.first_name || '').trim() || (sender.business_name || '').trim()

  const values: Record<string, string> = {
    'firstName': firstName,
    'contact.first_name': firstName,
    'contact.last_name': (contact.last_name || '').trim(),
    'contact.full_name': fullName || firstName,
    'contact.email': (contact.email || '').trim(),
    'entity.first_name': firstName,
    'entity.customer_name': fullName || firstName,
    'entity.contact_name': fullName || firstName,
    'entity.name': fullName || firstName,
    'sender.first_name': senderFirst,
    'sender.business_name': (sender.business_name || '').trim(),
    'sender.review_url': (sender.review_url || '').trim(),
    'sender.booking_url': (sender.booking_url || '').trim(),
    'reference': (ctx.reference || '').trim(),
  }

  // One pass: known keys substituted, everything else (including {{now-90d}}-style
  // condition placeholders that leak into copy) stripped to ''. When emitting
  // HTML, escape the substituted value so a contact-supplied name like
  // "<img onerror=...>" can't inject markup into the email.
  const esc = ctx.html ? htmlEscape : (x: string) => x
  return text.replace(/\{\{([^{}]*)\}\}/g, (_m, rawKey) => {
    const key = String(rawKey).trim()
    return Object.prototype.hasOwnProperty.call(values, key) ? esc(values[key]) : ''
  })
}

/**
 * Template bodies are authored as plain text with \n line breaks but are sent as
 * htmlBody. If the body contains no HTML tags, convert newlines to <br> so the
 * email does not render as one long line. Bodies that already contain markup are
 * passed through untouched.
 */
export function htmlifyIfPlainText(body: string): string {
  if (!body) return body
  if (/<[a-z][^>]*>/i.test(body)) return body
  return body.replace(/\r?\n/g, '<br>')
}

// ---------------------------------------------------------------------------
// Sender context (business_profiles + first org user + booking page)
// ---------------------------------------------------------------------------

const SENDER_CACHE_TTL_MS = 60_000
const senderCache = new Map<string, { ctx: TemplateSenderVars; expires: number }>()

/**
 * Build the {{sender.*}} context for an organization.
 *
 * - business_name / review_url / review_platform come from business_profiles
 *   (review columns are added by scripts/sql/reputation.sql; reads are resilient
 *   to the columns not existing yet).
 * - first_name is the org's first (oldest) user's first name, falling back to the
 *   business name when no user name is available.
 * - booking_url points at the org's first active calendar booking page, if any.
 *
 * Results are cached for 60s per org (scheduled runs can send to 100 targets in a
 * loop). Pass { fresh: true } to bypass the cache (e.g. right after settings save).
 */
export async function buildSenderContext(
  knex: any,
  orgId: string,
  opts?: { fresh?: boolean },
): Promise<TemplateSenderVars> {
  if (!opts?.fresh) {
    const cached = senderCache.get(orgId)
    if (cached && cached.expires > Date.now()) return cached.ctx
  }

  const ctx: TemplateSenderVars = {}

  try {
    // select('*') on purpose: selecting review_url explicitly would throw before
    // scripts/sql/reputation.sql has been applied.
    const bp = await knex('business_profiles').where('organization_id', orgId).first()
    if (bp) {
      ctx.business_name = bp.business_name || null
      ctx.review_url = (bp as any).review_url || null
      ctx.review_platform = (bp as any).review_platform || null
    }
  } catch {
    // No business profile — sender vars stay empty and get stripped.
  }

  try {
    const owner = await knex('users')
      .where('organization_id', orgId)
      .whereNull('deleted_at')
      .orderBy('created_at', 'asc')
      .first()
    const ownerFirst = String(owner?.name || '').trim().split(/\s+/)[0]
    ctx.first_name = ownerFirst || ctx.business_name || null
  } catch {
    ctx.first_name = ctx.business_name || null
  }

  try {
    const bookingPage = await knex('booking_pages')
      .where('organization_id', orgId)
      .where('is_active', true)
      .orderBy('created_at', 'asc')
      .first()
    if (bookingPage?.slug) {
      const baseUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
      ctx.booking_url = `${baseUrl}/api/calendar/book/${bookingPage.slug}`
    }
  } catch {
    // Calendar module tables absent — booking_url stays undefined and gets stripped.
  }

  senderCache.set(orgId, { ctx, expires: Date.now() + SENDER_CACHE_TTL_MS })
  return ctx
}

// ---------------------------------------------------------------------------
// Review request logging
// ---------------------------------------------------------------------------

/**
 * Record that a review-request email went out (feeds the Reputation page stats).
 * Never throws: if scripts/sql/reputation.sql has not been applied yet we log and
 * carry on — the email itself already sent.
 */
export async function recordReviewRequest(
  knex: any,
  args: {
    organizationId: string
    tenantId: string
    contactId: string
    ruleId?: string | null
    channel?: string
  },
): Promise<void> {
  try {
    await knex('review_requests').insert({
      id: randomUUID(),
      tenant_id: args.tenantId,
      organization_id: args.organizationId,
      contact_id: args.contactId,
      channel: args.channel || 'email',
      status: 'sent',
      rule_id: args.ruleId || null,
      sent_at: new Date(),
    })
  } catch (err) {
    console.error('[reputation] Failed to record review request (is scripts/sql/reputation.sql applied?):', err)
  }
}
