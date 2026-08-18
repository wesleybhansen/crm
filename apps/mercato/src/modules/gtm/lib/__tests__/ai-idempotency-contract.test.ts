import {
  gtmCampaignsBodySchema,
  gtmInboxBodySchema,
  gtmStrategyBodySchema,
} from '../../data/validators'

describe('GTM metered AI idempotency contract', () => {
  const cases = [
    {
      schema: gtmCampaignsBodySchema,
      body: {
        op: 'regenerate-message',
        noliUserId: 'user-1',
        campaignId: 'campaign-1',
        candidateId: 'candidate-1',
      },
    },
    {
      schema: gtmInboxBodySchema,
      body: {
        op: 'draft-response-ai',
        noliUserId: 'user-1',
        replyId: 'reply-1',
      },
    },
    {
      schema: gtmStrategyBodySchema,
      body: {
        op: 'voice-derive',
        noliUserId: 'user-1',
        workspaceId: 'workspace-1',
        sources: { samples: ['A representative writing sample.'] },
      },
    },
  ] as const

  it.each(cases)('$body.op rejects a direct internal request without an idempotency key', ({ schema, body }) => {
    expect(schema.safeParse(body).success).toBe(false)
  })

  it.each(cases)('$body.op accepts an exact bounded idempotency key', ({ schema, body }) => {
    expect(schema.safeParse({ ...body, idempotency_key: 'request-1' }).success).toBe(true)
  })
})
