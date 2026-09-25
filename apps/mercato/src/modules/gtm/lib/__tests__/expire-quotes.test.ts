import { FakeEm } from './support/fake-em'
import {
  QUOTE_EXPIRY_DAYS,
  effectiveRunStatus,
  expireStaleQuotedRuns,
  isQuoteExpired,
  quoteExpiresAt,
} from '../research/expire-quotes'
import { sweepExpiredCandidates } from '../retention/sweep'
import { FixtureLedger } from '../credits/ledger'
import { GtmAuditEvent, GtmProviderOperation, GtmResearchRun } from '../../data/entities'

/*
 * Quoted research runs nobody started expire after QUOTE_EXPIRY_DAYS
 * (lib/research/expire-quotes.ts), through the daily retention sweep.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111'
const ORG_B = '66666666-6666-4666-8666-666666666666'
const TENANT = '22222222-2222-4222-8222-222222222222'
const WORKSPACE = '33333333-3333-4333-8333-333333333333'
const PLAY = '55555555-5555-4555-8555-555555555555'

const NOW = new Date('2026-09-25T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000
const ago = (days: number) => new Date(NOW.getTime() - days * DAY)

async function seedRun(
  em: FakeEm,
  options: { status?: string; createdAt: Date; org?: string; deletedAt?: Date | null },
): Promise<GtmResearchRun> {
  const run = em.create(GtmResearchRun, {
    organizationId: options.org ?? ORG_A,
    tenantId: TENANT,
    workspaceId: WORKSPACE,
    playId: PLAY,
    status: options.status ?? 'priced',
    providerPlan: { planHash: 'hash-1', adapterPlan: [] },
    estimatedCredits: '120',
    createdAt: options.createdAt,
    deletedAt: options.deletedAt ?? null,
  })
  em.persist(run)
  await em.flush()
  return run
}

function row(em: FakeEm, id: string): GtmResearchRun {
  return em.table(GtmResearchRun).find((run) => run.id === id)!
}

describe('quote expiry helpers', () => {
  it('uses a 3-day window from the quote and only applies to priced runs', () => {
    expect(QUOTE_EXPIRY_DAYS).toBe(3)
    const quoted = { status: 'priced', createdAt: ago(3) }
    expect(quoteExpiresAt(quoted)?.toISOString()).toBe(NOW.toISOString())
    expect(isQuoteExpired(quoted, NOW)).toBe(true)
    expect(effectiveRunStatus(quoted, NOW)).toBe('expired')

    const fresh = { status: 'priced', createdAt: ago(2.9) }
    expect(isQuoteExpired(fresh, NOW)).toBe(false)
    expect(effectiveRunStatus(fresh, NOW)).toBe('priced')

    for (const status of ['running', 'completed', 'failed', 'cancelled', 'expired']) {
      const old = { status, createdAt: ago(30) }
      expect(quoteExpiresAt(old)).toBeNull()
      expect(effectiveRunStatus(old, NOW)).toBe(status)
    }
  })
})

describe('expireStaleQuotedRuns', () => {
  it('expires only priced runs older than the window, with one audit row each', async () => {
    const em = new FakeEm()
    const stale = await seedRun(em, { createdAt: ago(4) })
    const fresh = await seedRun(em, { createdAt: ago(1) })
    const oldCompleted = await seedRun(em, { status: 'completed', createdAt: ago(10) })
    const oldRunning = await seedRun(em, { status: 'running', createdAt: ago(10) })
    const deleted = await seedRun(em, { createdAt: ago(10), deletedAt: ago(5) })

    const result = await expireStaleQuotedRuns(em, { now: NOW })

    expect(result.expiredRunIds).toEqual([stale.id])
    expect(result.skippedReservedRunIds).toEqual([])
    expect(row(em, stale.id).status).toBe('expired')
    expect(row(em, stale.id).completedAt?.toISOString()).toBe(NOW.toISOString())
    const execution = (row(em, stale.id).providerPlan as Record<string, unknown>).execution as Record<string, unknown>
    expect(execution.status).toBe('expired')
    expect(execution.expired_at).toBe(NOW.toISOString())
    // the frozen quote itself is kept for the record
    expect((row(em, stale.id).providerPlan as Record<string, unknown>).planHash).toBe('hash-1')

    expect(row(em, fresh.id).status).toBe('priced')
    expect(row(em, oldCompleted.id).status).toBe('completed')
    expect(row(em, oldRunning.id).status).toBe('running')
    expect(row(em, deleted.id).status).toBe('priced')

    const audits = em.table(GtmAuditEvent)
    expect(audits).toHaveLength(1)
    expect(audits[0].action).toBe('gtm.research_run.quote_expired')
    expect(audits[0].objectId).toBe(stale.id)
    expect(audits[0].actor).toBe('system')

    // idempotent
    const again = await expireStaleQuotedRuns(em, { now: NOW })
    expect(again.expiredRunIds).toEqual([])
    expect(em.table(GtmAuditEvent)).toHaveLength(1)
  })

  it('scopes to one organization when asked', async () => {
    const em = new FakeEm()
    const a = await seedRun(em, { createdAt: ago(5), org: ORG_A })
    const b = await seedRun(em, { createdAt: ago(5), org: ORG_B })
    const result = await expireStaleQuotedRuns(em, { now: NOW, orgId: ORG_A })
    expect(result.expiredRunIds).toEqual([a.id])
    expect(row(em, b.id).status).toBe('priced')
  })

  it('never overwrites a run a concurrent execute already claimed', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, { createdAt: ago(5) })
    // execute claims priced -> running between the sweep's read and its write
    const originalFind = em.find.bind(em)
    em.find = (async (...args: Parameters<FakeEm['find']>) => {
      const rows = await originalFind(...args)
      if (args[0] === GtmResearchRun) {
        await em.nativeUpdate(GtmResearchRun, { id: run.id, status: 'priced' }, { status: 'running' })
      }
      return rows
    }) as FakeEm['find']
    const result = await expireStaleQuotedRuns(em, { now: NOW })
    expect(result.expiredRunIds).toEqual([])
    expect(row(em, run.id).status).toBe('running')
    expect(em.table(GtmAuditEvent)).toHaveLength(0)
  })

  it('releases a reservation an expiring quote still holds, and skips it when no ledger is available', async () => {
    const em = new FakeEm()
    const run = await seedRun(em, { createdAt: ago(5) })
    const ledger = new FixtureLedger({ poolBalance: 1000 })
    const reserved = await ledger.reserve({
      orgId: 'noli-org-1',
      userId: 'noli-user-1',
      kind: 'source_search',
      provider: 'fixture',
      estimatedCredits: 50,
      idempotencyKey: `run:${run.id}:batch:0`,
      unitCostSnapshot: {},
      fingerprint: { research_run_id: run.id },
    })
    em.persist(
      em.create(GtmProviderOperation, {
        organizationId: ORG_A,
        tenantId: TENANT,
        noliCoreOperationId: reserved.operationId,
        researchRunId: run.id,
        kind: 'source_search',
        provider: 'fixture',
        localStatusMirror: 'reserved',
      }),
    )
    await em.flush()

    const withoutLedger = await expireStaleQuotedRuns(em, { now: NOW })
    expect(withoutLedger.expiredRunIds).toEqual([])
    expect(withoutLedger.skippedReservedRunIds).toEqual([run.id])
    expect(row(em, run.id).status).toBe('priced')

    const withLedger = await expireStaleQuotedRuns(em, { now: NOW, ledger })
    expect(withLedger.expiredRunIds).toEqual([run.id])
    expect(withLedger.releasedOperationIds).toHaveLength(1)
    expect(ledger.getOperation(reserved.operationId)?.status).toBe('released')
    expect(em.table(GtmProviderOperation)[0].localStatusMirror).toBe('released')
    expect(row(em, run.id).status).toBe('expired')
  })
})

describe('retention sweep expires stale quotes', () => {
  it('counts expired quotes even when no candidate has expired', async () => {
    const em = new FakeEm()
    const stale = await seedRun(em, { createdAt: ago(7) })
    const result = await sweepExpiredCandidates(em, { now: NOW })
    expect(result.quotesExpired).toBe(1)
    expect(result.quoteReservationsReleased).toBe(0)
    expect(result.candidatesDeleted).toBe(0)
    expect(row(em, stale.id).status).toBe('expired')
  })
})
