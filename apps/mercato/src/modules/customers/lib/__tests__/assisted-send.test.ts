jest.mock('@open-mercato/shared/lib/encryption/rawWrite', () => ({
  encryptRowForRawWrite: jest.fn(async (_entity: string, row: Record<string, unknown>) => ({ ...row, subject: `enc:${row.subject}`, body: `enc:${row.body}` })),
}))

import { createFakeDb } from '../../../../lib/__tests__/support/fake-db'
import {
  ASSISTED_INQUIRY_TYPES,
  DEFAULT_ASSISTED_CONFIG,
  countRecentAutoReplies,
  decideAssistedSend,
  inquiryScenarioInputs,
  isWithinSendWindow,
  logAssistedActivity,
  normalizeAssistedConfig,
  screenAssistedContent,
  splitMatchedScenarios,
  type AssistedConfig,
  type AssistedDecisionInput,
} from '../assisted-send'

const ON: AssistedConfig = normalizeAssistedConfig({
  channels: { email: true, sms: true },
  inquiryTypes: ['showing_request', 'listing_availability'],
  minConfidence: 0.85,
  sendWindow: { start: '08:00', end: '20:00', timezone: 'America/Los_Angeles', days: [0, 1, 2, 3, 4, 5, 6] },
  perContactDailyLimit: 2,
})
// 10:00 in Los Angeles on a Monday.
const MONDAY_10AM_LA = new Date('2026-09-28T17:00:00.000Z')

function input(overrides: Partial<AssistedDecisionInput> = {}): AssistedDecisionInput {
  return {
    channel: 'email',
    config: ON,
    draft: { confidence: 0.93, autoSendSafe: true },
    inquiryTypes: ['showing_request'],
    flagged: false,
    audienceAction: null,
    contentReasons: [],
    now: MONDAY_10AM_LA,
    recentAutoRepliesToContact: 0,
    ...overrides,
  }
}

describe('Assisted defaults', () => {
  it('is off until the owner turns something on', () => {
    const config = normalizeAssistedConfig(null)
    expect(config.channels).toEqual({ email: false, sms: false })
    expect(config.inquiryTypes).toEqual([])
    const decision = decideAssistedSend(input({ config }))
    expect(decision.send).toBe(false)
    expect(decision.reasons.map((r) => r.key)).toEqual(expect.arrayContaining(['channel_off', 'inquiry_type']))
  })

  it('keeps saved values on a partial update and drops junk', () => {
    const merged = normalizeAssistedConfig(
      { inquiryTypes: ['showing_request', 'made_up'], sendWindow: { timezone: 'Not/AZone', start: '25:00' }, minConfidence: 0.1, perContactDailyLimit: 99 },
      ON,
    )
    expect(merged.inquiryTypes).toEqual(['showing_request'])
    expect(merged.channels).toEqual(ON.channels)
    expect(merged.sendWindow.timezone).toBe('America/Los_Angeles')
    expect(merged.sendWindow.start).toBe('08:00')
    expect(merged.minConfidence).toBe(0.5)
    expect(merged.perContactDailyLimit).toBe(10)
  })

  it('reads a stored JSON string', () => {
    expect(normalizeAssistedConfig(JSON.stringify(ON))).toEqual(ON)
    expect(DEFAULT_ASSISTED_CONFIG.minConfidence).toBe(0.85)
  })
})

describe('decideAssistedSend', () => {
  it('sends a confident, safe showing request inside send hours', () => {
    expect(decideAssistedSend(input())).toEqual({ send: true, reasons: [] })
  })

  it.each<[string, Partial<AssistedDecisionInput>, string]>([
    ['SMS switched off', { channel: 'sms', config: { ...ON, channels: { email: true, sms: false } } }, 'channel_off'],
    ['no inquiry type matched', { inquiryTypes: [] }, 'inquiry_type'],
    ['a type the owner reviews', { inquiryTypes: ['showing_request', 'property_details'] }, 'inquiry_type'],
    ['not auto-send safe', { draft: { confidence: 0.99, autoSendSafe: false } }, 'not_safe'],
    ['below the confidence floor', { draft: { confidence: 0.84, autoSendSafe: true } }, 'low_confidence'],
    ['a flag scenario matched', { flagged: true }, 'flagged'],
    ['a review-first audience', { audienceAction: 'pause' }, 'audience_pause'],
    ['content screen findings', { contentReasons: [{ key: 'pricing', label: 'Mentions prices' }] }, 'pricing'],
    ['outside send hours', { now: new Date('2026-09-28T05:00:00.000Z') }, 'quiet_hours'],
    ['the per-contact limit', { recentAutoRepliesToContact: 2 }, 'contact_limit'],
  ])('holds a draft for %s', (_label, overrides, key) => {
    const decision = decideAssistedSend(input(overrides))
    expect(decision.send).toBe(false)
    expect(decision.reasons.map((r) => r.key)).toContain(key)
  })

  it('never lets an audience auto_send bypass the gates', () => {
    expect(decideAssistedSend(input({ audienceAction: 'auto_send', draft: { confidence: 0.2, autoSendSafe: false } })).send).toBe(false)
  })
})

