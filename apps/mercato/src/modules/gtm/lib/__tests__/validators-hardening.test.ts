import {
  gtmHandoffBodySchema,
  gtmInboxBodySchema,
  gtmPrivacyBodySchema,
  importedPlaySchema,
} from '../../data/validators'

/*
 * Validator hardening from the adversarial review: strict market_type enum
 * (research H13, requested by the research-pipeline owner), https-only asset
 * URLs (M10), strict play_context for AMS asset requests (L6), the mandatory
 * draft-hash echo on approve-draft (M6), and the new privacy operator ops.
 */
describe('GTM validator hardening', () => {
  it('accepts only b2b | b2c | mixed (or null) as market_type', () => {
    expect(importedPlaySchema.safeParse({ market_type: 'b2b' }).success).toBe(true)
    expect(importedPlaySchema.safeParse({ market_type: 'mixed' }).success).toBe(true)
    expect(importedPlaySchema.safeParse({ market_type: null }).success).toBe(true)
    expect(importedPlaySchema.safeParse({}).success).toBe(true)
    for (const bad of ['B2B', 'consumer', 'business', 'b2b ', '']) {
      expect(importedPlaySchema.safeParse({ market_type: bad }).success).toBe(false)
    }
  })

  it('freezes only absolute https asset URLs into attach-asset', () => {
    const base = {
      op: 'attach-asset',
      noliUserId: 'u',
      campaignId: 'c',
      assetRef: { id: 'asset-1', kind: 'landing_page', title: 'Synthetic page' },
    }
    const ok = gtmHandoffBodySchema.safeParse({
      ...base,
      assetRef: { ...base.assetRef, publishedUrl: 'https://ams.example/p/1', frozen_url: 'https://ams.example/p/1' },
    })
    expect(ok.success).toBe(true)
    for (const bad of [
      'javascript:alert(1)',
      'http://ams.example/p/1',
      'data:text/html,hi',
      '/relative/path',
      'ams.example/p/1',
    ]) {
      expect(
        gtmHandoffBodySchema.safeParse({ ...base, assetRef: { ...base.assetRef, publishedUrl: bad } }).success,
      ).toBe(false)
      expect(
        gtmHandoffBodySchema.safeParse({
          ...base,
          assetRef: { ...base.assetRef, publishedUrl: 'https://ams.example/p/1', frozen_url: bad },
        }).success,
      ).toBe(false)
    }
  })

  it('rejects unknown play_context keys on asset-request (never prospect PII)', () => {
    const base = { op: 'asset-request', noliUserId: 'u', kind: 'landing_page', brief: 'Synthetic brief' }
    expect(
      gtmHandoffBodySchema.safeParse({
        ...base,
        play_context: { audience: 'Synthetic firms', geography: 'California', market_type: 'b2b' },
      }).success,
    ).toBe(true)
    expect(
      gtmHandoffBodySchema.safeParse({
        ...base,
        play_context: { audience: 'Synthetic firms', prospect_email: 'someone@fixture.example' },
      }).success,
    ).toBe(false)
    expect(
      gtmHandoffBodySchema.safeParse({
        ...base,
        play_context: { recipients: [{ name: 'Jane', email: 'j@fixture.example' }] },
      }).success,
    ).toBe(false)
  })

  it('requires a 64-hex expected_draft_hash on approve-draft', () => {
    expect(
      gtmInboxBodySchema.safeParse({ op: 'approve-draft', noliUserId: 'u', replyId: 'r' }).success,
    ).toBe(false)
    expect(
      gtmInboxBodySchema.safeParse({
        op: 'approve-draft',
        noliUserId: 'u',
        replyId: 'r',
        expected_draft_hash: 'not-a-hash',
      }).success,
    ).toBe(false)
    expect(
      gtmInboxBodySchema.safeParse({
        op: 'approve-draft',
        noliUserId: 'u',
        replyId: 'r',
        expected_draft_hash: 'a'.repeat(64),
      }).success,
    ).toBe(true)
  })

  it('accepts the privacy operator ops with their required fields only', () => {
    expect(gtmPrivacyBodySchema.safeParse({ op: 'list-partial', noliUserId: 'u' }).success).toBe(true)
    expect(
      gtmPrivacyBodySchema.safeParse({ op: 'complete-crm-contact-deletion', noliUserId: 'u', requestId: 'r' }).success,
    ).toBe(true)
    expect(gtmPrivacyBodySchema.safeParse({ op: 'set-legal-hold', noliUserId: 'u', requestId: 'r' }).success).toBe(false)
    expect(
      gtmPrivacyBodySchema.safeParse({ op: 'set-legal-hold', noliUserId: 'u', requestId: 'r', reason: 'hold' }).success,
    ).toBe(true)
    expect(
      gtmPrivacyBodySchema.safeParse({ op: 'clear-legal-hold', noliUserId: 'u', requestId: 'r', reason: 'done' }).success,
    ).toBe(true)
  })
})
