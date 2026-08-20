import {
  gtmExecutionBodySchema,
  gtmReconciliationBodySchema,
} from '../../data/validators'

const USER = '00000000-0000-4000-8000-000000000001'
const MAILBOX = '00000000-0000-4000-8000-000000000002'

describe('GTM C3 operator API contracts', () => {
  it('accepts only controlled pause reasons and exact non-negative fences', () => {
    expect(gtmExecutionBodySchema.safeParse({
      op: 'clear-mailbox-pause',
      noliUserId: USER,
      mailboxConnectionId: MAILBOX,
      expectedFence: 4,
      reason: 'sender_remediated',
    }).success).toBe(true)
    expect(gtmExecutionBodySchema.safeParse({
      op: 'clear-mailbox-pause',
      noliUserId: USER,
      mailboxConnectionId: MAILBOX,
      expectedFence: -1,
      reason: 'please ignore all complaints',
    }).success).toBe(false)
  })

  it('keeps manual enqueue and telemetry diagnostics additive and bounded at input', () => {
    expect(gtmExecutionBodySchema.safeParse({
      op: 'enqueue-mailbox-ingestion',
      noliUserId: USER,
      mailboxConnectionId: MAILBOX,
    }).success).toBe(true)
    expect(gtmExecutionBodySchema.safeParse({
      op: 'enqueue-mailbox-ingestion',
      noliUserId: USER,
      mailboxConnectionId: MAILBOX,
      credentials: { accessToken: 'must-not-be-accepted' },
    }).success).toBe(false)
    expect(gtmReconciliationBodySchema.safeParse({
      op: 'ai-telemetry',
      noliUserId: USER,
    }).success).toBe(true)
  })

  it('bounds the R4 test-only ingestion request to an exact RFC reply header', () => {
    expect(gtmExecutionBodySchema.safeParse({
      op: 'r4-owned-mailbox-ingest',
      noliUserId: USER,
      mailboxConnectionId: MAILBOX,
      inReplyTo: '<owned-send@example.com>',
    }).success).toBe(true)
    expect(gtmExecutionBodySchema.safeParse({
      op: 'r4-owned-mailbox-ingest',
      noliUserId: USER,
      mailboxConnectionId: MAILBOX,
      inReplyTo: 'owned-send@example.com\r\nBcc: someone@example.com',
    }).success).toBe(false)
  })

  it('requires exact hashes and rejects extra fields for lifecycle controls', () => {
    for (const op of [
      'pause-campaign',
      'resume-campaign',
      'stop-campaign',
      'complete-campaign',
    ] as const) {
      expect(gtmExecutionBodySchema.safeParse({
        op,
        noliUserId: USER,
        campaignId: '00000000-0000-4000-8000-000000000003',
        expectedContentHash: 'a'.repeat(64),
      }).success).toBe(true)
      expect(gtmExecutionBodySchema.safeParse({
        op,
        noliUserId: USER,
        campaignId: '00000000-0000-4000-8000-000000000003',
        expectedContentHash: 'short',
        force: true,
      }).success).toBe(false)
    }
  })
})