describe('screenAssistedContent', () => {
  it('passes an ordinary showing reply', () => {
    expect(screenAssistedContent({
      inbound: "Hi, we're pre-approved and would love to see 12 Ocean Ave this Saturday.",
      draft: 'Hi Dana,\n\nThanks for reaching out. I will confirm a Saturday showing time with you shortly.\n\nBest,\nCecilia',
      recipientName: 'Dana',
    })).toEqual([])
  })

  it.each([
    ['a price in the reply', 'Is it available?', 'Yes! It is listed at $1,250,000.', 'pricing'],
    ['a discount in the reply', 'Can I book a call?', 'Sure, and I can offer a discount on my fee.', 'pricing'],
    ['a price question', 'How much is the HOA?', 'Let me check the HOA for you.', 'pricing'],
    ['a legal question', 'Do I need an attorney to review the contract terms?', 'Happy to help.', 'legal'],
    ['financial advice in the reply', 'Is it available?', 'Yes, and it is a great investment.', 'financial'],
    ['a loan question', 'What would my mortgage payment be?', 'I can connect you.', 'financial'],
    ['steering in the reply', 'Is it available?', 'Yes, it is in a safe neighborhood, perfect for families.', 'fair_housing'],
    ['a steering question', 'Is it a safe neighborhood?', 'Happy to share details.', 'fair_housing'],
  ])('holds %s', (_label, inbound, draft, key) => {
    expect(screenAssistedContent({ inbound, draft }).map((r) => r.key)).toContain(key)
  })

  it('does not treat a customer statement as an advice question', () => {
    expect(screenAssistedContent({ inbound: "We're pre-approved with our lender.", draft: 'Great, when would you like to visit?' })).toEqual([])
  })
})

describe('send window', () => {
  const window = { start: '08:00', end: '20:00', timezone: 'America/Los_Angeles', days: [1, 2, 3, 4, 5] }
  it('honours the owner timezone and days', () => {
    expect(isWithinSendWindow(window, MONDAY_10AM_LA)).toBe(true)
    expect(isWithinSendWindow(window, new Date('2026-09-29T02:30:00.000Z'))).toBe(true)
    expect(isWithinSendWindow(window, new Date('2026-09-29T03:30:00.000Z'))).toBe(false)
    expect(isWithinSendWindow(window, new Date('2026-09-27T17:00:00.000Z'))).toBe(false)
  })

  it('supports an overnight window and an all-day window', () => {
    const overnight = { start: '20:00', end: '07:00', timezone: 'America/New_York', days: [1] }
    expect(isWithinSendWindow(overnight, new Date('2026-09-29T01:00:00.000Z'))).toBe(true)
    expect(isWithinSendWindow(overnight, new Date('2026-09-29T09:00:00.000Z'))).toBe(true)
    expect(isWithinSendWindow(overnight, new Date('2026-09-29T12:00:00.000Z'))).toBe(false)
    expect(isWithinSendWindow({ ...overnight, start: '00:00', end: '00:00' }, new Date('2026-09-28T16:00:00.000Z'))).toBe(true)
  })
})

describe('inquiry scenarios', () => {
  it('rides on the drafter as prefixed scenarios and splits back out', () => {
    const scenarios = inquiryScenarioInputs()
    expect(scenarios).toHaveLength(ASSISTED_INQUIRY_TYPES.length)
    expect(scenarios[0]!.key).toBe('inquiry_showing_request')
    expect(splitMatchedScenarios(['refund', 'inquiry_showing_request', 'inquiry_bogus'])).toEqual({
      flags: ['refund'],
      inquiryTypes: ['showing_request'],
    })
  })
})

describe('per-contact limit and activity log', () => {
  const scope = { organizationId: 'org-1', tenantId: 'ten-1' }
  const since = new Date('2026-09-27T17:00:00.000Z')

  it('counts sent and scheduled automatic replies to the contact in the window', async () => {
    const at = new Date('2026-09-28T12:00:00.000Z')
    const row = (status: string, meta: Record<string, unknown>, contactId: string, created = at) => ({
      organization_id: 'org-1', tenant_id: 'ten-1', status, created_at: created,
      metadata: JSON.stringify({ feature_source: 'customer_service', ...meta }),
      payload: JSON.stringify({ contactId, to: 'dana@example.com' }),
    })
    const knex = createFakeDb({
      inbox_proposal_actions: [
        row('sent', { auto_sent: true }, 'c-1'),
        row('pending', { auto_scheduled: true }, 'c-1'),
        row('pending', { auto_scheduled: false }, 'c-1'),
        row('sent', { auto_sent: false }, 'c-1'),
        row('sent', { auto_sent: true }, 'c-2'),
        row('sent', { auto_sent: true }, 'c-1', new Date('2026-09-20T12:00:00.000Z')),
      ],
    })
    expect(await countRecentAutoReplies(knex as never, scope, { contactId: 'c-1' }, since)).toBe(2)
    expect(await countRecentAutoReplies(knex as never, scope, { to: 'dana@example.com' }, since)).toBe(3)
    expect(await countRecentAutoReplies(knex as never, scope, {}, since)).toBe(0)
  })

  it('writes one encrypted auto_reply activity on the contact timeline', async () => {
    const knex = createFakeDb({ customer_activities: [] })
    const ok = await logAssistedActivity(knex as never, {
      ...scope, contactId: 'c-1', channel: 'email', inquiryTypes: ['showing_request'], subject: 'Re: 12 Ocean Ave', body: 'Hi Dana',
    })
    expect(ok).toBe(true)
    const [activity] = knex.db.tables.customer_activities
    expect(activity).toMatchObject({ entity_id: 'c-1', activity_type: 'auto_reply', organization_id: 'org-1' })
    expect(String(activity!.subject)).toMatch(/^enc:Routine request answered by email \(Showing and tour requests\)/)
    expect(String(activity!.body)).toMatch(/^enc:/)
  })
})
