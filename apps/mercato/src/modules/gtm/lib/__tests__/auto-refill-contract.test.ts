import {
  AUTO_REFILL_MAX_CREDITS_CEILING,
  AUTO_REFILL_MAX_RAW_CANDIDATES_CEILING,
  AUTO_REFILL_TARGET_ACCEPTED_CEILING,
  normalizeAutoRefillSettings,
} from '../campaign/build'
import {
  autoRefillScheduleCron,
  buildAutoRefillPolicyHash,
  localDateInTimeZone,
} from '../auto-refill/contract'
import { gtmAutoRefillBodySchema, gtmCampaignsBodySchema } from '../../data/validators'

const HASH = 'a'.repeat(64)

describe('R38 auto-refill contract', () => {
  it('defaults dark with a bounded review-queue policy', () => {
    expect(normalizeAutoRefillSettings()).toEqual({
      enabled: false,
      target_accepted_per_day: 5,
      max_raw_candidates_per_day: 25,
      max_credits_per_day: 250_000,
      run_hour_local: 7,
      plan_hash: null,
    })
  })

  it('requires an exact plan hash and refuses unsafe ceilings', () => {
    expect(() => normalizeAutoRefillSettings({ enabled: true })).toThrow(/plan hash/i)
    expect(() => normalizeAutoRefillSettings({
      enabled: true,
      plan_hash: HASH,
      target_accepted_per_day: 6,
      max_raw_candidates_per_day: 5,
    })).toThrow(/target cannot exceed/i)
    expect(() => normalizeAutoRefillSettings({
      enabled: true,
      plan_hash: HASH,
      target_accepted_per_day: AUTO_REFILL_TARGET_ACCEPTED_CEILING + 1,
    })).toThrow()
    expect(() => normalizeAutoRefillSettings({
      enabled: true,
      plan_hash: HASH,
      max_raw_candidates_per_day: AUTO_REFILL_MAX_RAW_CANDIDATES_CEILING + 1,
    })).toThrow()
    expect(() => normalizeAutoRefillSettings({
      enabled: true,
      plan_hash: HASH,
      max_credits_per_day: AUTO_REFILL_MAX_CREDITS_CEILING + 1,
    })).toThrow()
  })

  it('drops a stale plan hash when disabled', () => {
    expect(normalizeAutoRefillSettings({ enabled: false, plan_hash: HASH }).plan_hash).toBeNull()
  })

  it('freezes deterministic policy identity, weekday cron, and timezone date', () => {
    const material = {
      policyId: '00000000-0000-4000-8000-000000000001',
      organizationId: '00000000-0000-4000-8000-000000000002',
      tenantId: '00000000-0000-4000-8000-000000000003',
      workspaceId: '00000000-0000-4000-8000-000000000004',
      playId: '00000000-0000-4000-8000-000000000005',
      campaignId: '00000000-0000-4000-8000-000000000006',
      campaignVersionId: '00000000-0000-4000-8000-000000000007',
      representedNoliUserId: '00000000-0000-4000-8000-000000000008',
      noliOrganizationId: '00000000-0000-4000-8000-000000000009',
      requestedByUserId: '00000000-0000-4000-8000-000000000010',
      campaignContentHash: 'b'.repeat(64),
      planHash: HASH,
      targetAcceptedPerDay: 5,
      maxRawCandidatesPerDay: 25,
      maxCreditsPerDay: 250_000,
      runHourLocal: 7,
      timezone: 'America/Los_Angeles',
    }
    expect(buildAutoRefillPolicyHash(material)).toMatch(/^[a-f0-9]{64}$/)
    expect(buildAutoRefillPolicyHash(material)).toBe(buildAutoRefillPolicyHash({ ...material }))
    expect(buildAutoRefillPolicyHash({ ...material, maxCreditsPerDay: 250_001 }))
      .not.toBe(buildAutoRefillPolicyHash(material))
    expect(autoRefillScheduleCron(7)).toBe('0 7 * * 1-5')
    expect(localDateInTimeZone(
      new Date('2026-08-25T01:30:00.000Z'),
      'America/Los_Angeles',
    )).toBe('2026-08-24')
  })

  it('validates plan/control bodies and additive campaign settings', () => {
    expect(gtmAutoRefillBodySchema.safeParse({
      op: 'plan',
      noliUserId: '00000000-0000-4000-8000-000000000001',
      campaignId: '00000000-0000-4000-8000-000000000002',
      limits: { targetAccepted: 5, maxRawCandidates: 25, maxCredits: 250_000 },
      run_hour_local: 7,
    }).success).toBe(true)
    expect(gtmAutoRefillBodySchema.safeParse({
      op: 'activate',
      noliUserId: '00000000-0000-4000-8000-000000000001',
      campaignId: '00000000-0000-4000-8000-000000000002',
      expected_content_hash: HASH,
      expected_plan_hash: HASH,
    }).success).toBe(true)
    expect(gtmCampaignsBodySchema.safeParse({
      op: 'update-settings',
      noliUserId: '00000000-0000-4000-8000-000000000001',
      campaignId: '00000000-0000-4000-8000-000000000002',
      expected_content_hash: HASH,
      settings: {
        daily_cap: 25,
        send_window: { start_hour: 9, end_hour: 17, timezone: 'America/New_York' },
        jitter_minutes: 10,
        mailbox_connection_id: null,
        duplicate_override: false,
        auto_refill: {
          enabled: true,
          target_accepted_per_day: 5,
          max_raw_candidates_per_day: 25,
          max_credits_per_day: 250_000,
          run_hour_local: 7,
          plan_hash: HASH,
        },
      },
    }).success).toBe(true)
  })
})
