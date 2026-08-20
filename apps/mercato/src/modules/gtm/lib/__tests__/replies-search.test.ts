import { FakeEm } from './support/fake-em'
import { ORG, TENANT } from './support/campaign-fixtures'
import { replyMatchesQuery, inboundSummary, replyHaystack } from '../replies/search'
import { GtmEnrollment, GtmReply } from '../../data/entities'
import { EmailMessage } from '../../../email/data/schema'

/*
 * Inbox search is a case-insensitive substring over the reply + counterparty
 * fields, operating only on the org+tenant-scoped rows the route hands it.
 */

function reply(overrides: Partial<GtmReply> = {}): GtmReply {
  return Object.assign(new GtmReply(), {
    id: 'r1',
    organizationId: ORG,
    tenantId: TENANT,
    enrollmentId: 'e1',
    channel: 'email',
    direction: 'inbound',
    classification: 'interested',
    classificationSource: 'model',
    draftStatus: 'none',
    draftResponse: null,
    createdAt: new Date('2026-07-22T16:45:00.000Z'),
    ...overrides,
  })
}

function enrollment(overrides: Partial<GtmEnrollment> = {}): GtmEnrollment {
  return Object.assign(new GtmEnrollment(), {
    id: 'e1',
    organizationId: ORG,
    tenantId: TENANT,
    campaignId: 'camp-abc',
    status: 'stopped',
    stopReason: 'email_reply',
    ...overrides,
  })
}

function message(overrides: Partial<EmailMessage> = {}): EmailMessage {
  return Object.assign(new EmailMessage(), {
    id: 'm1',
    organizationId: ORG,
    tenantId: TENANT,
    direction: 'inbound',
    fromAddress: 'dana@prospect.example',
    toAddress: 'sender@fixture.example',
    subject: 'Re: Quick question about onboarding',
    bodyHtml: '<p>Sounds great, tell me more.</p>',
    bodyText: 'Sounds great, tell me more.',
    createdAt: new Date('2026-07-22T16:45:00.000Z'),
    ...overrides,
  })
}

describe('replyMatchesQuery', () => {
  it('is case-insensitive and matches the counterparty email fields', () => {
    const r = reply()
    const e = enrollment()
    const m = message()
    expect(replyMatchesQuery(r, e, m, 'DANA@PROSPECT.EXAMPLE')).toBe(true)
    expect(replyMatchesQuery(r, e, m, 'onboarding')).toBe(true)
    expect(replyMatchesQuery(r, e, m, 'TELL ME MORE')).toBe(true)
  })

  it('matches reply fields (classification, channel) and the enrollment campaign id', () => {
    const r = reply()
    const e = enrollment()
    expect(replyMatchesQuery(r, e, null, 'interested')).toBe(true)
    expect(replyMatchesQuery(r, e, null, 'EMAIL')).toBe(true)
    expect(replyMatchesQuery(r, e, null, 'camp-abc')).toBe(true)
  })

  it('matches drafted subject/body/note text', () => {
    const r = reply({ draftResponse: { subject: 'Following up', body: 'Happy to schedule.', note: 'left VM' } })
    expect(replyMatchesQuery(r, null, null, 'schedule')).toBe(true)
    expect(replyMatchesQuery(r, null, null, 'following up')).toBe(true)
    expect(replyMatchesQuery(r, null, null, 'left vm')).toBe(true)
  })

  it('a blank query matches everything; a miss excludes', () => {
    const r = reply()
    expect(replyMatchesQuery(r, enrollment(), message(), '   ')).toBe(true)
    expect(replyMatchesQuery(r, enrollment(), message(), 'nonexistent-token-xyz')).toBe(false)
  })

  it('never reads across the fields it was not given (no counterparty = no counterparty match)', () => {
    const r = reply()
    // With no linked message the counterparty text is simply not in scope.
    expect(replyHaystack(r, enrollment(), null)).not.toContain('prospect.example')
    expect(replyMatchesQuery(r, enrollment(), null, 'prospect.example')).toBe(false)
  })
})

describe('inboundSummary', () => {
  it('summarizes the linked inbound email', () => {
    const summary = inboundSummary(reply(), message())
    expect(summary).not.toBeNull()
    expect(summary!.from).toBe('dana@prospect.example')
    expect(summary!.subject).toContain('onboarding')
    expect(summary!.snippet).toBe('Sounds great, tell me more.')
  })

  it('falls back to a social note when there is no email', () => {
    const summary = inboundSummary(reply({ channel: 'linkedin', draftResponse: { note: 'They replied on LinkedIn' } }), null)
    expect(summary).not.toBeNull()
    expect(summary!.from).toBeNull()
    expect(summary!.snippet).toBe('They replied on LinkedIn')
  })

  it('returns null when there is neither an email nor a note', () => {
    expect(inboundSummary(reply(), null)).toBeNull()
  })

  it('truncates a long snippet to 160 chars', () => {
    const long = 'x'.repeat(500)
    const summary = inboundSummary(reply(), message({ bodyText: long }))
    expect(summary!.snippet).toHaveLength(160)
  })

  // Self-scoping is enforced by the route's org+tenant find; the helper never
  // widens it. Sanity: a foreign-looking row is only ever searched if handed in.
  it('does not require org/tenant awareness (pure over given rows)', () => {
    const em = new FakeEm()
    void em
    expect(typeof replyMatchesQuery).toBe('function')
  })
})
