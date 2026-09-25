import { randomUUID } from 'crypto'
import type { Knex } from 'knex'
import { lintFairHousing } from '../../../lib/fair-housing'

/*
 * Assisted replies: the Customer Service reply mode that sends some replies on
 * its own and drafts everything else.
 *
 * Off by default (reply_mode 'draft'). When the owner picks Assisted, a drafted
 * reply goes out without review only if EVERY gate passes:
 *   1. the channel (email, or SMS on the dedicated support number) is on;
 *   2. the message is one of the inquiry types the owner turned on, and no
 *      other inquiry type the owner reviews themselves;
 *   3. the drafter says it is safe and at least minConfidence sure, and the
 *      independent critic agreed (criticGate);
 *   4. no flag scenario matched and the sender is not in a review-first audience;
 *   5. the content screen is clean: no prices, fees, discounts or guarantees,
 *      no legal or financial/tax advice, and the shared Fair Housing screen
 *      (src/lib/fair-housing.ts) passes on both the message and the reply;
 *   6. it is inside the owner's send hours (their timezone and days);
 *   7. this contact has had fewer than perContactDailyLimit automatic replies
 *      in the last 24 hours.
 * Anything that fails a gate stays a draft in the review queue, with the
 * reasons attached. The route adds the existing rails on top: the pause
 * switch, the hourly cap and the hold window.
 *
 * The Fair Housing screen runs for every org, not only real-estate ones: the
 * CRM has no reliable real-estate flag, and its rules are narrow enough for
 * ordinary business mail (same call as integrations_api/lib/reactivation.ts).
 */

export const ASSISTED_MODE = 'assisted' as const
export type AssistedChannel = 'email' | 'sms'

export type AssistedInquiryType = { key: string; label: string; description: string }

/** The inquiry types an owner can let Assisted answer. Keys are stored; labels are shown. */
export const ASSISTED_INQUIRY_TYPES: readonly AssistedInquiryType[] = [
  { key: 'showing_request', label: 'Showing and tour requests', description: 'The customer wants to see a home or property, or to book a showing, tour, or open-house visit' },
  { key: 'listing_availability', label: 'Is it still available?', description: 'The customer asks whether a listing, home, or service is still available' },
  { key: 'property_details', label: 'Property details', description: 'The customer asks about a specific listing: bedrooms, bathrooms, size, features, parking, HOA, or nearby amenities' },
  { key: 'appointment_request', label: 'Call and meeting requests', description: 'The customer wants to book a call, meeting, consultation, or appointment' },
  { key: 'business_info', label: 'Hours, location and contact details', description: 'The customer asks about business hours, office location, service area, or how to reach the business' },
  { key: 'services_question', label: 'How you work', description: 'The customer asks what services the business offers or how its process works' },
]

const INQUIRY_KEYS = new Set(ASSISTED_INQUIRY_TYPES.map((t) => t.key))
export const INQUIRY_SCENARIO_PREFIX = 'inquiry_'

export type AssistedSendWindow = { start: string; end: string; timezone: string; days: number[] }

export type AssistedConfig = {
  channels: { email: boolean; sms: boolean }
  inquiryTypes: string[]
  minConfidence: number
  sendWindow: AssistedSendWindow
  perContactDailyLimit: number
}

export const DEFAULT_ASSISTED_TIMEZONE = 'America/Los_Angeles'

export const DEFAULT_ASSISTED_CONFIG: AssistedConfig = {
  channels: { email: false, sms: false },
  inquiryTypes: [],
  minConfidence: 0.85,
  sendWindow: { start: '08:00', end: '20:00', timezone: DEFAULT_ASSISTED_TIMEZONE, days: [0, 1, 2, 3, 4, 5, 6] },
  perContactDailyLimit: 2,
}

