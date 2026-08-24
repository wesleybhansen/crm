import { shapeCampaignDraft } from '../../api/internal/campaigns/route'
import { gtmCampaignsBodySchema } from '../../data/validators'
import type { CampaignDraftState } from '../campaign/approve'

describe('campaign draft response shape', () => {
  it('keeps every recipient-by-step review field needed to approve the exact sequence', () => {
    const shaped = shapeCampaignDraft({
      contentHash: 'draft-hash',
      eligibility: { execution_eligibility: 'executable', eligibility_reason: 'ok' },
      template: { subject: 'Subject', body: 'Body' },
      steps: [
        { key: 'email_1', order: 1, channel: 'email', mode: 'automated', delay_days: 0 },
        { key: 'email_2', order: 2, channel: 'email', mode: 'automated', delay_days: 3 },
      ],
      settings: {
        daily_cap: 10,
        send_window: { start_hour: 9, end_hour: 17, timezone: 'America/Los_Angeles' },
        jitter_minutes: 0,
        mailbox_connection_id: 'mailbox-1',
        duplicate_override: false,
      },
      sender: null,
      postalAddress: '100 Test Way',
      recipients: [
        {
          candidateId: 'candidate-1',
          address: 'owned@example.com',
          addressHash: 'address-hash',
          contactId: 'contact-1',
          contactPointId: 'point-1',
        },
      ],
      rendered: [
        {
          candidateId: 'candidate-1',
          stepKey: 'email_1',
          stepOrder: 1,
          subject: 'First subject',
          bodyHtml: '<p>First body</p>',
          bodyText: 'First body',
          bodyTextCore: 'First body',
          contentHash: 'message-hash-1',
          needsReview: false,
          missingFields: [],
          wordCount: 42,
          qualityIssues: [],
          provenance: 'template',
        },
        {
          candidateId: 'candidate-1',
          stepKey: 'email_2',
          stepOrder: 2,
          subject: 'Second subject',
          bodyHtml: '<p>Second body</p>',
          bodyText: 'Second body',
          bodyTextCore: 'Second body',
          contentHash: 'message-hash-2',
          needsReview: true,
          missingFields: ['signal'],
          wordCount: 17,
          qualityIssues: ['body_too_short'],
          provenance: 'manual',
        },
      ],
      exclusions: { entries: [], summary: { total: 1, excluded: 0, byReason: {} } },
      projectedCredits: { projected_credits: 2, breakdown: [] },
    } as unknown as CampaignDraftState)

    expect(shaped.rendered).toEqual([
      expect.objectContaining({
        candidate_id: 'candidate-1',
        step_key: 'email_1',
        step_order: 1,
        content_hash: 'message-hash-1',
        body_text_core: 'First body',
        word_count: 42,
        quality_issues: [],
      }),
      expect.objectContaining({
        candidate_id: 'candidate-1',
        step_key: 'email_2',
        step_order: 2,
        content_hash: 'message-hash-2',
        body_text_core: 'Second body',
        word_count: 17,
        quality_issues: ['body_too_short'],
        provenance: 'manual',
      }),
    ])
  })

  it('accepts only an exact double-hash-bound manual message write shape', () => {
    const valid = {
      op: 'update-message',
      noliUserId: 'user-1',
      campaignId: 'campaign-1',
      candidateId: 'candidate-1',
      step_key: 'email_2',
      expected_content_hash: 'a'.repeat(64),
      expected_message_hash: 'b'.repeat(64),
      subject: 'A bounded subject',
      body_text: 'A bounded body with enough space for deterministic server validation.',
    }
    expect(gtmCampaignsBodySchema.safeParse(valid).success).toBe(true)
    expect(gtmCampaignsBodySchema.safeParse({ ...valid, expected_message_hash: 'short' }).success).toBe(false)
    expect(gtmCampaignsBodySchema.safeParse({ ...valid, expected_content_hash: 'z'.repeat(64) }).success).toBe(false)
    expect(gtmCampaignsBodySchema.safeParse({ ...valid, body_text: '' }).success).toBe(false)
  })
})
