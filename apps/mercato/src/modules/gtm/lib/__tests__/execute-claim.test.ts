import { FakeEm } from './support/fake-em'
import { ctx } from './support/campaign-fixtures'
import { LAUNCH_ISO, fixedClock, seedLaunchedCampaign } from './support/execution-fixtures'
import { claimDueAttempts, recoverStuckAttempts } from '../execute/claim'
import { GtmSendAttempt } from '../../data/entities'

// Half an hour after launch: only the day-0 step is due.
const TICK_ISO = '2026-07-22T16:30:00.000Z'

describe('claimDueAttempts (SPEC-066 section 6 rules 1 and 5)', () => {
  async function launched(em: FakeEm) {
    const clock = fixedClock(LAUNCH_ISO)
    const fixture = await seedLaunchedCampaign(em, { clock, recipients: 1, emails: 2 })
    return fixture
  }

  it('claims due approved rows: state claimed, token minted, lease set, fence bumped', async () => {
    const em = new FakeEm()
    await launched(em)
    const clock = fixedClock(TICK_ISO)
    const result = await claimDueAttempts(em, ctx, { clock })
    // Only the day-0 attempt is due; the day-3 one is scheduled for Monday.
    expect(result.claimed).toHaveLength(1)
    const { attempt, claimToken } = result.claimed[0]
    expect(attempt.state).toBe('claimed')
    expect(attempt.claimToken).toBe(claimToken)
    expect(attempt.fence).toBe(1)
    expect(attempt.claimExpiresAt!.toISOString()).toBe(
      new Date(new Date(TICK_ISO).getTime() + 10 * 60 * 1000).toISOString(),
    )
  })

  it('does not claim attempts scheduled in the future', async () => {
    const em = new FakeEm()
    await launched(em)
    const early = fixedClock('2026-07-22T15:00:00.000Z') // before launch-time schedule
    const result = await claimDueAttempts(em, ctx, { clock: early })
    expect(result.claimed).toHaveLength(0)
  })

  it('two concurrent claimers: exactly one wins the CAS', async () => {
    const em = new FakeEm()
    await launched(em)
    const clock = fixedClock(TICK_ISO)

    // Both claimers observed the same pre-claim row (state approved,
    // fence 0). The first conditional UPDATE wins; the second, carrying the
    // stale observation, matches zero rows.
    const first = await claimDueAttempts(em, ctx, { clock })
    expect(first.claimed).toHaveLength(1)
    const row = first.claimed[0].attempt

    const second = await claimDueAttempts(em, ctx, { clock })
    expect(second.claimed).toHaveLength(0)

    // The stale claimer's raw CAS with the observed-before state also loses.
    const stale = await em.nativeUpdate(
      GtmSendAttempt,
      { id: row.id, state: 'approved', fence: 0 },
      { state: 'claimed', claimToken: 'stale-token', fence: 1 },
    )
    expect(stale).toBe(0)
    expect(row.claimToken).not.toBe('stale-token')
  })

  it('a lease-expired claimed row is reclaimable and the fence bumps', async () => {
    const em = new FakeEm()
    await launched(em)
    const clock = fixedClock(TICK_ISO)
    const first = await claimDueAttempts(em, ctx, { clock })
    const firstToken = first.claimed[0].claimToken

    // Within the lease nothing is reclaimable.
    clock.set('2026-07-22T16:35:00.000Z')
    expect((await claimDueAttempts(em, ctx, { clock })).claimed).toHaveLength(0)

    // After the 10-minute lease lapses the row is claimed again: new token,
    // fence bumped, so the first claimant is fenced out of every write.
    clock.set('2026-07-22T16:41:00.000Z')
    const second = await claimDueAttempts(em, ctx, { clock })
    expect(second.claimed).toHaveLength(1)
    expect(second.claimed[0].attempt.fence).toBe(2)
    expect(second.claimed[0].claimToken).not.toBe(firstToken)
  })

  it('a lease-expired provider_started row is NOT reclaimable; recover-stuck parks it ambiguous', async () => {
    const em = new FakeEm()
    await launched(em)
    const clock = fixedClock(TICK_ISO)
    const first = await claimDueAttempts(em, ctx, { clock })
    const row = first.claimed[0].attempt

    // Simulate the executor crashing right after the durable
    // provider_started transition (the provider may hold the message).
    await em.nativeUpdate(
      GtmSendAttempt,
      { id: row.id, claimToken: first.claimed[0].claimToken, fence: row.fence },
      { state: 'provider_started', rfcMessageId: '<crashed@fixture.example>' },
    )

    clock.set('2026-07-22T17:00:00.000Z') // lease long expired
    const reclaim = await claimDueAttempts(em, ctx, { clock })
    expect(reclaim.claimed).toHaveLength(0)

    const recovered = await recoverStuckAttempts(em, ctx, { clock })
    expect(recovered.ambiguous).toBe(1)
    expect(row.state).toBe('ambiguous')
    expect(row.ambiguousAt).toBeInstanceOf(Date)
    expect(row.failureReason).toBe('lease_expired_after_provider_start')
    // The rfc message id survives for reconciliation and reply correlation.
    expect(row.rfcMessageId).toBe('<crashed@fixture.example>')
  })

  it('recover-stuck leaves live provider_started rows alone', async () => {
    const em = new FakeEm()
    await launched(em)
    const clock = fixedClock(TICK_ISO)
    const first = await claimDueAttempts(em, ctx, { clock })
    const row = first.claimed[0].attempt
    await em.nativeUpdate(
      GtmSendAttempt,
      { id: row.id },
      { state: 'provider_started' },
    )
    // Lease still live: not stuck yet.
    const recovered = await recoverStuckAttempts(em, ctx, { clock })
    expect(recovered.ambiguous).toBe(0)
    expect(row.state).toBe('provider_started')
  })

  it('ambiguous rows are never picked up again by the claimer (no auto-retry)', async () => {
    const em = new FakeEm()
    await launched(em)
    const clock = fixedClock(TICK_ISO)
    const first = await claimDueAttempts(em, ctx, { clock })
    const row = first.claimed[0].attempt
    await em.nativeUpdate(GtmSendAttempt, { id: row.id }, { state: 'provider_started' })
    clock.set('2026-07-22T17:00:00.000Z')
    await recoverStuckAttempts(em, ctx, { clock })
    expect(row.state).toBe('ambiguous')

    clock.set('2026-07-23T16:00:00.000Z')
    const later = await claimDueAttempts(em, ctx, { clock })
    expect(later.claimed.map((c) => c.attempt.id)).not.toContain(row.id)
    expect(row.state).toBe('ambiguous')
  })
})