export type AssistedReason = { key: string; label: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

function parseJson(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

function normalizeTime(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim())
  if (!match) return fallback
  const hours = Number(match[1])
  const minutes = Number(match[2])
  if (hours > 23 || minutes > 59) return fallback
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value.trim() })
    return true
  } catch {
    return false
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = Number(value)
  if (value === null || value === undefined || value === '' || !Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * The stored (or submitted) Assisted settings, cleaned. Missing or invalid
 * fields fall back to `base`, so a partial update keeps what was saved.
 */
export function normalizeAssistedConfig(raw: unknown, base: AssistedConfig = DEFAULT_ASSISTED_CONFIG): AssistedConfig {
  const input = parseJson(raw)
  if (!isRecord(input)) return { ...base, channels: { ...base.channels }, inquiryTypes: [...base.inquiryTypes], sendWindow: { ...base.sendWindow, days: [...base.sendWindow.days] } }
  const channelsIn = isRecord(input.channels) ? input.channels : {}
  const windowIn = isRecord(input.sendWindow) ? input.sendWindow : {}
  const inquiryTypes = Array.isArray(input.inquiryTypes)
    ? Array.from(new Set(input.inquiryTypes.filter((k): k is string => typeof k === 'string' && INQUIRY_KEYS.has(k))))
    : [...base.inquiryTypes]
  const days = Array.isArray(windowIn.days)
    ? Array.from(new Set(windowIn.days.map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6))).sort()
    : [...base.sendWindow.days]
  return {
    channels: {
      email: typeof channelsIn.email === 'boolean' ? channelsIn.email : base.channels.email,
      sms: typeof channelsIn.sms === 'boolean' ? channelsIn.sms : base.channels.sms,
    },
    inquiryTypes,
    minConfidence: clamp(input.minConfidence, 0.5, 1, base.minConfidence),
    sendWindow: {
      start: normalizeTime(windowIn.start, base.sendWindow.start),
      end: normalizeTime(windowIn.end, base.sendWindow.end),
      timezone: isValidTimeZone(windowIn.timezone) ? String(windowIn.timezone).trim() : base.sendWindow.timezone,
      days,
    },
    perContactDailyLimit: Math.round(clamp(input.perContactDailyLimit, 1, 10, base.perContactDailyLimit)),
  }
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function localClock(now: Date, timeZone: string): { minutes: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now)
  const read = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  const hours = Number(read('hour')) % 24
  return { minutes: hours * 60 + Number(read('minute')), weekday: WEEKDAYS[read('weekday')] ?? 0 }
}

function toMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return (h ?? 0) * 60 + (m ?? 0)
}

/**
 * Inside the owner's send hours? Uses the owner's timezone and days. A window
 * whose end is before its start runs overnight (20:00 to 07:00); equal start
 * and end means all day.
 */
export function isWithinSendWindow(window: AssistedSendWindow, now: Date): boolean {
  const timeZone = isValidTimeZone(window.timezone) ? window.timezone : DEFAULT_ASSISTED_TIMEZONE
  const { minutes, weekday } = localClock(now, timeZone)
  const start = toMinutes(window.start)
  const end = toMinutes(window.end)
  if (start === end) return window.days.includes(weekday)
  if (start < end) return window.days.includes(weekday) && minutes >= start && minutes < end
  if (minutes >= start) return window.days.includes(weekday)
  return minutes < end && window.days.includes((weekday + 6) % 7)
}

const PRICE_IN_REPLY: RegExp[] = [
  /[$€£]\s?\d/,
  /\b\d[\d,.]*\s?(?:k|m)?\s?(?:dollars|usd|bucks)\b/i,
  /\b\d+(?:\.\d+)?\s?%/,
  /\b(?:price[ds]?|pricing|fees?|costs?|commissions?|discount(?:s|ed)?|coupons?|rebates?|promo(?:tion(?:al)?)?\s+codes?|price\s+match|cash\s+back|refund(?:s|ed|able)?|waive[ds]?|guarantee[ds]?|closing\s+cost\s+credits?|credit\s+toward)\b/i,
  /\bfree\s+(?:consultation|estimate|valuation|home\s+valuation|appraisal|staging|service|trial|of\s+charge|of\s+cost)\b/i,
  /\b(?:no\s+(?:extra\s+)?charge|at\s+no\s+(?:extra\s+)?cost)\b/i,
]

const PRICE_IN_MESSAGE =
  /\b(?:how\s+much|price[ds]?|pricing|costs?|fees?|commissions?|discounts?|cheaper|negotiat\w*|lower\s+(?:the\s+)?price|best\s+price|make\s+an\s+offer|(?:submit|put\s+in|write)\s+an?\s+offer|offer\s+price|asking\s+price|budget)\b/i

const LEGAL =
  /\b(?:legal(?:ly)?|lawyer|attorneys?|law\s?suits?|sue|suing|litigat\w*|liab(?:le|ility)|breach|contract\s+(?:terms?|clauses?|disputes?|law)|liens?|probate|evict(?:ion|ed)?|power\s+of\s+attorney|title\s+(?:issues?|defects?|disputes?)|disclosure\s+(?:laws?|requirements?)|zoning\s+(?:laws?|variances?|violations?)|easements?|subpoena|discriminat\w*)\b/i

