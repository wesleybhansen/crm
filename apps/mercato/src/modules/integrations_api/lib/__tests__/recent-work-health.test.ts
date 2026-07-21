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
