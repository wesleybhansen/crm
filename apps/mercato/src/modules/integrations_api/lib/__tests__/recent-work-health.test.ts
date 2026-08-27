import { readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyRecentWorkIdentity, summarizeRecentWorkPartitions } from '../recent-work-health'

const fulfilled = (value: unknown): PromiseFulfilledResult<unknown> => ({
  status: 'fulfilled',
  value,
})
const rejected = (): PromiseRejectedResult => ({
  status: 'rejected',
  reason: new Error('source unavailable'),
})

describe('summarizeRecentWorkPartitions', () => {
  it('reports a healthy set of partitions', () => {
    expect(summarizeRecentWorkPartitions(['emails', 'bookings'], [fulfilled([]), fulfilled([])])).toEqual({
      failedPartitions: [],
      totalFailure: false,
    })
  })

  it('identifies a partial failure without discarding healthy partitions', () => {
    expect(summarizeRecentWorkPartitions(['emails', 'bookings'], [fulfilled([]), rejected()])).toEqual({
      failedPartitions: ['bookings'],
      totalFailure: false,
    })
  })

  it('identifies a total partition failure', () => {
    expect(summarizeRecentWorkPartitions(['emails', 'bookings'], [rejected(), rejected()])).toEqual({
      failedPartitions: ['emails', 'bookings'],
      totalFailure: true,
    })
  })

  it('fails closed when partition metadata and results diverge', () => {
    expect(() => summarizeRecentWorkPartitions(['emails'], [fulfilled([]), fulfilled([])])).toThrow(
      'Recent-work partition metadata mismatch',
    )
  })
})

describe('classifyRecentWorkIdentity', () => {
  it('treats a confirmed absent Noli or CRM identity as empty', () => {
    expect(classifyRecentWorkIdentity({ hasNoliIdentity: false, entitled: false, organizationId: null })).toEqual({
      state: 'empty',
    })
    expect(classifyRecentWorkIdentity({ hasNoliIdentity: true, entitled: true, organizationId: null })).toEqual({
      state: 'empty',
    })
  })

  it('denies a confirmed inactive entitlement', () => {
    expect(classifyRecentWorkIdentity({ hasNoliIdentity: true, entitled: false, organizationId: 'org-1' })).toEqual({
      state: 'forbidden',
    })
  })

  it('returns the confirmed local organization without provisioning', () => {
    expect(classifyRecentWorkIdentity({ hasNoliIdentity: true, entitled: true, organizationId: 'org-1' })).toEqual({
      state: 'ready',
      organizationId: 'org-1',
    })
  })
})

describe('consumer GTM recent-work boundary', () => {
  const routeSource = readFileSync(
    path.resolve(process.cwd(), 'src/modules/integrations_api/api/internal/recent-work/route.ts'),
    'utf8',
  )

  it('resolves tenant identity and scopes both consumer queue partitions by org and tenant', () => {
    expect(routeSource).toContain('resolveClerkUserToAuthContext')
    expect(routeSource).toContain("gtmAuth.orgId !== orgId")
    expect(routeSource).toContain(".where('candidate_match.organization_id', orgId)")
    expect(routeSource).toContain(".where('candidate_match.tenant_id', gtmTenantId)")
    expect(routeSource).toContain(".where('manual_draft.organization_id', orgId)")
    expect(routeSource).toContain(".where('manual_draft.tenant_id', gtmTenantId)")
  })

  it('queues only accepted manual-only consumer leads and reviewable local drafts', () => {
    expect(routeSource).toContain(".where('candidate_match.fit_status', 'accepted')")
    expect(routeSource).toContain(".where('play.lead_mode', 'consumer')")
    expect(routeSource).toContain(".where('play.outreach_mode', 'manual_only')")
    expect(routeSource).toContain(".where('manual_draft.status', 'draft')")
    expect(routeSource).toContain("detail: 'Copy it and open the public profile. Noli will not send it.'")
    expect(routeSource).not.toContain('gtm-send-consumer')
  })
})
