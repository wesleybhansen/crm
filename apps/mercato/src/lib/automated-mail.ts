/**
 * Shared automated / no-reply / bulk mail detection.
 *
 * Used by the Customer Service processor to AVOID drafting replies to mail that
 * no human should be answered: noreply senders, mailer-daemon bounces, list /
 * bulk / newsletter mail, and auto-submitted messages.
 *
 * Design note: this is intentionally CONSERVATIVE. A normal human reply must
 * never be skipped. So unlike the personal Inbox Intelligence filter (which also
 * drops generic role addresses like info@/support@/hello@ because it only wants
 * to score real people), this helper does NOT treat role addresses as automated.
 * A support inbox legitimately receives human replies from support@/info@/etc.
 * We only flag senders that are structurally non-repliable (noreply, daemon,
 * bounce) plus header / subject signals that reliably indicate bulk or
 * machine-generated mail.
 */

// From-address local-parts that are structurally non-repliable. Kept tight on
// purpose: only addresses where a reply is meaningless or undeliverable.
const NOREPLY_LOCALPART_PATTERNS = [
  'noreply',
  'no-reply',
  'no_reply',
  'donotreply',
  'do-not-reply',
  'do_not_reply',
  'mailer-daemon',
  'mailerdaemon',
  'postmaster',
  'bounce',
  'bounces',
]

// Local-parts that are very strongly automated-only when they appear as the
// WHOLE local-part (exact match, not substring) so we don't catch e.g. a person
// named "newsom" or a real "newsdesk@" editor. These are list/blast senders.
const NOREPLY_LOCALPART_EXACT = [
  'newsletter',
  'newsletters',
  'notifications',
  'notification',
  'digest',
]

/**
 * ESP "envelope"/blast subdomains, e.g. @e.brand.com, @email.brand.com. Kept to
 * unambiguous blast prefixes only. Deliberately EXCLUDES generic prefixes like
 * `mail`/`reply` because real people legitimately send from mail.company.com, and
 * a human reply must never be skipped.
 */
const BULK_SUBDOMAIN_PREFIXES = ['e', 'email', 'mailer', 'newsletter', 'notifications', 'noreply', 'no-reply', 'bounce']

export interface AutomatedMailInput {
  fromAddress?: string | null
  subject?: string | null
  /**
   * Raw inbound headers if captured at ingest time, e.g.
   * { 'precedence': 'bulk', 'auto-submitted': 'auto-generated',
   *   'list-unsubscribe': '<...>', 'list-id': '<...>' }.
   * Header names should be lower-cased by the caller; we lower-case defensively.
   */
  headers?: Record<string, string> | null | undefined
}

function lc(s: string | null | undefined): string {
  return (s || '').toString().trim().toLowerCase()
}

function headerVal(headers: Record<string, string> | null | undefined, name: string): string {
  if (!headers) return ''
  // Tolerate either already-lower-cased keys or original-case keys.
  const direct = headers[name]
  if (typeof direct === 'string') return direct.toLowerCase()
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name)
  return key ? (headers[key] || '').toString().toLowerCase() : ''
}

/**
 * True when the message is automated / no-reply / bulk and should NOT receive a
 * drafted human reply. Conservative by design.
 */
export function isAutomatedMail(input: AutomatedMailInput): boolean {
  const from = lc(input.fromAddress)
  // No usable sender: let the caller's own no-recipient guard handle it. We only
  // return true (skip-as-automated) when we have a positive automated signal.
  if (!from || !from.includes('@')) return false

  const local = from.split('@')[0] || ''
  const domain = from.split('@')[1] || ''

  // 1) Structurally non-repliable local-parts (substring match: covers
  //    noreply-marketing@, bounce+123@, mailer-daemon@host, etc.).
  if (NOREPLY_LOCALPART_PATTERNS.some((p) => local.includes(p))) return true

  // 2) Exact blast local-parts (newsletter@, notifications@, digest@).
  if (NOREPLY_LOCALPART_EXACT.includes(local)) return true

  // 3) ESP blast subdomains: @e.brand.com / @email.brand.com / @mailer.brand.com.
  //    Require at least 3 labels so we don't flag a real two-label domain.
  const labels = domain.split('.')
  if (labels.length >= 3 && BULK_SUBDOMAIN_PREFIXES.includes(labels[0])) return true

  // 4) Header signals (only present when ingest captured them).
  const autoSubmitted = headerVal(input.headers, 'auto-submitted')
  if (autoSubmitted && autoSubmitted !== 'no') return true // RFC 3834

  const precedence = headerVal(input.headers, 'precedence')
  if (precedence === 'bulk' || precedence === 'list' || precedence === 'junk') return true

  if (headerVal(input.headers, 'list-unsubscribe')) return true
  if (headerVal(input.headers, 'list-id')) return true
  if (headerVal(input.headers, 'list-post')) return true
  if (headerVal(input.headers, 'feedback-id')) return true // ESP bulk tracking

  return false
}