const FINANCIAL =
  /\b(?:financial\s+advice|investment\s+advice|(?:good|great|smart|bad|safe|solid)\s+investment|roi|return\s+on\s+(?:investment|equity)|appreciat(?:e|es|ion)\s+in\s+value|(?:go|goes|going)\s+up\s+in\s+value|increase\s+in\s+value|tax(?:es)?\s+(?:advice|deduct\w*|implications?|benefits?|breaks?|credits?|write[- ]?offs?)|tax[- ](?:free|deductible|advantaged?)|capital\s+gains?|1031|write[- ]?offs?|deductible|mortgage\s+(?:rates?|advice|payments?|pre-?approvals?)|interest\s+rates?|refinanc\w*|pre-?approv\w*|pre-?qualif\w*|credit\s+scores?|down\s+payments?|loans?|lenders?|afford\w*|net\s+worth|401\s?\(?k\)?)\b/i

const QUESTION_START = /^(?:can|could|should|would|what|what's|whats|how|is|are|do|does|did|will|when|where|which|who|why|any|may|might)\b/i

/**
 * The customer's questions: sentences that end in "?" or open like one. A
 * buyer who says "we're pre-approved" is not asking for advice; one who asks
 * "what would my payment be?" is.
 */
function questionsIn(text: string): string {
  const sentences = text.match(/[^.!?\n]+[.!?]*/g) ?? []
  return sentences.filter((s) => s.includes('?') || QUESTION_START.test(s.trim())).join('\n')
}

/**
 * The content gate: what a human should answer. The reply is screened whole;
 * the customer's message only for what they ask. Returns one reason per
 * problem found; empty means clean.
 */
export function screenAssistedContent(args: { inbound: string; draft: string; recipientName?: string | null }): AssistedReason[] {
  const inbound = String(args.inbound ?? '')
  const asked = questionsIn(inbound)
  const draft = String(args.draft ?? '')
  const reasons: AssistedReason[] = []
  if (PRICE_IN_REPLY.some((re) => re.test(draft)) || PRICE_IN_MESSAGE.test(asked)) {
    reasons.push({ key: 'pricing', label: 'Mentions prices, fees, discounts or guarantees' })
  }
  if (LEGAL.test(draft) || LEGAL.test(asked)) {
    reasons.push({ key: 'legal', label: 'Legal question or legal advice' })
  }
  if (FINANCIAL.test(draft) || FINANCIAL.test(asked)) {
    reasons.push({ key: 'financial', label: 'Financial, loan or tax question' })
  }
  const ignoreNames = [args.recipientName]
  const fairHousing = [...lintFairHousing(draft, { ignoreNames }).findings, ...lintFairHousing(inbound, { ignoreNames }).findings]
  if (fairHousing.length) {
    const terms = Array.from(new Set(fairHousing.map((f) => `"${f.term}"`))).join(', ')
    reasons.push({ key: 'fair_housing', label: `Fair Housing review needed: ${terms}` })
  }
  return reasons
}

/** Inquiry types as drafter scenarios, so the one drafting call also classifies the message. */
export function inquiryScenarioInputs(): Array<{ key: string; label: string; instructions: string }> {
  return ASSISTED_INQUIRY_TYPES.map((t) => ({ key: `${INQUIRY_SCENARIO_PREFIX}${t.key}`, label: t.description, instructions: '' }))
}

/** Separate the drafter's matches into flag scenarios and inquiry types (without the prefix). */
export function splitMatchedScenarios(matched: readonly string[] | null | undefined): { flags: string[]; inquiryTypes: string[] } {
  const flags: string[] = []
  const inquiryTypes: string[] = []
  for (const key of matched ?? []) {
    if (key.startsWith(INQUIRY_SCENARIO_PREFIX)) {
      const type = key.slice(INQUIRY_SCENARIO_PREFIX.length)
      if (INQUIRY_KEYS.has(type)) inquiryTypes.push(type)
    } else {
      flags.push(key)
    }
  }
  return { flags, inquiryTypes }
}

export function inquiryTypeLabel(key: string): string {
  return ASSISTED_INQUIRY_TYPES.find((t) => t.key === key)?.label ?? key
}

export type AssistedDecisionInput = {
  channel: AssistedChannel
  config: AssistedConfig
  draft: { confidence: number; autoSendSafe: boolean }
  inquiryTypes: string[]
  flagged: boolean
  audienceAction: string | null | undefined
  contentReasons: AssistedReason[]
  now: Date
  recentAutoRepliesToContact: number
}

export type AssistedDecision = { send: boolean; reasons: AssistedReason[] }

/** Every gate, in one place. `send` is true only when no reason was found. */
export function decideAssistedSend(input: AssistedDecisionInput): AssistedDecision {
  const { config } = input
  const reasons: AssistedReason[] = []
  if (!config.channels[input.channel]) {
    reasons.push({ key: 'channel_off', label: input.channel === 'sms' ? 'Automatic texts are off' : 'Automatic emails are off' })
  }
  const enabled = new Set(config.inquiryTypes)
  if (input.inquiryTypes.length === 0) {
    reasons.push({ key: 'inquiry_type', label: 'Not one of the inquiry types you chose to auto-send' })
  } else {
    const reviewed = input.inquiryTypes.filter((t) => !enabled.has(t))
    if (reviewed.length) {
      reasons.push({ key: 'inquiry_type', label: `Includes a question you review yourself: ${reviewed.map(inquiryTypeLabel).join(', ')}` })
    }
  }
  if (!input.draft.autoSendSafe) {
    reasons.push({ key: 'not_safe', label: 'Noli judged this reply needs a person' })
  }
  if (!(input.draft.confidence >= config.minConfidence)) {
    reasons.push({ key: 'low_confidence', label: 'Noli was not confident enough to send it alone' })
  }
  if (input.flagged) reasons.push({ key: 'flagged', label: 'Matched one of your flag scenarios' })
  if (input.audienceAction === 'pause') reasons.push({ key: 'audience_pause', label: 'From a review-first audience' })
  reasons.push(...input.contentReasons)
  if (!isWithinSendWindow(config.sendWindow, input.now)) {
    reasons.push({ key: 'quiet_hours', label: 'Outside your send hours' })
  }
  if (input.recentAutoRepliesToContact >= config.perContactDailyLimit) {
    reasons.push({ key: 'contact_limit', label: `Already sent ${input.recentAutoRepliesToContact} automatic ${input.recentAutoRepliesToContact === 1 ? 'reply' : 'replies'} to this contact today` })
  }
  return { send: reasons.length === 0, reasons }
}

/**
 * Automatic replies to one contact in the window: ones already sent and ones
 * scheduled to send (held auto-sends), across every Customer Service mode, so
 * Assisted never adds to a contact another mode just answered.
 */
export async function countRecentAutoReplies(
  knex: Knex,
  scope: { organizationId: string; tenantId: string },
  recipient: { contactId?: string | null; to?: string | null },
  since: Date,
): Promise<number> {
  const contactId = recipient.contactId || null
  const to = recipient.to || null
  if (!contactId && !to) return 0
  const row = await knex('inbox_proposal_actions')
    .where('organization_id', scope.organizationId)
    .where('tenant_id', scope.tenantId)
    .whereRaw("metadata->>'feature_source' = 'customer_service'")
    .where('created_at', '>=', since)
    .where(function (this: Knex.QueryBuilder) {
      this.where(function (this: Knex.QueryBuilder) {
        this.where('status', 'sent').whereRaw("metadata->>'auto_sent' = 'true'")
      }).orWhere(function (this: Knex.QueryBuilder) {
        this.whereIn('status', ['pending', 'sending']).whereRaw("metadata->>'auto_scheduled' = 'true'")
      })
    })
    .whereRaw(contactId ? "payload->>'contactId' = ?" : "payload->>'to' = ?", [contactId ?? to])
    .count('* as c')
    .first()
  return Number((row as { c?: unknown } | undefined)?.c ?? 0)
}

/**
 * The activity-log line for one automatic reply, on the contact's timeline.
 * customer_activities.subject/body are encrypted at rest and this is a raw
 * insert, so the row is encrypted first; a failure skips the log line and
 * never writes plaintext.
 */
export async function logAssistedActivity(
  knex: Knex,
  args: {
    organizationId: string
    tenantId: string
    contactId: string | null
    channel: AssistedChannel
    inquiryTypes: string[]
    subject: string | null
    body: string
    em?: unknown
  },
): Promise<boolean> {
  if (!args.contactId) return false
  try {
    const { encryptRowForRawWrite } = await import('@open-mercato/shared/lib/encryption/rawWrite')
    const now = new Date()
    const kinds = args.inquiryTypes.map(inquiryTypeLabel).join(', ') || 'Inquiry'
    const channelLabel = args.channel === 'sms' ? 'text' : 'email'
    const row = await encryptRowForRawWrite('customers:customer_activity', {
      id: randomUUID(),
      tenant_id: args.tenantId,
      organization_id: args.organizationId,
      entity_id: args.contactId,
      activity_type: 'auto_reply',
      subject: `Assisted reply sent by ${channelLabel} (${kinds})`,
      body: `${args.subject ? `Subject: ${args.subject}\n\n` : ''}${args.body}`.slice(0, 8000),
      occurred_at: now,
      created_at: now,
      updated_at: now,
    }, args.tenantId, args.organizationId, args.em)
    await knex('customer_activities').insert(row)
    return true
  } catch (err) {
    console.error('[assisted-send] activity log skipped', { organizationId: args.organizationId, err })
    return false
  }
}
